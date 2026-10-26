// The research eval's runner (#92, review of the build, B2): the spend limit is a ceiling. The runner starts no session that
// could take the spend past it, counting each session at the researcher preset's budget, which is a request to claude and not a
// proven limit on a subscription seat. A session of unknown cost counts at that budget, and a session that never ends is a stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../bin/lib/seat.mjs';
import { evalWorld } from './research-eval-world.mjs';

const BUDGET = PRESETS.researcher.budget;
const usd = (n) => `$${n.toFixed(2)}`;

test('it refuses a session when the spend so far plus the preset\'s budget would pass the limit, and says so with exit 3', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ cost: BUDGET - 5 }]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 1, 'the second session never started');
  assert.match(r.out, new RegExp(`^stopped: the next session could pass the limit: spent ${usd(BUDGET - 5).replace('$', '\\$')} plus the preset's budget ${usd(BUDGET).replace('$', '\\$')} would pass ${usd(24).replace('$', '\\$')}, before re-knip-reader-B-1$`, 'm'));
}));

test('it starts the session that cannot pass the limit, even when the spend plus the budget reaches it exactly', () => evalWorld((w) => {
  const each = (24 - BUDGET) / 2;
  const r = w.eval(['--set', 'probe', '--go'], [{ cost: each }, { cost: each }, { cost: each }]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 3, 'after two sessions spent + budget = 24, which does not pass 24; after three it does');
  assert.match(r.out, /before re-round4-review-A-1$/m);
}));

test('a limit that holds the preset\'s budget several times lets the whole probe through', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go', '--limit-usd', String(BUDGET * 4 + 1)]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(w.calls().length, 4);
}));

test('a limit below the preset\'s budget starts nothing', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go', '--limit-usd', String(BUDGET - 1)]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.deepEqual(w.calls(), []);
  assert.match(r.out, /before re-knip-reader-A-1$/m);
}));

test('a session whose result has no cost counts at the preset\'s budget, and says so', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ cost: null }]);
  assert.equal(r.code, 3, r.out + r.err);
  const run = r.out.match(/^re-knip-reader-A-1 .*$/m)[0];
  assert.ok(run.includes(`cost ${usd(BUDGET)}`) && run.includes('cost unknown'), run);
  assert.ok(r.out.includes(`spent ${usd(BUDGET)} of the`), r.out);
}));

test('a session that writes no record in the time allowed is a stop with exit 5, and nothing after it starts', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go', '--timeout-min', '0.02'], [{ hang: true }]);
  assert.equal(r.code, 5, r.out + r.err);
  assert.equal(w.calls().length, 1);
  assert.match(r.out, /^stopped: re-knip-reader-A-1 wrote no record in 0\.02 minutes; it may still be running$/m);
}));
