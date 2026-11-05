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
