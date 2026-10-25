// A red-check that passed by the PR body's No-red line records that line in its stamp, so scripts/ship can hold the
// body it opens with to it (#85).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repoWithKit, script, write } from './helpers.mjs';

const LINE = 'No-red: a rename with no behaviour to show first';

describe('the red-check stamp of a No-red pass', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());
  const stamp = (head) =>
    join(git(r.repo, 'rev-parse', '--absolute-git-dir'), 'factory', `red-check-${head}-${git(r.repo, 'rev-parse', 'origin/main')}`);

  test('holds the line it passed by', () => {
    const head = commit(r.repo, { 'src/math.js': 'export function add(a, b) {\n  return b + a;\n}\n' }, 'Swap the operands');
    write(r.repo, { '../body.md': `Closes #3\n\n${LINE}\n` });
    const out = script(r.repo, 'red-check', ['--base', 'origin/main', '--body', join(r.repo, '../body.md')]);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /passed by the PR body's No-red/);
    assert.equal(readFileSync(stamp(head), 'utf8').trim(), LINE);
  });

  test('holds nothing for a pass by a test', () => {
    const head = commit(
      r.repo,
      {
        'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n',
        'test/mul.test.js':
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/math.js';\n\ntest('multiplies', () => {\n  assert.equal(m.mul(2, 3), 6);\n});\n",
      },
      'Add mul',
    );
    const out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.equal(readFileSync(stamp(head), 'utf8'), '');
  });
});
