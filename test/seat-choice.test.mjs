// bin/seat (#91): which seat a session runs on, ported from factory:~/factory-runs/seat.zsh. A new session tries seat 2, then
// seat 1; at most four live sessions a seat, counted from run*.pid and run*.seat under FACTORY_RUNS; seat 2 stops at 0.90
// of seven_day and seat 1 at 0.70, read from the newest rate_limit_event of that seat's logs; a resume stays on its seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lib = () => import('../bin/lib/seat.mjs');

const rate = (u) => `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: u === null ? {} : { utilization: u } } } })}\n`;
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

test('seat 2 holds four live sessions: the fifth goes to seat 1, and says why seat 2 was passed', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    for (let i = 0; i < 3; i += 1) add(2);
    assert.equal(chooseSeat({ runs }).seat, 2);
    add(2);
    assert.deepEqual(chooseSeat({ runs }), { seat: 1, reasons: ['seat 2: 4 live sessions, at most 4'] });
  });
});

test('a session whose process is gone does not count, and a pid file with no seat file counts for seat 2', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    for (let i = 0; i < 4; i += 1) add(2, { live: false });
    assert.equal(chooseSeat({ runs }).seat, 2);
    for (let i = 0; i < 4; i += 1) add(null);
    assert.equal(chooseSeat({ runs }).seat, 1);
  });
});

test('live sessions are counted across the run folders', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    for (let i = 0; i < 4; i += 1) add(2, { folder: `issue-${i}` });
    assert.equal(chooseSeat({ runs }).seat, 1);
  });
});

test('no seat free: null, with a reason for each seat', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    for (let i = 0; i < 4; i += 1) { add(2); add(1); }
    assert.deepEqual(chooseSeat({ runs }), { seat: null, reasons: ['seat 2: 4 live sessions, at most 4', 'seat 1: 4 live sessions, at most 4'] });
  });
});

test('seat 2 stops at 0.90 of seven_day, and seat 1 at 0.70', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(2, { live: false, log: rate(0.89) });
    assert.equal(chooseSeat({ runs }).seat, 2);
  });
  world((runs, add) => {
    add(2, { live: false, log: rate(0.9) });
    assert.deepEqual(chooseSeat({ runs }), { seat: 1, reasons: ['seat 2: seven-day use 0.9, stops at 0.90'] });
  });
  world((runs, add) => {
    add(2, { live: false, log: rate(0.95) });
    add(1, { live: false, log: rate(0.7) });
    assert.deepEqual(chooseSeat({ runs }), { seat: null, reasons: ['seat 2: seven-day use 0.95, stops at 0.90', 'seat 1: seven-day use 0.7, stops at 0.70'] });
  });
  world((runs, add) => {
    add(2, { live: false, log: rate(0.95) });
    add(1, { live: false, log: rate(0.69) });
    assert.equal(chooseSeat({ runs }).seat, 1);
  });
});

test('the use is read from the newest log of that seat that has one, and the last rate_limit_event in it', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(2, { live: false, log: rate(0.95), age: 100 });
    add(2, { live: false, log: rate(0.1), age: 50 });
    assert.equal(chooseSeat({ runs }).seat, 2, 'the newer log says 0.1');
  });
  world((runs, add) => {
    add(2, { live: false, log: rate(0.1) + rate(0.95), age: 10 });
    assert.equal(chooseSeat({ runs }).seat, 1, 'the last event of the log says 0.95');
  });
  world((runs, add) => {
    add(2, { live: false, log: rate(0.95), age: 100 });
    add(2, { live: false, log: '{"type":"system"}\n', age: 5 });
    add(2, { live: false, log: rate(null), age: 1 });
    assert.equal(chooseSeat({ runs }).seat, 1, 'a newer log with no use is passed over');
  });
});

test('the logs of the other seat, and logs with no seat file, are not read', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    add(1, { live: false, log: rate(0.99) });
    add(null, { live: false, log: rate(0.99) });
    assert.equal(chooseSeat({ runs }).seat, 2);
  });
});

test('a resume stays on its seat: the other seat is not tried, and a full seat is refused', async () => {
  const { chooseSeat } = await lib();
  world((runs, add) => {
    assert.deepEqual(chooseSeat({ runs, resumeSeat: 1 }), { seat: 1, reasons: [] });
    for (let i = 0; i < 4; i += 1) add(1);
    assert.deepEqual(chooseSeat({ runs, resumeSeat: 1 }), { seat: null, reasons: ['seat 1: 4 live sessions, at most 4'] });
    assert.equal(chooseSeat({ runs, resumeSeat: 2 }).seat, 2);
  });
});

test('a seat other than 1 or 2 is refused', async () => {
  const { chooseSeat } = await lib();
  world((runs) => assert.throws(() => chooseSeat({ runs, resumeSeat: 3 }), /seat 3/));
});
