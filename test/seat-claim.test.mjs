// bin/seat (#91): one tag, one session, and a record that is the session's own (review of #91, B2). The tag is claimed
// atomically; a supervisor killed with SIGKILL leaves a claude that still counts as live; and the record of a restarted tag never
// carries the orphan's session id, cost or report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
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
