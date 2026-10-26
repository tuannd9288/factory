// The research eval's runner (#92), against bin/seat and a fake `claude` (never a live one): the plan it prints without
// starting anything, the sessions it starts one at a time for two arms, what it prints for each, and the ways it stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fill } from './seat-world.mjs';
import { PROBE, evalWorld } from './research-eval-world.mjs';

test('without --go the probe is only printed: four runs, the exact bin/seat command of each, and nothing is started', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe']);
  assert.equal(r.code, 0, r.out + r.err);
  const lines = r.out.split('\n').filter((l) => l.startsWith('dry: '));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.match(/dry: (re-\S+):/)[1]), PROBE.flatMap((t, i) => (i === 0 ? ['A', 'B'] : ['B', 'A']).map((arm) => `re-${t}-${arm}-1`)));
  for (const l of lines) {
    assert.match(l, /bin\/seat researcher \S+\/re-probe-\S+\/re-\S+\.md --run \S+\/re-probe-\S+ --work \S+ --tag re-\S+ --max-turns 80 /);
    assert.match(l, /--deny WebFetch --deny WebSearch /);
    assert.equal(/--deny Agent --deny Task --deny Workflow$/.test(l), /-B-1:/.test(l), l);
  }
  assert.match(lines[0], /--add-dir \S+\/issue-70\/sources\/knip /);
  assert.deepEqual(readdirSync(w.runs).filter((n) => n.startsWith('re-')), [], 'no session folder was made');
  assert.deepEqual(w.calls(), []);
  assert.match(r.out, /not started: add --go/);
}));

test('--go runs the probe one session at a time and prints each run\'s score, tokens, minutes and cost, then each arm\'s, then the full-set estimate', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 0, r.out + r.err);
  const calls = w.calls();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.arm), ['A', 'B', 'B', 'A']);
  for (const c of calls) {
    assert.equal(c.argv[c.argv.indexOf('--max-turns') + 1], '80');
    assert.ok(c.stdin > 0, 'the brief was given on stdin');
  }
  const records = w.records();
  assert.equal(records.length, 4);
  records.forEach((rec, i) => i > 0 && assert.ok(Date.parse(rec.start) >= Date.parse(records[i - 1].end), 'a session starts after the last one ended'));
  const run = r.out.match(/^re-knip-reader-A-1 .*$/m)[0];
  assert.match(run, /score 6\/6/);
  assert.match(run, /tokens 1150 in 20 out/);
  assert.match(run, /minutes \d+(\.\d+)?/);
  assert.match(run, /cost \$1\.50/);
  assert.match(run, /helpers 2/);
  assert.match(r.out.match(/^re-knip-reader-B-1 .*$/m)[0], /score 1\/6.*cost \$1\.00.*helpers 0/);
  assert.match(r.out, /^arm A: 2 runs, mean score 1\.00, .*cost \$3\.00/m);
  assert.match(r.out, /^arm B: 2 runs, mean score 0\.17, .*cost \$2\.00/m);
  assert.match(r.out, /^B minus A: -0\.83; flipped: knip-reader, round4-review$/m);
  // 20 runs of an arm at the mean cost of the probe's runs: A 20 x 1.50, B 20 x 1.00.
  assert.match(r.out, /^estimate for the full set \(10 tasks x 2 runs x 2 arms\): \$50\.00/m);
  assert.match(r.out, /^spent \$5\.00 of the \$24\.00 limit$/m);
}));

test('a session that costs more than its cap takes the spend past the limit: the runner stops after it, with exit 3', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ cost: 30 }]);
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 1);
  assert.match(r.out, /^stopped: spend \$30\.00 passed the limit of \$24\.00 after re-knip-reader-A-1$/m);
}));

test('--limit-usd moves the limit', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go', '--limit-usd', '100'], [{ cost: 10 }, { cost: 10 }, { cost: 10 }, { cost: 10 }]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(w.calls().length, 4);
  assert.match(r.out, /^spent \$40\.00 of the \$100\.00 limit$/m);
}));

test('arm B with an Agent tool still in its session is a broken arm: the runner stops at once with exit 4', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{}, { leak: true }]);
  assert.equal(r.code, 4, r.out + r.err);
  assert.equal(w.calls().length, 2, 'A, then B, which had the tool');
  assert.match(r.out, /^stopped: re-knip-reader-B-1 had the Agent tool, so arm B is not arm B$/m);
}));

test('a refusal by bin/seat (no free seat) stops it with exit 2, naming the refusal, with nothing started', () => evalWorld((w) => {
  fill(w, 2, 4);
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /seat 2: 4 live sessions/);
  assert.match(r.out, /^stopped: bin\/seat refused re-knip-reader-A-1/m);
  assert.deepEqual(w.calls(), []);
}));

test('the full set needs a limit named by the person who starts it, and a set must be named', () => evalWorld((w) => {
  const full = w.eval(['--set', 'full', '--go']);
  assert.equal(full.code, 2, full.out + full.err);
  assert.match(full.err, /--limit-usd/);
  const none = w.eval([]);
  assert.equal(none.code, 2);
  assert.match(none.err, /--set/);
  assert.deepEqual(w.calls(), []);
  const dry = w.eval(['--set', 'full']);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.out.split('\n').filter((l) => l.startsWith('dry: ')).length, 40);
}));

test('summarize: each arm\'s mean score, and a task flips when its mean score differs between the arms by a point or more', async () => {
  const { summarize } = await import('../probes/research-eval/run.mjs');
  const run = (task, arm, rep, points, max = 6) => ({ task, arm, rep, points, max, score: points / max, cost: 1, minutes: 2, tokensIn: 10, tokensOut: 1 });
  const s = summarize([run('a', 'A', 1, 6), run('a', 'A', 2, 4), run('a', 'B', 1, 5), run('a', 'B', 2, 5), run('b', 'A', 1, 3), run('b', 'B', 1, 4), run('c', 'A', 1, 2), run('c', 'B', 1, 2)]);
  assert.equal(s.arms.A.runs, 4);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(s.arms.A.meanScore, (6 + 4 + 3 + 2) / 4 / 6);
  near(s.arms.B.meanScore, (5 + 5 + 4 + 2) / 4 / 6);
  assert.deepEqual(s.flipped, ['b'], 'a: 5 and 5 against 6 and 4 is the same mean; b differs by a point; c is the same');
  near(s.delta, s.arms.B.meanScore - s.arms.A.meanScore);
});
