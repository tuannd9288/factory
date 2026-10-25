// failing-test-edited cannot be allowed by a comment (its finding is a line the file no longer holds), so scripts/rules
// prints no gate-allow line for it (#85).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commit, repoWithKit, script } from './helpers.mjs';

describe('failing-test-edited', () => {
  let r;
  before(() => {
    r = repoWithKit();
    commit(
      r.repo,
      { 'test/new.test.js': "import { test } from 'node:test';\ntest('first', () => {});\ntest('second', () => {});\n" },
      'Add a failing test\n\nFailing-test: node --test test/new.test.js',
    );
    commit(r.repo, { 'test/new.test.js': "import { test } from 'node:test';\ntest('first', () => {});\n" }, 'Weaken it');
  });
  after(() => r.cleanup());

  test('blocks a failing test edited later, and offers no gate-allow line that could not work', () => {
    const out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /failing-test-edited \(block\)/);
    assert.doesNotMatch(out.out, /gate-allow failing-test-edited/);
  });
});
