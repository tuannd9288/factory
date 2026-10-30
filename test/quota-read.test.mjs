// The quota windows (#63, K2 option B): what Claude Code itself reports, read from two sources only. Source 1 is the
// rate_limit_event of a stream-json log (utilization 0 to 1), source 3 the status line's rate_limits (used_percentage). One
// reader of a seat's log serves bin/seat's pick and the ledger's table. The fixtures are recorded lines; the ones named
// synthetic are made from them, since no recorded event has a status other than "allowed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = (name) => readFileSync(new URL(`./fixtures/quota/${name}`, import.meta.url), 'utf8');
const event = (name) => JSON.parse(fixture(name)).rate_limit_info;
const quota = () => import('../bin/lib/quota.mjs');
const seat = () => import('../bin/lib/seat.mjs');

test('a recorded event gives both windows as fractions with their reset; overageStatus "rejected" is not a rejected window', async () => {
  const { windowsOf } = await quota();
  assert.deepEqual(windowsOf(event('real-event.jsonl')), {
    five_hour: { use: 0.13, resetsAt: 1792998600 },
    seven_day: { use: 0.03, resetsAt: 1793415600 },
    status: 'allowed',
    type: 'five_hour',
    rejected: false,
  });
});

test('an event whose status is "rejected" names the window that rateLimitType gives', async () => {
  const { windowsOf } = await quota();
  const w = windowsOf(event('synthetic-rejected-event.jsonl'));
  assert.equal(w.rejected, true);
  assert.equal(w.type, 'five_hour');
  assert.equal(w.five_hour.use, 1);
});

test('an event without a window gives null for it, never a number', async () => {
  const { windowsOf } = await quota();
  const w = windowsOf({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 7 } } });
  assert.equal(w.five_hour, null);
  assert.deepEqual(w.seven_day, { use: 0.5, resetsAt: 7 });
  assert.equal(windowsOf({}).seven_day, null);
});

test('the status line gives used_percentage divided by 100 and resets_at; the early record, with no rate_limits, gives none', async () => {
  const { statusLineWindows } = await quota();
  const [last] = fixture('synthetic-statusline.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(statusLineWindows(last), {
    five_hour: { use: 0.93, resetsAt: 1792998600 },
    seven_day: { use: 0.41, resetsAt: 1793415600 },
    status: null,
    type: null,
    rejected: false,
  });
  assert.equal(statusLineWindows(JSON.parse(fixture('real-statusline.jsonl'))).seven_day.use, 0);
  assert.equal(statusLineWindows({ at: 'x', rate_limits: null }), null);
});

// A runs folder as bin/seat leaves it: run-<tag>.jsonl and run-<tag>.seat in a folder of their own.
function withRuns(logs, body) {
  const runs = mkdtempSync(join(tmpdir(), 'quota-runs-'));
  try {
    for (const [folder, name, seatNo, file, mtime] of logs) {
      mkdirSync(join(runs, folder), { recursive: true });
      writeFileSync(join(runs, folder, `run-${name}.jsonl`), `{"type":"system","subtype":"init"}\n${fixture(file)}{"type":"result"}\n`);
      writeFileSync(join(runs, folder, `run-${name}.seat`), `${seatNo}\n`);
      utimesSync(join(runs, folder, `run-${name}.jsonl`), new Date(mtime), new Date(mtime));
    }
    return body(runs);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
}

test('seatEvent is the newest log of the seat that reports a seven-day use, with the log\'s time', async () => {
  const { seatEvent } = await seat();
  withRuns([
    ['issue-1', 'old', 2, 'real-event.jsonl', '2026-10-20T00:00:00Z'],
    ['issue-2', 'new', 2, 'synthetic-high-week-event.jsonl', '2026-10-25T00:00:00Z'],
    ['issue-3', 'other', 1, 'synthetic-rejected-event.jsonl', '2026-10-26T00:00:00Z'],
  ], (runs) => {
    const e = seatEvent(runs, 2);
    assert.equal(e.info.unifiedWindows.seven_day.utilization, 0.74);
    assert.equal(e.asOf, Date.parse('2026-10-25T00:00:00Z'));
    assert.equal(seatEvent(runs, 1).info.unifiedWindows.seven_day.utilization, 0.74);
    assert.equal(seatEvent(runs, 1).info.status, 'rejected');
  });
  withRuns([], (runs) => {
    assert.equal(seatEvent(runs, 2), null);
  });
});

// The header above says no recorded event has another status than "allowed"; that is wrong. Claude Code's own warning at
// 0.75 is recorded 25 times (issue-75, -81, -90, -98, -seats): status "allowed_warning", rateLimitType "seven_day".
test('a recorded allowed_warning event is not rejected, and its status and window are kept', async () => {
  const { windowsOf } = await quota();
  assert.deepEqual(windowsOf(event('real-warning-event.jsonl')), {
    five_hour: { use: 0.3, resetsAt: 1792966800 },
    seven_day: { use: 0.78, resetsAt: 1793271600 },
    status: 'allowed_warning',
    type: 'seven_day',
    rejected: false,
  });
});
