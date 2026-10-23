// #27: the queue's lock records its holder, is taken over only from a dead one, and is removed only by its maker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as queue from '../bin/lib/queue.mjs';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');
const startOf = (pid) => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
const holder = (over = {}) => ({ pid: process.pid, start: startOf(process.pid), host: hostname(), token: 'other', ...over });

/** A state folder, and a fake gh: no pull request is open. While $Q/block exists, the graphql call holds until $Q/go
 * exists, after touching $Q/in; with $Q/exclusive, two calls inside at once leave $Q/overlap. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'qlock-'));
  const state = join(dir, 'state');
  mkdirSync(state);
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      'echo "$*" >>"$Q/calls"',
      'case "$*" in',
      '  "api user"*) echo agent-bot ;;',
      '  *rules/branches*) echo "[]" ;;',
      '  *graphql*)',
      '    if [ -f "$Q/exclusive" ]; then mkdir "$Q/inside" 2>/dev/null || touch "$Q/overlap"; sleep 0.3; rmdir "$Q/inside" 2>/dev/null; fi',
      '    if [ -f "$Q/block" ]; then touch "$Q/in"; while [ ! -f "$Q/go" ]; do sleep 0.05; done; fi',
      '    echo \'{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\' ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_STATE: state };
  const lockFile = join(state, 'queue.lock');
  const children = [];
  return {
    dir,
    state,
    lockFile,
    sweep: (extra = {}) => spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], { encoding: 'utf8', env: { ...env, ...extra } }),
    start: () => {
      const child = spawn(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], { env, stdio: 'ignore' });
      const run = { child, done: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
      children.push(run);
      return run;
    },
    calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : ''),
    // Whatever the test did, no sweep outlives it: release the fake gh, kill each child, await it, then remove.
    cleanup: async () => {
      writeFileSync(join(dir, 'go'), '');
      for (const { child } of children) child.kill('SIGKILL');
      await Promise.all(children.map((c) => c.done));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const until = async (ok, what) => {
  for (let i = 0; i < 200; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('the lock records its holder: pid, start, host and a token', async () => {
  const w = world();
  try {
    writeFileSync(join(w.dir, 'block'), '');
    const s = w.start();
    await until(() => existsSync(join(w.dir, 'in')), 'the sweep to reach gh');
    const rec = JSON.parse(readFileSync(w.lockFile, 'utf8'));
    assert.equal(rec.pid, s.child.pid);
    assert.equal(rec.start, startOf(s.child.pid));
    assert.equal(rec.host, hostname());
    assert.ok(rec.token);
    writeFileSync(join(w.dir, 'go'), '');
    assert.equal(await s.done, 0);
    assert.ok(!existsSync(w.lockFile), 'the sweep left its lock');
  } finally {
    await w.cleanup();
  }
});

test('a lock whose holder is alive is not taken, however old', async () => {
  const w = world();
  try {
    writeFileSync(w.lockFile, JSON.stringify(holder()));
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(w.lockFile, old, old);
    const out = w.sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /another sweep is running/);
    assert.equal(w.calls(), '');
    assert.equal(JSON.parse(readFileSync(w.lockFile, 'utf8')).token, 'other');
  } finally {
    await w.cleanup();
  }
});

test('a lock whose holder is gone is taken, though it is fresh', async () => {
  const w = world();
  try {
    const gone = spawnSync('true').pid;
    writeFileSync(w.lockFile, JSON.stringify(holder({ pid: gone, start: 'Mon Jan  1 00:00:00 2001' })));
    const out = w.sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /another sweep is running/);
    assert.match(w.calls(), /api user/);
    assert.ok(!existsSync(w.lockFile));
  } finally {
    await w.cleanup();
  }
});

test('a pid reused by another process (a different start) is a dead holder', async () => {
  const w = world();
  try {
    writeFileSync(w.lockFile, JSON.stringify(holder({ start: 'Mon Jan  1 00:00:00 2001' })));
    const out = w.sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(w.calls(), /api user/);
  } finally {
    await w.cleanup();
  }
});

test('a dead holder is taken whatever host it recorded, or none', async () => {
  const w = world();
  try {
    writeFileSync(w.lockFile, JSON.stringify(holder({ host: 'elsewhere.example', pid: spawnSync('true').pid })));
    assert.equal(w.sweep().status, 0);
    assert.match(w.calls(), /api user/);
    const { host, ...noHost } = holder({ pid: spawnSync('true').pid });
    writeFileSync(w.lockFile, JSON.stringify(noHost));
    writeFileSync(join(w.dir, 'calls'), '');
    assert.equal(w.sweep().status, 0);
    assert.match(w.calls(), /api user/);
  } finally {
    await w.cleanup();
  }
});

test('a holder whose pid is another user\'s process with another start is taken (EPERM falls through to start)', async () => {
  const w = world();
  try {
    writeFileSync(w.lockFile, JSON.stringify(holder({ pid: 1, start: 'Mon Jan  1 00:00:00 2001' })));
    assert.equal(w.sweep().status, 0);
    assert.match(w.calls(), /api user/);
  } finally {
    await w.cleanup();
  }
});

test('a sweep in another time zone does not take a lock the live test process holds', async () => {
  const w = world();
  try {
    writeFileSync(w.lockFile, JSON.stringify(holder()));
    const out = w.sweep({ TZ: 'Asia/Ho_Chi_Minh' });
    assert.match(out.stdout, /another sweep is running/);
    assert.equal(w.calls(), '');
  } finally {
    await w.cleanup();
  }
});

test('a sweep removes the lock only if it made it', async () => {
  const w = world();
  try {
    writeFileSync(join(w.dir, 'block'), '');
    const s = w.start();
    await until(() => existsSync(join(w.dir, 'in')), 'the sweep to reach gh');
    rmSync(w.lockFile, { recursive: true, force: true });
    writeFileSync(w.lockFile, JSON.stringify(holder({ token: 'newer' })));
    writeFileSync(join(w.dir, 'go'), '');
    assert.equal(await s.done, 0);
    assert.ok(existsSync(w.lockFile), 'the sweep removed a lock it did not make');
    assert.equal(JSON.parse(readFileSync(w.lockFile, 'utf8')).token, 'newer');
  } finally {
    await w.cleanup();
  }
});

test('a sweep that judged a holder dead, then finds another sweep took the lock first, gives the lock back', async () => {
  const w = world();
  try {
    const gone = spawnSync('true').pid;
    writeFileSync(w.lockFile, JSON.stringify(holder({ pid: gone, token: 'dead' })));
    let a = null;
    // Sweep B has read the dead holder; sweep A takes over before B renames.
    const b = queue.takeLock(w.lockFile, {
      afterRead: () => {
        a = queue.takeLock(w.lockFile);
      },
    });
    assert.ok(a, 'the first sweep did not take the dead lock');
    assert.equal(b, null, 'both sweeps took over');
    assert.equal(JSON.parse(readFileSync(w.lockFile, 'utf8')).token, a.token, 'the live lock was not put back');
  } finally {
    await w.cleanup();
  }
});

test('six sweeps started together on a dead lock never run at once (a smoke test)', async () => {
  const w = world();
  try {
    writeFileSync(w.lockFile, JSON.stringify(holder({ pid: spawnSync('true').pid, token: 'dead' })));
    writeFileSync(join(w.dir, 'exclusive'), '');
    const runs = Array.from({ length: 6 }, () => w.start());
    const codes = await Promise.all(runs.map((r) => r.done));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    assert.ok(!existsSync(join(w.dir, 'overlap')), 'two sweeps ran at once');
    assert.match(w.calls(), /api user/);
  } finally {
    await w.cleanup();
  }
});
