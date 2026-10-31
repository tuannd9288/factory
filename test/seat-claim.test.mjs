// bin/seat (#91): one tag, one session, and a record that is the session's own (review of #91, B2). The tag is claimed
// atomically; a supervisor killed with SIGKILL leaves a claude that still counts as live; and the record of a restarted tag never
// carries the orphan's session id, cost or report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEAT_JS, until, world } from './seat-world.mjs';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const exits = (w, argvs, env) => Promise.all(argvs.map((argv) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SEAT_JS, ...argv], { env: w.env(env), cwd: w.root, stdio: 'ignore' });
  p.on('close', resolve);
})));

test('three concurrent starts with one tag give one session; the others exit 2; a finished run\'s tag can be used again', () => world(async (w) => {
  const hold = { FAKE_MODE: 'hang', FAKE_RELEASE: join(w.fake, 'release') };
  const codes = await exits(w, [1, 2, 3].map(() => w.args('worker', ['--tag', 'same'])), hold);
  assert.deepEqual(codes.sort(), [0, 2, 2]);
  writeFileSync(hold.FAKE_RELEASE, '');
  await until(() => w.records().length === 1, 'the one record');
  const again = w.start('worker', ['--tag', 'same']);
  assert.equal(again.code, 0, again.out + again.err);
  await until(() => w.records().length === 2, 'the second record');
}));

// A listing that is passed to liveCount: each call gives the next list, the last one for every call after.
const listings = (...lists) => {
  let i = 0;
  return () => lists[Math.min(i++, lists.length - 1)];
};

test('a count that lists the folder just before a start hands off its claim to its run counts that run', async () => {
  const { liveCount } = await import('../bin/lib/seat.mjs');
  await world(async (w) => {
    const run = join(w.root, 'handoff');
    mkdirSync(run);
    writeFileSync(join(run, 'run-a.pid'), `${process.pid}\n`);
    writeFileSync(join(run, 'run-a.seat'), '2\n');
    // The first listing has a's claim, whose files are gone by the time they are read; the second has a's run.
    const claim = join(run, 'run-a.claim.pid');
    assert.equal(liveCount(w.runs, 2, listings([claim], [join(run, 'run-a.pid')])), 1);
  });
});

test('a count whose listing changes every time it is taken is Infinity, not a number', async () => {
  const { liveCount } = await import('../bin/lib/seat.mjs');
  let n = 0;
  assert.equal(liveCount('/nowhere', 2, () => [`/nowhere/run-${n++}.pid`]), Infinity);
});

// An ended run: a dead pid, its seat, and a log whose last rate_limit_event has status (its windows reset in an hour, the
// week at 0.35), with an mtime minutes ago.
function ended(dir, tag, seat, status, minutesAgo) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `run-${tag}.pid`), `${spawnSync(process.execPath, ['-e', '']).pid}\n`);
  writeFileSync(join(dir, `run-${tag}.seat`), `${seat}\n`);
  const log = join(dir, `run-${tag}.jsonl`);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const unifiedWindows = { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.35, resetsAt } };
  writeFileSync(log, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType: 'five_hour', unifiedWindows } })}\n`);
  const t = new Date(Date.now() - minutesAgo * 60000);
  utimesSync(log, t, t);
}

test('a refused start leaves the earlier run\'s .seat, so its log stays on its seat and seat 1 stays rejected', () => world(async (w) => {
  ended(w.run, 'old2', 2, 'rejected', 1); // seat 2 is out too, so the start reaches seat 1's log
  ended(w.run, 'worker', 1, 'rejected', 1); // the worker's last run ended on seat 1, cut off by Claude Code
  ended(join(w.runs, 'issue-3'), 'old', 1, 'allowed', 60);
  const first = w.start('worker');
  assert.equal(first.code, 2, first.out + first.err);
  assert.equal(readFileSync(join(w.run, 'run-worker.seat'), 'utf8'), '1\n');
  const other = w.start('worker', ['--tag', 'other']);
  assert.equal(other.code, 2, other.out + other.err);
  assert.match(other.err, /seat 1: rejected by Claude Code \(five-hour window\) until /);
}));

test('a start that fails after it chose a seat leaves no claim behind', () => world(async (w) => {
  // A directory named like a log of seat 2: reading it as a log throws while the seat is being judged.
  mkdirSync(join(w.run, 'run-bad.jsonl'));
  writeFileSync(join(w.run, 'run-bad.seat'), '2\n');
  const r = w.start('worker');
  assert.notEqual(r.code, 0, r.out + r.err);
  assert.deepEqual(readdirSync(w.run).filter((n) => n.startsWith('run-worker')), []);
}));

test('a supervisor killed with SIGKILL leaves a claude that is still counted live and keeps its tag until it ends', () => world(async (w) => {
  const { liveCount } = await import('../bin/lib/seat.mjs');
  const hold = { FAKE_MODE: 'hang', FAKE_RELEASE: join(w.fake, 'release'), FAKE_SID: 'orphan', FAKE_COST: '9.99', FAKE_TURNS: '99' };
  assert.equal(w.start('worker', ['--tag', 'same'], hold).code, 0);
  await until(() => existsSync(w.out()), 'the session');
  const claude = w.saw().pid;
  process.kill(w.pidOf('same'), 'SIGKILL');
  await until(() => !alive(w.pidOf('same')), 'the supervisor to die');
  assert.ok(alive(claude), 'claude outlives its supervisor');
  assert.equal(liveCount(w.runs, 2), 1, 'its run is still counted');
  const refused = w.start('worker', ['--tag', 'same']);
  assert.equal(refused.code, 2, refused.out + refused.err);

  writeFileSync(hold.FAKE_RELEASE, '');
  await until(() => !alive(claude), 'the orphan to end');
  assert.equal(liveCount(w.runs, 2), 0);
  const r = w.start('worker', ['--tag', 'same'], { FAKE_SID: 'second', FAKE_OUT: w.out('b') });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the second run\'s record');
}));
