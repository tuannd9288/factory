// bin/seat (#91, #311): which seat a session runs on, ported from factory:~/factory-runs/seat.zsh. A new session takes the first seat
// of its role's list, a resume its own; no number of live sessions passes a seat over (#280). A seat is a slot: what stops a session is
// its team's account, only while Claude Code has rejected it, until the reset it gave, as the newest rate_limit_event of that
// account's runs says (#194); the session is then refused, and never moves to another seat or account.
import { test } from 'node:test';
import { skipPs } from './ps-skip.mjs';
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
  const add = (seat, { live = true, log = null, age = 0, tag = `t${n++}`, folder = 'issue-1', account = null } = {}) => {
    const dir = join(runs, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `run-${tag}.pid`), `${live ? process.pid : deadPid()}\n`);
    if (seat !== null) writeFileSync(join(dir, `run-${tag}.seat`), `${seat}\n`);
    if (account !== null) writeFileSync(join(dir, `run-${tag}.account`), `${account}\n`);
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

const A = 'acct-a';
const B = 'acct-b';

test('with nothing running a new session takes the first seat of its list, 2 for a worker (#311)', async () => {
  const { chooseSeat } = await lib();
  world((runs) => {
    assert.deepEqual(chooseSeat({ runs, account: A }), { seat: 2, reasons: [] });
    assert.deepEqual(chooseSeat({ runs, account: A, seats: [1, 2] }), { seat: 1, reasons: [] });
  });
});

test('an account with ten live sessions is still chosen: no number of sessions passes it over (#280, #311)', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    for (let i = 0; i < 10; i += 1) add(2, { account: A });
    assert.deepEqual(chooseSeat({ runs, account: A }), { seat: 2, reasons: [] });
  });
});

test('liveCount: a session whose process is gone does not count, a pid file with no seat file counts for seat 2, and the run folders are all counted', { skip: skipPs }, async () => {
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

test('an account is never passed over for its use: seven-day 0.95 on one and 0.99 on the other stop neither (#194, #311)', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(2, { live: false, log: rate(0.95), account: A });
    add(1, { live: false, log: rate(0.99), account: B });
    assert.deepEqual(chooseSeat({ runs, account: A }), { seat: 2, reasons: [] });
    assert.deepEqual(chooseSeat({ runs, account: B, resumeSeat: 1 }), { seat: 1, reasons: [] });
  });
});

test('an account Claude Code rejected is refused until the reset it gave, and the reason names the account, the window and the reset (#311)', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    const hour = rejected('five_hour', HOUR);
    add(2, { live: false, log: hour, account: A });
    assert.deepEqual(chooseSeat({ runs, account: A }), { seat: null, reasons: [`acct-a: rejected by Claude Code (five-hour window) until ${at(hour)} UTC`] });
    assert.equal(chooseSeat({ runs, account: B }).seat, 2, 'the other account is not out');
    assert.equal(chooseSeat({ runs, account: A, now: resetOf(hour) * 1000 - 1 }).seat, null, 'a millisecond before its reset the account is still out');
    assert.deepEqual(chooseSeat({ runs, account: A, now: resetOf(hour) * 1000 }), { seat: 2, reasons: [] }, 'at its reset it is back');
  });
});

test('the account\'s state is read from the newest run of that account with a seven-day use, and the last rate_limit_event in it, whatever the seat (#311)', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(2, { live: false, log: rejected('five_hour', HOUR), age: 100, account: A });
    add(1, { live: false, log: rate(0.1), age: 50, account: A });
    assert.equal(chooseSeat({ runs, account: A }).seat, 2, 'the newer run, on another seat, is not rejected');
  });
  world((runs, add) => {
    add(2, { live: false, log: rate(0.1) + rejected('five_hour', HOUR), age: 10, account: A });
    assert.equal(chooseSeat({ runs, account: A }).seat, null, 'the last event of the log is rejected');
  });
  world((runs, add) => {
    add(2, { live: false, log: rejected('five_hour', HOUR), age: 100, account: A });
    add(2, { live: false, log: '{"type":"system"}\n', age: 5, account: A });
    add(2, { live: false, log: rate(null), age: 1, account: A });
    assert.equal(chooseSeat({ runs, account: A }).seat, null, 'a newer log with no use is passed over');
  });
});

test('the logs of other accounts, and logs with no account and no old row, are not read; an old run with no .account file counts under its seat\'s row (#311)', async () => {
  const { chooseSeat, accountEvent } = await lib();
  world((runs, add) => {
    add(1, { live: false, log: rejected('five_hour', HOUR), account: B });
    add(null, { live: false, log: rejected('five_hour', HOUR) });
    add(1, { live: false, log: rejected('five_hour', HOUR) });
    assert.equal(chooseSeat({ runs, account: A }).seat, 2);
    assert.equal(chooseSeat({ runs, account: A, seatRows: { 2: A } }).seat, 2, 'seat 1 has no old row');
    assert.equal(chooseSeat({ runs, account: A, seatRows: { 1: A } }).seat, null, 'seat 1\'s old row names it');
    assert.equal(accountEvent(runs, A, { 1: A }).info.status, 'rejected');
    assert.equal(accountEvent(runs, A), null);
  });
});

test('a resume keeps its seat: it is refused only while its account is rejected, and then on every seat (#311)', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    assert.deepEqual(chooseSeat({ runs, account: A, resumeSeat: 1 }), { seat: 1, reasons: [] });
    for (let i = 0; i < 10; i += 1) add(1, { account: A });
    assert.deepEqual(chooseSeat({ runs, account: A, resumeSeat: 1 }), { seat: 1, reasons: [] });
    assert.equal(chooseSeat({ runs, account: A, resumeSeat: 2 }).seat, 2);
  });
  world((runs, add) => {
    const hour = rejected('five_hour', HOUR);
    add(2, { live: false, log: hour, account: A });
    assert.deepEqual(chooseSeat({ runs, account: A, resumeSeat: 1 }), { seat: null, reasons: [`acct-a: rejected by Claude Code (five-hour window) until ${at(hour)} UTC`] });
    assert.deepEqual(chooseSeat({ runs, account: A, resumeSeat: 1, now: resetOf(hour) * 1000 }), { seat: 1, reasons: [] }, 'after the reset the resume goes ahead');
  });
});

test('liveOfAccount counts the live runs of an account, an old run through its seat\'s row, and not a run whose process is gone (#311)', { skip: skipPs }, async () => {
  const { liveOfAccount } = await lib();
  world((runs, add) => {
    add(2, { account: A });
    add(1, { account: A, folder: 'issue-2' });
    add(1, { account: B });
    add(2, { account: A, live: false });
    add(2); // an old run: no .account file
    assert.equal(liveOfAccount(runs, A), 2);
    assert.equal(liveOfAccount(runs, A, { 2: A }), 3, 'the old run counts under its seat\'s row');
    assert.equal(liveOfAccount(runs, B), 1);
    assert.equal(liveOfAccount(runs, 'acct-none'), 0);
  });
});

test('a seat other than 1 or 2 is refused (#311)', async () => {
  const { chooseSeat } = await lib();
  world((runs) => assert.throws(() => chooseSeat({ runs, account: A, resumeSeat: 3 }), /seat 3/));
});
