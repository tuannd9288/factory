// The research eval's runner (#92, re-review 2, B1 by detection): after each session the runner reads its log and places every
// path in a tool input. A path outside the session's run folder, work folder and task folders makes the run invalid: unscored,
// listed with the path, and with no comparison for its pair. A path it cannot place counts as outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalWorld } from './research-eval-world.mjs';

const resultOf = (w) => JSON.parse(readFileSync(join(w.run, 'research-eval-probe.json'), 'utf8'));
const call = (name, input) => ({ name, input });

test('paths inside the session\'s folders are valid: its task\'s folder, its own work folder, and a revision range with ".."', () => evalWorld((w) => {
  const knip = join(w.runs, 'issue-70/sources/knip');
  const inside = [
    call('Read', { file_path: join(knip, 'package.json') }),
    call('Grep', { pattern: 'resolveConfig', path: join(knip, 'src') }),
    call('Glob', { pattern: join(knip, '**/*.ts') }),
    call('Write', { file_path: 'notes.txt', content: 'x' }),
    call('Bash', { command: `ls ${knip} 2>/dev/null; git -C ${knip} log --oneline aedffb0..a2f6aa4 | head -3` }),
  ];
  const r = w.eval(['--set', 'probe', '--go'], [{ calls: inside }]);
  assert.equal(r.code, 0, r.out + r.err);
  const first = resultOf(w).results[0];
  assert.equal(first.invalid, undefined, JSON.stringify(first.invalid));
  assert.equal(first.points, 6);
  assert.match(r.out, /^B minus A: /m);
}));

// The runner stops at the first invalid run, so each case is the first session of a world of its own.
const knip = (w) => join(w.runs, 'issue-70/sources/knip');
const CASES = [
  ['another session\'s log', (w) => join(w.runs, 're-probe-knip-reader-B-1/run-re-knip-reader-B-1.jsonl'), (p) => ({ calls: [call('Read', { file_path: p })] })],
  ['a ~ path', () => '~/factory-runs/issue-92/report-worker.md', (p) => ({ calls: [call('Read', { file_path: p })] })],
  ['a .. out of the work folder', () => '../re-knip-reader-B-1/notes.txt', (p) => ({ calls: [call('Write', { file_path: p, content: 'x' })] })],
  ['a link inside a task folder that leads out', (w) => join(knip(w), 'link/secret.txt'), (p, w) => ({ links: [{ from: join(knip(w), 'link'), to: join(w.root, 'outside') }], calls: [call('Read', { file_path: p })] })],
  ['a variable', () => '$HOME/x', (p) => ({ calls: [call('Bash', { command: `cat ${p}` })] })],
  ['a glob at the root', () => '/**/*.json', (p) => ({ calls: [call('Glob', { pattern: p })] })],
];

for (const [name, pathOf, stepOf] of CASES) {
  test(`${name} is an invalid run: unscored and listed with its path`, () => evalWorld((w) => {
    const path = pathOf(w);
    w.eval(['--set', 'probe', '--go'], [stepOf(path, w)]);
    const first = resultOf(w).results[0];
    assert.deepEqual(first.invalid.map((x) => x.path), [path]);
    assert.equal(first.points, null, 'not scored');
  }));
}
