// bin/seat (#91): one tag, one session, and a record that is the session's own (review of #91, B2). The tag is claimed
// atomically; a supervisor killed with SIGKILL leaves a claude that still counts as live; and the record of a restarted tag never
// carries the orphan's session id, cost or report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEAT_JS, fill, until, world } from './seat-world.mjs';

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

// Without the fix, one try lets both through about 56 times in 100, so five tries are red about 98% of the time.
test('two starts at the same moment on a seat with one place left never both run on it', async () => {
  const { liveCount } = await import('../bin/lib/seat.mjs');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await world(async (w) => {
      fill(w, 2, 3);
      fill(w, 1, 4);
      const hold = { FAKE_MODE: 'hang', FAKE_RELEASE: join(w.fake, 'release') };
      const codes = await exits(w, ['a', 'b'].map((tag) => w.args('worker', ['--tag', tag])), hold);
      assert.ok(codes.filter((c) => c === 0).length <= 1, `try ${attempt}: exit codes ${codes}`);
      assert.ok(liveCount(w.runs, 2) <= 4, `try ${attempt}: seat 2 is not over its cap`);
    });
  }
});

// An ended run: a dead pid, its seat, and a log whose last rate_limit_event gives use, with an mtime minutes ago.
function ended(dir, tag, seat, use, minutesAgo) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `run-${tag}.pid`), `${spawnSync(process.execPath, ['-e', '']).pid}\n`);
  writeFileSync(join(dir, `run-${tag}.seat`), `${seat}\n`);
  const log = join(dir, `run-${tag}.jsonl`);
  writeFileSync(log, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: use } } } })}\n`);
  const t = new Date(Date.now() - minutesAgo * 60000);
  utimesSync(log, t, t);
}

test('a refused start leaves the earlier run\'s .seat, so its log stays on its seat and seat 1 keeps its stop', () => world(async (w) => {
  fill(w, 2, 4);
  ended(w.run, 'worker', 1, 0.75, 1); // the worker's last run ended on seat 1, now past its stop of 0.70
  ended(join(w.runs, 'issue-3'), 'old', 1, 0.10, 60);
  const first = w.start('worker');
  assert.equal(first.code, 2, first.out + first.err);
  assert.equal(readFileSync(join(w.run, 'run-worker.seat'), 'utf8'), '1\n');
  const other = w.start('worker', ['--tag', 'other']);
  assert.equal(other.code, 2, other.out + other.err);
  assert.match(other.err, /seat 1: seven-day use 0\.75/);
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
