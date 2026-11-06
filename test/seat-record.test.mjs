// bin/seat (#91): the record of a run that has several result events. `claude -p` emits a result for each query, and a
// background task that ends starts another (review of #91, B3). Turns and duration are summed; the cost, which is cumulative,
// and the subtype come from the last result; the structured output from the last result that has one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until, world } from './seat-world.mjs';
import { quiet } from './helpers.mjs';
import * as seat from '../bin/lib/seat.mjs';

const git = (cwd, ...args) => assert.equal(spawnSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...quiet }, encoding: 'utf8' }).status, 0, args.join(' '));
const recordIn = (cwd) => seat.recordOf({ role: 'worker', seat: 1, tag: 't', run: '/r', start: '2026-10-30T00:00:00Z', cwd }, [], { code: 0, end: new Date('2026-10-30T00:01:00Z') });

test('an error result overrides success and records the first available failure message (#170)', () => {
  const limit = "You've hit your session limit · resets 7:50pm (Asia/Saigon)";
  const spec = { role: 'worker', seat: 1, tag: 't', run: '/r', start: '2026-10-30T00:00:00Z', cwd: tmpdir() };
  const end = { code: 0, end: new Date('2026-10-30T00:01:00Z') };
  for (const [fields, message] of [
    [{ result: limit, errors: ['ignored'], terminal_reason: 'ignored' }, limit],
    [{ result: '', errors: ['API error', 'retry failed'], terminal_reason: 'ignored' }, 'API error; retry failed'],
    [{ errors: [], terminal_reason: 'terminal failure' }, 'terminal failure'],
  ]) {
    const rec = seat.recordOf(spec, [
      { type: 'result', subtype: 'success' },
      { type: 'result', subtype: 'success', is_error: true, ...fields },
    ], end);
    assert.equal(rec.ended, 'error');
    assert.equal(rec.error, message);
  }
  const success = seat.recordOf(spec, [{ type: 'result', subtype: 'success', is_error: false }], end);
  assert.equal(success.ended, 'success');
  assert.equal(success.error, undefined);
  assert.equal(seat.recordOf(spec, [], end).ended, 'no-result');
});

/** A work folder that is a clone: a commit on `branch` and `origin` at `url`. */
function clone(url, branch = 'work-1') {
  const dir = mkdtempSync(join(tmpdir(), 'seat-record-'));
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
  if (url) git(dir, 'remote', 'add', 'origin', url);
  return dir;
}

test('the record names the repository and branch of the work folder, read when the session ends (#205)', () => {
  for (const [url, repo] of [['https://github.com/o/app.git', 'o/app'], ['https://github.com/o/app', 'o/app'], ['git@github.com:o/app.git', 'o/app'], ['https://example.com/o/app.git', null]]) {
    const dir = clone(url);
    try {
      const rec = recordIn(dir);
      assert.equal(rec.repo, repo, url);
      assert.equal(rec.branch, 'work-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a folder that is not a clone, a clone with no origin and a detached HEAD give null, and the record still stands (#205)', () => {
  const plain = mkdtempSync(join(tmpdir(), 'seat-record-'));
  mkdirSync(join(plain, 'sub'));
  const noOrigin = clone(null);
  const detached = clone('https://github.com/o/app.git');
  try {
    git(detached, 'checkout', '-q', '--detach');
    for (const [dir, repo, branch] of [[plain, null, null], [join(plain, 'sub'), null, null], [`${plain}/missing`, null, null], [noOrigin, null, 'work-1'], [detached, 'o/app', null]]) {
      const rec = recordIn(dir);
      assert.equal(rec.repo, repo, dir);
      assert.equal(rec.branch, branch, dir);
      assert.equal(rec.role, 'worker');
    }
  } finally {
    for (const d of [plain, noOrigin, detached]) rmSync(d, { recursive: true, force: true });
  }
});

test('two result events: turns and duration summed, cost and subtype from the last, the report from the last that has one', () => world(async (w) => {
  const r = w.start('worker', ['--tag', 'two'], { FAKE_MODE: 'two' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const [rec] = w.records();
  assert.equal(rec.turns, 9);
  assert.equal(rec.duration_ms, 1734);
  assert.equal(rec.total_cost_usd, 2.5);
  assert.equal(rec.ended, 'error_max_turns');
  assert.deepEqual(rec.structured, { conclusion: 'done', evidence: ['a'], couldNotRead: [], needsLead: [], foundOutside: [] });
}));

test('a report that lists work found outside the task leaves it in the record as given (#338)', () => world(async (w) => {
  const found = 'bin/x.mjs:3 reads a stale path; outside the task, which is about y';
  const r = w.start('worker', ['--tag', 'found'], { FAKE_FOUND: found });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const [rec] = w.records();
  assert.deepEqual(rec.structured, { conclusion: 'done', evidence: ['a'], couldNotRead: [], needsLead: [], foundOutside: [found] });
}));
