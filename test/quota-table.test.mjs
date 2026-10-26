// The quota table (#63): one row for each seat of bin/seat and one for each status-line file that was given, in the digest and
// from `bin/factory-ledger --quota`; and the map from role to model to seat. A seat that no session has run on shows no
// number; a window whose reset time has passed is marked, not shown as current. Times are UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, factory } from './helpers.mjs';

const fixturePath = (name) => fileURLToPath(new URL(`./fixtures/quota/${name}`, import.meta.url));
const quota = () => import('../bin/lib/quota.mjs');
const ledger = () => import('../bin/lib/ledger.mjs');

function withRuns(logs, body) {
  const runs = mkdtempSync(join(tmpdir(), 'quota-table-'));
  try {
    for (const [folder, seatNo, file, mtime] of logs) {
      mkdirSync(join(runs, folder), { recursive: true });
      writeFileSync(join(runs, folder, 'run-worker.jsonl'), `{"type":"system","subtype":"init"}\n${readFileSync(fixturePath(file), 'utf8')}`);
      writeFileSync(join(runs, folder, 'run-worker.seat'), `${seatNo}\n`);
      utimesSync(join(runs, folder, 'run-worker.jsonl'), new Date(mtime), new Date(mtime));
    }
    return body(runs);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
}

const HEAD = [
  '| Profile | Source | Five-hour use | Five-hour resets (UTC) | Seven-day use | Seven-day resets (UTC) | Status | As of (UTC) |',
  '|---|---|---|---|---|---|---|---|',
];
const BEFORE = Date.parse('2026-10-26T05:00:00Z'); // before the windows of the fixtures reset (07:10 and 10-31 03:00)
const AFTER = Date.parse('2026-11-01T00:00:00Z');
const table = (lines) => lines.filter((l) => l.startsWith('|'));

test('a seat with no session shows no number and says so; a seat with a log shows both windows, their resets, status and the log\'s time', async () => {
  const { quotaRows, quotaSection } = await quota();
  withRuns([['issue-1', 2, 'real-event.jsonl', '2026-10-25T00:00:00Z']], (runs) => {
    const lines = quotaSection(quotaRows({ runs }), { now: BEFORE });
    assert.deepEqual(table(lines), [
      ...HEAD,
      '| seat 1 | rate_limit_event | – | – | – | – | no session has run on it | – |',
      '| seat 2 | rate_limit_event | 13% | 2026-10-26 07:10 | 3% | 2026-10-31 03:00 | allowed | 2026-10-25 00:00 |',
    ]);
    assert.ok(lines.some((l) => /no status-line file/i.test(l)), 'with none given, the section says so');
  });
});

test('a window whose reset time has passed is marked "reset since", not shown as current', async () => {
  const { quotaRows, quotaSection } = await quota();
  withRuns([['issue-1', 2, 'real-event.jsonl', '2026-10-25T00:00:00Z']], (runs) => {
    assert.ok(table(quotaSection(quotaRows({ runs }), { now: AFTER })).includes(
      '| seat 2 | rate_limit_event | 13% (reset since) | 2026-10-26 07:10 | 3% (reset since) | 2026-10-31 03:00 | allowed | 2026-10-25 00:00 |',
    ));
  });
});

test('a rejected window shows in the status column, with the window\'s name', async () => {
  const { quotaRows, quotaSection } = await quota();
  withRuns([['issue-1', 1, 'synthetic-rejected-event.jsonl', '2026-10-25T00:00:00Z']], (runs) => {
    assert.ok(table(quotaSection(quotaRows({ runs }), { now: BEFORE })).includes(
      '| seat 1 | rate_limit_event | 100% | 2026-10-26 07:10 | 74% | 2026-10-31 03:00 | rejected (five_hour) | 2026-10-25 00:00 |',
    ));
  });
});

test('a status-line file that was given adds a row from its last record that holds rate_limits, with that record\'s time', async () => {
  const { quotaRows, quotaSection } = await quota();
  withRuns([], (runs) => {
    const file = join(runs, 'sl.jsonl');
    // The last record has none, as the ones before the first API response: the row takes the one before it.
    writeFileSync(file, `${readFileSync(fixturePath('synthetic-statusline.jsonl'), 'utf8')}{"at":"2026-10-26T02:00:00Z","keys":[],"rate_limits":null}\n`);
    const lines = quotaSection(quotaRows({ runs, statusFiles: [file] }), { now: BEFORE });
    assert.equal(table(lines).at(-1), '| status line sl.jsonl | status line | 93% | 2026-10-26 07:10 | 41% | 2026-10-31 03:00 | – | 2026-10-26 01:00 |');
    assert.ok(!lines.some((l) => /no status-line file/i.test(l)));
    // A file that is not there or holds no rate_limits gives a row with no number.
    const none = table(quotaSection(quotaRows({ runs, statusFiles: [join(runs, 'absent.jsonl')] }), { now: BEFORE })).at(-1);
    assert.equal(none, '| status line absent.jsonl | status line | – | – | – | – | no record with rate_limits | – |');
  });
});

const rec = (o) => ({ session: 's1', role: 'worker', seat: 2, tag: 'w', run: '/r', model: 'claude-sonnet-5-5', start: '2026-10-22T10:00:00.000Z', end: '2026-10-22T10:05:00.000Z', minutes: 5, total_cost_usd: 2, ...o });
const records = [
  rec({}),
  rec({ tag: 'fix', end: '2026-10-22T10:09:00.000Z' }),
  rec({ session: 's2', role: 'reviewer', model: 'claude-opus-5-5', seat: 1, start: '2026-10-22T11:00:00.000Z', end: '2026-10-22T11:10:00.000Z' }),
  rec({ session: 's3', start: '2026-10-23T11:00:00.000Z', end: '2026-10-23T11:10:00.000Z' }),
];

test('the role map counts each session once, by role, model and seat; the account is the value given, else "not recorded"', async () => {
  const { roleMapLines } = await quota();
  const { keptSessions } = await ledger();
  const kept = keptSessions(records, '2026-10-20', '2026-10-27');
  assert.deepEqual(roleMapLines(kept, { 1: 'acct-a' }), [
    '| Role | Model | Seat | Sessions | Account |',
    '|---|---|---|---|---|',
    '| reviewer | claude-opus-5-5 | 1 | 1 | acct-a |',
    '| worker | claude-sonnet-5-5 | 2 | 2 | not recorded |',
  ]);
});

test('the digest prints the table and the role map', async () => {
  const { quotaRows } = await quota();
  const { digest } = await ledger();
  withRuns([['issue-1', 2, 'real-event.jsonl', '2026-10-25T00:00:00Z']], (runs) => {
    const text = digest([], { since: '2026-10-20', until: '2026-10-27', sessions: records, quota: { rows: quotaRows({ runs }), now: BEFORE }, accounts: { 2: 'acct-b' } });
    const block = text.slice(text.indexOf('## Quota windows'), text.indexOf('\n\nTask: '));
    assert.deepEqual(table(block.split('\n')).slice(0, 4), [
      ...HEAD,
      '| seat 1 | rate_limit_event | – | – | – | – | no session has run on it | – |',
      '| seat 2 | rate_limit_event | 13% | 2026-10-26 07:10 | 3% | 2026-10-31 03:00 | allowed | 2026-10-25 00:00 |',
    ]);
    assert.ok(block.includes('| worker | claude-sonnet-5-5 | 2 | 2 | acct-b |'));
    assert.ok(text.indexOf('## Quota windows') > text.indexOf('## Sessions'));
  });
});

test('bin/factory-ledger --quota prints the table from FACTORY_RUNS and a --statusline file, and runs no gh', () => {
  withRuns([['issue-1', 2, 'real-event.jsonl', '2026-10-25T00:00:00Z']], (runs) => {
    // A PATH with node and the system tools only, so a gh call would fail.
    mkdirSync(join(runs, 'bin'));
    symlinkSync(process.execPath, join(runs, 'bin/node'));
    const r = run(factory, join(factory, 'bin/factory-ledger'), ['--quota', '--statusline', fixturePath('synthetic-statusline.jsonl')], { FACTORY_RUNS: runs, PATH: `${join(runs, 'bin')}:/usr/bin:/bin` });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^\| seat 1 \| rate_limit_event \| – \|/m);
    assert.match(r.out, /^\| seat 2 \| rate_limit_event \| 13%/m);
    assert.match(r.out, /^\| status line synthetic-statusline\.jsonl \| status line \| 93%/m);
  });
});
