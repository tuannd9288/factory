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

test('a path outside is an invalid run: unscored, listed with its path, and its pair is not compared', () => evalWorld((w) => {
  const knip = join(w.runs, 'issue-70/sources/knip');
  const rev4 = join(w.runs, 'issue-17/rev4');
  const aLog = join(w.runs, 're-probe-knip-reader-A-1/run-re-knip-reader-A-1.jsonl');
  const outside = join(w.root, 'outside');
  const r = w.eval(['--set', 'probe', '--go'], [
    { calls: [call('Read', { file_path: join(knip, 'package.json') })] },
    { calls: [call('Read', { file_path: aLog })] },
    { calls: [call('Read', { file_path: '~/factory-runs/issue-92/report-worker.md' }), call('Read', { file_path: '../re-knip-reader-A-1/notes.txt' })] },
    { links: [{ from: join(rev4, 'link'), to: outside }], calls: [call('Read', { file_path: join(rev4, 'link/secret.txt') }), call('Bash', { command: 'cat $HOME/x' }), call('Glob', { pattern: '/**/*.json' })] },
  ]);
  assert.equal(r.code, 0, r.out + r.err);
  const { results, summary } = resultOf(w);
  const byTag = Object.fromEntries(results.map((x) => [x.tag, x]));
  const paths = (tag) => (byTag[tag].invalid ?? []).map((x) => x.path);
  assert.equal(byTag['re-knip-reader-A-1'].invalid, undefined, 'its pair is invalid, but it is not');
  assert.deepEqual(paths('re-knip-reader-B-1'), [aLog], 'another session\'s log');
  assert.deepEqual(paths('re-round4-review-B-1'), ['~/factory-runs/issue-92/report-worker.md', '../re-knip-reader-A-1/notes.txt'], 'a ~ path and a .. out of the work folder');
  assert.deepEqual(paths('re-round4-review-A-1'), [join(rev4, 'link/secret.txt'), '$HOME/x', '/**/*.json'], 'a link inside a task folder that leads out, a variable, a glob at the root');
  for (const tag of ['re-knip-reader-B-1', 're-round4-review-B-1', 're-round4-review-A-1']) {
    assert.equal(byTag[tag].points, null, `${tag} is not scored`);
    assert.match(r.out, new RegExp(`^${tag} INVALID: not scored; read outside its folders: `, 'm'));
  }
  assert.equal(summary.delta, null);
  assert.deepEqual(summary.flipped, []);
  assert.equal(summary.arms.A.meanScore, null, 'no run of A is scored with an invalid partner');
  assert.match(r.out, /no comparison/);
}));
