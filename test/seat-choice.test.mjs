// bin/seat (#91): which seat a session runs on, ported from factory:~/factory-runs/seat.zsh. A new session tries seat 2, then
// seat 1; no number of live sessions passes a seat over (#280); a seat is passed over for its use only while Claude Code has
// rejected it, until the reset it gave, as the newest rate_limit_event of that seat's logs says (#194); a resume stays on its
// seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lib = () => import('../bin/lib/seat.mjs');

const rate = (u) => `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: u === null ? {} : { utilization: u } } } })}\n`;
const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);
/** An event with status rejected, shaped as the two recorded cut-offs are (#194): the window rateLimitType names is used up and
 * resets in inSeconds, at the event's own resetsAt; the week is at 0.35, under any stop. */
function rejected(type, inSeconds) {
  const resetsAt = nowSec() + inSeconds;
  const w = { five_hour: { utilization: 0.4, resetsAt: nowSec() + 2 * HOUR }, seven_day: { utilization: 0.35, resetsAt: nowSec() + 50 * HOUR } };
  w[type] = { utilization: 1, resetsAt };
  return `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: type, unifiedWindows: w } })}\n`;
}
const resetOf = (line) => JSON.parse(line).rate_limit_info.resetsAt;
const at = (line) => new Date(resetOf(line) * 1000).toISOString().slice(0, 16).replace('T', ' ');
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

function world(body) {
  const runs = mkdtempSync(join(tmpdir(), 'seat-choice-'));
  let n = 0;
  const add = (seat, { live = true, log = null, age = 0, tag = `t${n++}`, folder = 'issue-1' } = {}) => {
    const dir = join(runs, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `run-${tag}.pid`), `${live ? process.pid : deadPid()}\n`);
    if (seat !== null) writeFileSync(join(dir, `run-${tag}.seat`), `${seat}\n`);
    if (log !== null) {
      writeFileSync(join(dir, `run-${tag}.jsonl`), log);
      const t = new Date(Date.now() - age * 1000);
      utimesSync(join(dir, `run-${tag}.jsonl`), t, t);
    }
  };
  try {
    return body(runs, add);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
}

test('with nothing running a new session takes seat 2', async () => {
  const { chooseSeat } = await lib();
  world((runs) => assert.deepEqual(chooseSeat({ runs }), { seat: 2, reasons: [] }));
});

test('a seat with ten live sessions is still chosen: no number of sessions passes a seat over (#280)', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    for (let i = 0; i < 10; i += 1) add(2);
    assert.deepEqual(chooseSeat({ runs }), { seat: 2, reasons: [] });
  });
});

test('liveCount: a session whose process is gone does not count, a pid file with no seat file counts for seat 2, and the run folders are all counted', async () => {
  const { liveCount } = await lib();
  world((runs, add) => {
    for (let i = 0; i < 4; i += 1) add(2, { live: false });
    assert.equal(liveCount(runs, 2), 0);
    for (let i = 0; i < 4; i += 1) add(null);
    for (let i = 0; i < 4; i += 1) add(2, { folder: `issue-${i}` });
    add(1);
    assert.equal(liveCount(runs, 2), 8);
    assert.equal(liveCount(runs, 1), 1);
  });
});

test('a seat is never passed over for its use: seven-day 0.95 on seat 2 and 0.99 on seat 1 stop neither (#194)', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(2, { live: false, log: rate(0.95) });
    add(1, { live: false, log: rate(0.99) });
    assert.deepEqual(chooseSeat({ runs }), { seat: 2, reasons: [] });
    assert.deepEqual(chooseSeat({ runs, resumeSeat: 1 }), { seat: 1, reasons: [] });
  });
});

test('a seat Claude Code rejected is passed over until the reset it gave, and the reason names the window and the reset', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    const hour = rejected('five_hour', HOUR);
    add(2, { live: false, log: hour });
    assert.deepEqual(chooseSeat({ runs }), { seat: 1, reasons: [`seat 2: rejected by Claude Code (five-hour window) until ${at(hour)} UTC`] });
    const week = rejected('seven_day', 2 * HOUR);
    add(1, { live: false, log: week });
    assert.deepEqual(chooseSeat({ runs }), { seat: null, reasons: [
      `seat 2: rejected by Claude Code (five-hour window) until ${at(hour)} UTC`,
      `seat 1: rejected by Claude Code (seven-day window) until ${at(week)} UTC`,
    ] });
    assert.equal(chooseSeat({ runs, now: resetOf(hour) * 1000 - 1 }).seat, null, 'a millisecond before its reset seat 2 is still out, and seat 1 too');
    assert.deepEqual(chooseSeat({ runs, now: resetOf(hour) * 1000 }), { seat: 2, reasons: [] }, 'at its reset seat 2 is back');
  });
});

test('the seat\'s state is read from the newest log of that seat with a seven-day use, and the last rate_limit_event in it', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(2, { live: false, log: rejected('five_hour', HOUR), age: 100 });
    add(2, { live: false, log: rate(0.1), age: 50 });
    assert.equal(chooseSeat({ runs }).seat, 2, 'the newer log is not rejected');
  });
  world((runs, add) => {
    add(2, { live: false, log: rate(0.1) + rejected('five_hour', HOUR), age: 10 });
    assert.equal(chooseSeat({ runs }).seat, 1, 'the last event of the log is rejected');
  });
  world((runs, add) => {
    add(2, { live: false, log: rejected('five_hour', HOUR), age: 100 });
    add(2, { live: false, log: '{"type":"system"}\n', age: 5 });
    add(2, { live: false, log: rate(null), age: 1 });
    assert.equal(chooseSeat({ runs }).seat, 1, 'a newer log with no use is passed over');
  });
});

test('the logs of the other seat, and logs with no seat file, are not read', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(1, { live: false, log: rejected('five_hour', HOUR) });
    add(null, { live: false, log: rejected('five_hour', HOUR) });
    assert.equal(chooseSeat({ runs }).seat, 2);
  });
});

test('a resume stays on its seat: the other seat is not tried, and one rejected until its reset is refused', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    assert.deepEqual(chooseSeat({ runs, resumeSeat: 1 }), { seat: 1, reasons: [] });
    for (let i = 0; i < 10; i += 1) add(1);
    assert.deepEqual(chooseSeat({ runs, resumeSeat: 1 }), { seat: 1, reasons: [] });
    assert.equal(chooseSeat({ runs, resumeSeat: 2 }).seat, 2);
  });
  world((runs, add) => {
    const hour = rejected('five_hour', HOUR);
    add(1, { live: false, log: hour });
    assert.deepEqual(chooseSeat({ runs, resumeSeat: 1 }), { seat: null, reasons: [`seat 1: rejected by Claude Code (five-hour window) until ${at(hour)} UTC`] });
    assert.deepEqual(chooseSeat({ runs, resumeSeat: 1, now: resetOf(hour) * 1000 }), { seat: 1, reasons: [] }, 'after the reset the resume goes ahead');
  });
});

test('a seat other than 1 or 2 is refused', async () => {
  const { chooseSeat } = await lib();
  world((runs) => assert.throws(() => chooseSeat({ runs, resumeSeat: 3 }), /seat 3/));
});
