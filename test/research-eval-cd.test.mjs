// The research eval's path check (#92, re-review 3, B1): a bare `cd` (to ~) and `cd -` (to the last folder) are outside, since the
// next relative path cannot be placed. A `cd` to a named folder is placed like any other path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathWorld } from './research-eval-paths-world.mjs';

test('a bare cd, and cd -, are outside, in any command of a line', () => pathWorld((w) => {
  for (const command of [
    'cd && git grep --no-index -h answers -- factory-runs/issue-92/report-worker.md',
    'cd - && wc -c report-worker.md',
    'cd',
    'ls; cd',
    'ls\ncd -',
    'true || cd && wc -c x',
  ]) assert.ok(w.outside(command).length > 0, command);
}));

test('a cd to a folder inside is valid, and one to a folder outside is outside', () => pathWorld((w) => {
  assert.deepEqual(w.outside(`cd ${w.readable} && ls`), []);
  assert.deepEqual(w.outside('cd notes && ls'), []);
  assert.deepEqual(w.outside('cd ~ && ls'), ['~']);
  assert.deepEqual(w.outside('cd /etc && ls'), ['/etc']);
}));
