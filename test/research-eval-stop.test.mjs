// The research eval's runner (#92, Colly's message 5): the first invalid run stops the set, with exit 8 (no other stop uses it),
// the tag and each outside path printed, and the results of the runs so far written with the invalid run listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalWorld } from './research-eval-world.mjs';

const read = (file_path) => ({ calls: [{ name: 'Read', input: { file_path } }] });
const resultOf = (w) => JSON.parse(readFileSync(join(w.run, 'research-eval-probe.json'), 'utf8'));

test('a first session that reads outside its folders is the last: exit 8, the tag and paths printed, no second session', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{ calls: [...read('~/x').calls, ...read('/etc/hosts').calls] }]);
  assert.equal(r.code, 8, r.out + r.err);
  assert.equal(w.calls().length, 1, 'the second session never started');
  assert.match(r.out, /^re-knip-reader-A-1 INVALID: not scored; read outside its folders: ~\/x, \/etc\/hosts /m);
  assert.match(r.out, /^stopped: re-knip-reader-A-1 read outside its folders: ~\/x, \/etc\/hosts$/m);
  const { results } = resultOf(w);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].invalid.map((x) => x.path), ['~/x', '/etc/hosts']);
}));

test('a valid run before it is kept, and its pair is not compared', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], [{}, read('/etc/hosts')]);
  assert.equal(r.code, 8, r.out + r.err);
  assert.equal(w.calls().length, 2, 'A, then B, which read outside; nothing after');
  const { results, summary } = resultOf(w);
  assert.deepEqual(results.map((x) => x.tag), ['re-knip-reader-A-1', 're-knip-reader-B-1']);
  assert.equal(results[0].points, 6, 'it was graded as the run it is');
  assert.equal(summary.delta, null);
  assert.match(r.out, /no comparison/);
}));
