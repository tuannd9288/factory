// The research eval's runner (#92, review of the build): arm B must really be without helpers, the model must not change within a
// set, a cut run must be seen as a cut, the keys are checked before any credit is spent, and the result says what it does not show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalWorld } from './research-eval-world.mjs';

const results = (w) => JSON.parse(readFileSync(join(w.run, 'research-eval-probe.json'), 'utf8'));

test('both arms deny the helper tools by name, and only arm B: Agent, Task and Workflow', () => evalWorld((w) => {
  assert.equal(w.eval(['--set', 'probe', '--go']).code, 0);
  const [a1, b1, b2, a2] = w.calls();
  for (const c of [b1, b2]) for (const tool of ['Agent', 'Task', 'Workflow']) assert.ok(c.denied.includes(tool), `${c.arm} ${tool}`);
  for (const c of [a1, a2]) for (const tool of ['Agent', 'Task', 'Workflow']) assert.ok(!c.denied.includes(tool), `${c.arm} ${tool}`);
}));

test('arm A counts a Workflow call among its helpers', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ helpers: 1, workflow: 2 }]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out.match(/^re-knip-reader-A-1 .*$/m)[0], /helpers 3/);
}));

test('arm B stops the runner (exit 4) when its init event is missing, when it started a helper, when a subagent spoke, or when a helper tool is still listed', () => evalWorld((w) => {
  const cases = [
    [{ noInit: true }, /no init event/],
    [{ helpers: 1 }, /started 1 helper/],
    [{ parent: true }, /subagent/],
    [{ leak: true }, /had the Agent tool/],
    [{ tools: ['Workflow'] }, /had the Workflow tool/],
  ];
  for (const [step, message] of cases) {
    const r = w.eval(['--set', 'probe', '--go'], [{}, step]);
    assert.equal(r.code, 4, `${JSON.stringify(step)}: ${r.out}${r.err}`);
    assert.match(r.out, new RegExp(`^stopped: re-knip-reader-B-1 .*${message.source}`, 'm'));
  }
}));

test('the model is kept for each run and the runner stops (exit 6) when it changes within a set', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{}, {}, { model: 'claude-sonnet-5-5' }]);
  assert.equal(r.code, 6, r.out + r.err);
  assert.match(r.out, /^stopped: re-round4-review-B-1 ran on claude-sonnet-5-5, not claude-opus-5-5$/m);
  assert.deepEqual(results(w).results.map((x) => x.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
}));

test('how each run ended is printed and kept, so that a cut by the turn limit reads as a cut', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{}, { ended: 'error_max_turns' }]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out.match(/^re-knip-reader-A-1 .*$/m)[0], / ended success/);
  assert.match(r.out.match(/^re-knip-reader-B-1 .*$/m)[0], / ended error_max_turns/);
  assert.deepEqual(results(w).results.map((x) => x.ended), ['success', 'error_max_turns', 'success', 'success']);
}));

test('the result says what it does not show: the same note is printed and kept', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 0, r.out + r.err);
  const { note } = results(w);
  assert.ok(typeof note === 'string' && note.length > 0);
  assert.ok(r.out.includes(note));
}));

test('with --go the runner checks every key of the set first, and starts nothing when one does not hold', () => evalWorld((w) => {
  // This world holds none of the sources the keys name.
  const r = w.eval(['--set', 'probe', '--go'], [], { keys: true });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /knip-reader/);
  assert.deepEqual(w.calls(), []);
}));
