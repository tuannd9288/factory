// bin/seat (#91): the digest's block of sessions, from $FACTORY_STATE/sessions.jsonl. A resumed session's total_cost_usd
// covers the whole session, so the digest takes the last record of each session id and never sums the records of one
// (#89 over-reported about three times by summing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ledger = () => import('../bin/lib/ledger.mjs');

const rec = (o) => ({ session: 's1', role: 'worker', seat: 2, tag: 'run-90', run: '/r', model: 'claude-sonnet-5-5', start: '2026-10-22T10:00:00.000Z', end: '2026-10-22T10:05:00.000Z', minutes: 5, turns: 9, total_cost_usd: 2, structured: null, ended: 'success', ...o });

// Two sessions: s1 ran twice (the second record is its resume, so its cost already holds the first run's), s2 once.
const records = [
  rec({}),
  rec({ session: 's2', role: 'reviewer', tag: 'rev', model: 'claude-opus-5-5', start: '2026-10-22T11:00:00.000Z', end: '2026-10-22T11:10:30.000Z', minutes: 10.5, total_cost_usd: 1.25 }),
  rec({ tag: 'fix', start: '2026-10-23T09:00:00.000Z', end: '2026-10-23T09:04:00.000Z', minutes: 4, total_cost_usd: 3.5 }),
];

test('the sessions block: one line per session with its role, model, cost and minutes, the cost from its last record', async () => {
  const { digest } = await ledger();
  const text = digest([], { since: '2026-10-20', until: '2026-10-27', sessions: records });
  const block = text.slice(text.indexOf('## Sessions'), text.indexOf('\n\nTask: '));
  assert.equal(block, [
    '## Sessions (bin/seat)',
    '',
    '- reviewer rev, claude-opus-5-5, $1.25, 10.5 min',
    '- worker fix, claude-sonnet-5-5, $3.50, 4.0 min',
    '- Total: $4.75 over 2 sessions (the last record of each; a resumed session\'s cost is cumulative, so its records are not added)',
    '- 2 sessions ($4.75 at API prices) charged to no task, because the record names no repository and branch',
  ].join('\n'));
});

test('the digest does not add the records of one session: $2.00 then $3.50 is $3.50', async () => {
  const { sessionLines } = await ledger();
  const { total, lines } = sessionLines([rec({}), rec({ tag: 'fix', total_cost_usd: 3.5, end: '2026-10-23T09:04:00.000Z' })], '2026-10-20', '2026-10-27');
  assert.equal(total, 3.5);
  assert.equal(lines.length, 1);
});

test('sessions outside the period are left out; the period is the one of the other blocks, whole days', async () => {
  const { sessionLines } = await ledger();
  const old = rec({ session: 'old', end: '2026-10-01T10:00:00.000Z', start: '2026-10-01T09:55:00.000Z' });
  assert.equal(sessionLines([old, ...records], '2026-10-20', '2026-10-27').lines.length, 2);
  assert.equal(sessionLines(records, '2026-10-23', '2026-10-23').lines.length, 1, 'the whole of the last day counts');
});

test('a session with no cost (no result event) is listed with a ?, and adds nothing to the total', async () => {
  const { sessionLines } = await ledger();
  const { lines, total } = sessionLines([rec({ session: null, tag: 'crash', total_cost_usd: null, ended: 'no-result', minutes: 2 })], '2026-10-20', '2026-10-27');
  assert.deepEqual(lines, ['- worker crash, claude-sonnet-5-5, $?, 2.0 min']);
  assert.equal(total, 0);
});

test('two records with no session id are two sessions when their run and tag differ', async () => {
  const { sessionLines } = await ledger();
  const a = rec({ session: null, tag: 'a', total_cost_usd: 1 });
  const b = rec({ session: null, tag: 'b', total_cost_usd: 2 });
  assert.equal(sessionLines([a, b], '2026-10-20', '2026-10-27').total, 3);
});

test('no sessions option: no block; an empty list: the block says None', async () => {
  const { digest } = await ledger();
  assert.doesNotMatch(digest([], { since: '2026-10-20', until: '2026-10-27' }), /## Sessions/);
  assert.match(digest([], { since: '2026-10-20', until: '2026-10-27', sessions: [] }), /## Sessions \(bin\/seat\)\n\n- None\./);
});

test('readSessions reads the lines of sessions.jsonl, skips a damaged one, and gives none when the file is absent', async () => {
  const { readSessions } = await ledger();
  const dir = mkdtempSync(join(tmpdir(), 'seat-digest-'));
  try {
    assert.deepEqual(readSessions(dir), []);
    writeFileSync(join(dir, 'sessions.jsonl'), `${JSON.stringify(records[0])}\nnot json\n${JSON.stringify(records[1])}\n`);
    assert.deepEqual(readSessions(dir), [records[0], records[1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
