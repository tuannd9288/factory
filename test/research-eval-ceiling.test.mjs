// The research eval's runner (#92, review of the build, B2; #194): the spend limit is the Human's ceiling on an eval he funds.
// After each session the runner adds the cost its result recorded, and starts no new session once the spend reaches the
// limit; nothing is projected, so one session can run past the limit by its own cost. A result with no recorded cost stops
// the set, since the spend is then unknown, and a session that never ends is a stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalWorld } from './research-eval-world.mjs';

test('it starts no session once the recorded spend reaches the limit, and says so with exit 3', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ cost: 10 }, { cost: 14 }]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 2, 'the third session never started');
  assert.match(r.out, /^stopped: spend \$24\.00 reached the limit of \$24\.00 after re-knip-reader-B-1$/m);
}));

test('a spend under the limit starts the next session, however close, and that session can take the spend past it', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ cost: 23.75 }]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 2);
  assert.match(r.out, /^stopped: spend \$24\.75 reached the limit of \$24\.00 after re-knip-reader-B-1$/m);
}));

test('a limit of $1 still starts the first session: only a recorded cost counts, never a projection', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go', '--limit-usd', '1']);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 1);
  assert.match(r.out, /^stopped: spend \$1\.50 reached the limit of \$1\.00 after re-knip-reader-A-1$/m);
}));

test('a session whose result has no recorded cost stops the set with exit 3, and says its cost is unknown', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ cost: null }]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 1);
  assert.match(r.out.match(/^re-knip-reader-A-1 .*$/m)[0], / cost unknown /);
  assert.match(r.out, /^stopped: re-knip-reader-A-1 recorded no cost, so the spend is unknown and no session starts after it$/m);
}));

test('a session that writes no record in the time allowed is a stop with exit 5, and nothing after it starts', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go', '--timeout-min', '0.02'], [{ hang: true }]);
  assert.equal(r.code, 5, r.out + r.err);
  assert.equal(w.calls().length, 1);
  assert.match(r.out, /^stopped: re-knip-reader-A-1 wrote no record in 0\.02 minutes; it may still be running$/m);
}));
