// #27, FAC-83: the queue's lock is held by one sweep at a time, goes with a holder that dies, and notes its holder in a file that only the
// holder that wrote it removes.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lock from '../bin/lib/lock.mjs';
import { skipPs } from './ps-skip.mjs';

// Every test here reads a process's start time from the real ps, which the factory's sandbox refuses (#183).
const test = (name, fn) => nodeTest(name, { skip: skipPs }, fn);

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');
const startOf = (pid) => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
const holder = (over = {}) => ({ pid: process.pid, start: startOf(process.pid), host: hostname(), token: 'other', ...over });

/** A state folder, and a fake gh: no pull request is open. While $Q/block exists, the graphql call holds until $Q/go
 * exists, after touching $Q/in; with $Q/exclusive, two calls inside at once leave $Q/overlap. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'qlock-'));
  const state = join(dir, 'state');
  mkdirSync(state);
  mkdirSync(join(dir, 'runs'));
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
      '    if [ -f "$Q/block" ]; then touch "$Q/in"; while [ ! -f "$Q/go" ]; do [ -d "$Q" ] || exit 1; sleep 0.05; done; fi',
      '    echo \'{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\' ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_STATE: state, FACTORY_RUNS: join(dir, 'runs') };
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
    // Whatever the test did, no sweep outlives it: release the fake gh, give each sweep about 2 s to finish and take its
    // gh with it, kill what is left, await it, then remove.
    cleanup: async () => {
      writeFileSync(join(dir, 'go'), '');
      await Promise.all(children.map((c) => Promise.race([c.done, new Promise((r) => setTimeout(r, 2000))])));
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

test('the lock notes its holder: pid, start and a token', async () => {
  const w = world();
  try {
    writeFileSync(join(w.dir, 'block'), '');
    const s = w.start();
    await until(() => existsSync(join(w.dir, 'in')), 'the sweep to reach gh');
    const rec = JSON.parse(readFileSync(w.lockFile, 'utf8'));
    assert.equal(rec.pid, s.child.pid);
    assert.ok(!Number.isNaN(Date.parse(rec.start)), rec.start);
    assert.equal(rec.host, undefined);
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
  const held = lock.takeLock(w.lockFile);
  try {
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(w.lockFile, old, old);
    const out = w.sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, new RegExp(`another sweep is running \\(pid ${process.pid}, `));
    assert.equal(w.calls(), '');
    assert.equal(JSON.parse(readFileSync(w.lockFile, 'utf8')).token, held.token);
  } finally {
    held.release();
    await w.cleanup();
  }
});

test('a lock whose holder is killed is taken at once, its note though fresh', async () => {
  const w = world();
  try {
    const lockLib = join(factory, 'bin/lib/lock.mjs');
    const code = `const { takeLock } = await import(${JSON.stringify(lockLib)}); takeLock(${JSON.stringify(w.lockFile)}); console.log('held'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => child.stdout.once('data', r));
    assert.match(w.sweep().stdout, /another sweep is running/);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    assert.equal(JSON.parse(readFileSync(w.lockFile, 'utf8')).pid, child.pid, 'the killed holder\'s note is left');
    const out = w.sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /another sweep is running/);
    assert.match(w.calls(), /api user/);
    assert.ok(!existsSync(w.lockFile));
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

// FAC-83, report B's finding B2: A reads a dead holder; B takes over in that gap; A's rename moves B's live lock aside; C takes the empty path.
// The schedule runs only where the lock reads a holder and renames; the assertions hold for any lock.
test('three sweeps on a dead lock: exactly one holds it, and no other takes it until it lets go', async () => {
  const w = world();
  const realRename = fs.renameSync;
  const take = () => lock.takeLock(w.lockFile);
  try {
    writeFileSync(w.lockFile, JSON.stringify(holder({ pid: spawnSync('true').pid, token: 'dead' })));
    let b;
    let c;
    fs.renameSync = (from, to) => {
      realRename(from, to);
      if (from === w.lockFile && b !== undefined && c === undefined) c = take();
    };
    syncBuiltinESMExports();
    const a = lock.takeLock(w.lockFile, {
      afterRead: () => {
        if (b === undefined) b = take();
      },
    });
    fs.renameSync = realRename;
    syncBuiltinESMExports();
    if (b === undefined) b = take();
    if (c === undefined) c = take();
    const holders = [a, b, c].filter(Boolean);
    assert.equal(holders.length, 1, `${holders.length} sweeps hold the lock at once`);
    assert.equal(take(), null, 'a fourth sweep took the held lock');
    holders[0].release();
    const next = take();
    assert.ok(next, 'nobody could take the lock once it was let go');
    next.release();
  } finally {
    fs.renameSync = realRename;
    syncBuiltinESMExports();
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
