import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleLine, reconcile } from '../bin/lib/daemon.mjs';
import { recordsWriter } from '../bin/lib/shared-records.mjs';
import { openStore } from '../bin/lib/store.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('seat ends backfill records, retry rejected pushes on wake, and recover a lost acknowledgement without duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  const state = join(dir, 'state');
  const runs = join(dir, 'runs');
  const remote = join(dir, 'remote.git');
  mkdirSync(state);
  mkdirSync(join(runs, 'app-task'), { recursive: true });
  git(dir, 'init', '--bare', remote);
  const store = openStore(join(state, 'factory.db'));
  const errors = [];
  const d = { state, runs, store, held: null, post: () => ({ posted: true }), log: (s) => errors.push(s), lock: {}, passes: 0 };
  let pending;
  const makeWriter = () => {
    const flush = recordsWriter({ state, runs, remote, node: 'test-node', log: d.log });
    return () => (pending = flush());
  };
  const row = (tag) => ({ run: join(runs, 'app-task'), tag, session: tag, end: '2026-11-05T12:00:00Z', total_cost_usd: 2 });
  const seat = (tag) => appendFileSync(join(state, 'sessions.jsonl'), `${JSON.stringify(row(tag))}\n`);
  const log = '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"seven_day":{"utilization":0.2}}}}';
  const rows = () => git(remote, 'show', 'records/test-node:rows.jsonl').split('\n').map(JSON.parse);
  const end = (tag) => handleLine(d, JSON.stringify({ verb: 'seat-ended', run: row(tag).run, tag, session: tag })).after();
  try {
    // A rejected first push still leaves a local clone containing every pending row.
    writeFileSync(join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(remote, 'hooks/pre-receive'), 0o755);
    seat('old');
    writeFileSync(join(runs, 'app-task/run-old.jsonl'), `${log}\n{"type":"assistant","message":{"usage":{},"content":"private text"}}\n{"type":"result","total_cost_usd":2}\n`);
    d.pushRecords = makeWriter();
    // Give the isolated clone a fixture identity, without touching global git config.
    await d.pushRecords();
    const clone = join(state, 'shared-records.git');
    git(clone, 'config', 'user.name', 'Test');
    git(clone, 'config', 'user.email', 'test@example.invalid');
    reconcile(d);
    await pending;
    assert.ok(errors.length);
    rmSync(join(remote, 'hooks/pre-receive'));
    handleLine(d, JSON.stringify({ verb: 'ping' })).after();
    await pending;
    assert.deepEqual(rows(), [
      { v: 1, node: 'test-node', kind: 'session', row: row('old') },
      { v: 1, node: 'test-node', kind: 'log', run: 'app-task/run-old.jsonl', line: JSON.parse(log) },
    ]);
    const first = git(remote, 'rev-parse', 'records/test-node');
    seat('new');
    end('new');
    await pending;
    assert.equal(rows().length, 3);
    git(remote, 'merge-base', '--is-ancestor', first, 'records/test-node');
    // Push succeeded, but the local acknowledgement was lost before restart.
    git(clone, 'update-ref', 'refs/factory/pushed', first);
    d.pushRecords = makeWriter();
    reconcile(d);
    await pending;
    assert.equal(rows().length, 3);
    assert.equal(git(clone, 'rev-parse', 'refs/factory/pushed'), git(remote, 'rev-parse', 'records/test-node'));
    // A later rejected batch survives restart and a log disappearing locally.
    writeFileSync(join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(remote, 'hooks/pre-receive'), 0o755);
    seat('retry');
    appendFileSync(join(runs, 'app-task/run-old.jsonl'), `${log}\n`);
    end('retry');
    await pending;
    rmSync(join(runs, 'app-task/run-old.jsonl'));
    rmSync(join(remote, 'hooks/pre-receive'));
    d.pushRecords = makeWriter();
    handleLine(d, JSON.stringify({ verb: 'ping' })).after();
    await pending;
    assert.equal(rows().length, 5, 'identical log lines at distinct positions are retained');
    // No remote is reachable. The next ended session retries both batches after it returns.
    renameSync(remote, `${remote}.offline`);
    seat('offline');
    end('offline');
    await pending;
    assert.equal(git(clone, 'show', 'records/test-node:rows.jsonl').split('\n').length, 6);
    renameSync(`${remote}.offline`, remote);
    seat('online');
    end('online');
    await pending;
    assert.equal(rows().length, 7);
    assert.equal(rows().filter((r) => r.row?.tag === 'offline').length, 1);
    assert.deepEqual(git(remote, 'for-each-ref', '--format=%(refname)').split('\n'), ['refs/heads/records/test-node']);
    assert.equal(readFileSync(join(state, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean).length, 5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// FAC-38: the daemon flushes at every ping, pass and seat end, so a flush must cost what is new, not the node's whole history.
test('a flush reads only what is new: bytes it took are not read again, and nothing is fetched while the head is the pushed one (FAC-38)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  const state = join(dir, 'state');
  const runs = join(dir, 'runs');
  const remote = join(dir, 'remote.git');
  const bin = join(dir, 'bin');
  mkdirSync(state);
  mkdirSync(join(runs, 'app-task'), { recursive: true });
  mkdirSync(bin);
  git(dir, 'init', '--bare', remote);
  // Every git the writer runs is logged, then run.
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const calls = join(dir, 'git.log');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${calls}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  // The writer's own git commands (it names its clone with --git-dir; this test's reads use -C), by subcommand.
  const gitRan = () => {
    const ran = readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('--git-dir ')).map((l) => l.split(' ')[2]);
    writeFileSync(calls, '');
    return ran;
  };
  const rate = (n) => `{"type":"rate_limit_event","rate_limit_info":{"n":"${n}"}}`;
  // A stream line, and a rate limit line of the same length, so the log can be rewritten in place.
  const other = `{"type":"assistant","message":{"n":"${'x'.repeat(40)}"}}`;
  const twin = rate('y'.repeat(other.length - rate('').length));
  assert.equal(twin.length, other.length);
  const log = join(runs, 'app-task/run-w.jsonl');
  const errors = [];
  const flush = recordsWriter({ state, runs, remote, node: 'test-node', log: (s) => errors.push(s) });
  const rows = () => git(remote, 'show', 'records/test-node:rows.jsonl').split('\n').map(JSON.parse);
  try {
    writeFileSync(join(state, 'sessions.jsonl'), `${JSON.stringify({ tag: 'a' })}\n${JSON.stringify({ tag: 'b' })}\n`);
    // More than 4 KiB of stream lines after the second line, which the writer checks to know the log is the one it read.
    const rest = `${other}\n`.repeat(60);
    writeFileSync(log, `${rate(1)}\n${other}\n${rest}`);
    await flush();
    assert.deepEqual(errors, []);
    assert.equal(rows().length, 3);
    gitRan();
    // The stream line it took is rewritten in place into a rate limit line: a flush that read it again would publish it.
    writeFileSync(log, `${rate(1)}\n${twin}\n${rest}`);
    await flush();
    assert.deepEqual(errors, []);
    assert.equal(rows().length, 3, 'bytes already taken are not read again');
    assert.deepEqual(gitRan().filter((c) => ['show', 'fetch', 'ls-remote'].includes(c)), [], 'nothing new: no history is read and origin is not asked');
    appendFileSync(log, `${rate(2)}\n`);
    await flush();
    assert.deepEqual(errors, []);
    assert.deepEqual(rows().at(-1).line, JSON.parse(rate(2)));
    assert.equal(rows().length, 4, 'only the appended line is new');
    assert.deepEqual(gitRan().filter((c) => ['show', 'fetch'].includes(c)), [], 'a head that only adds to the pushed tip is pushed without reading rows');
    // The tag runs again: bin/seat empties its log, and the new run writes past where the old one ended before the next flush.
    writeFileSync(log, '');
    appendFileSync(log, `${rate(3)}\n${rest}${rest}`);
    await flush();
    assert.deepEqual(errors, []);
    assert.deepEqual(rows().at(-1).line, JSON.parse(rate(3)), 'a log written again is read from its start');
    assert.equal(rows().length, 5);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});
