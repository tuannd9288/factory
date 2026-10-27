// .gate/bin/rules, when it blocks a line, prints the gate-allow line that would allow it, with the rule's own id (#85).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { repoWithKit, script, write } from './helpers.mjs';

describe('the gate-allow line a block prints', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());

  test('names the rule that blocked, in the form the rules accept', () => {
    write(r.repo, { 'test/focus.test.js': "import { test } from 'node:test';\ntest.only('x', () => {});\n" });
    let out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^ {4}to allow it: gate-allow test-focused: <why, 20 characters or more>$/m);
    write(r.repo, { 'test/focus.test.js': null, 'test/skip.test.js': "import { test } from 'node:test';\ntest.skip('x', () => {});\n" });
    out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.match(out.out, /^ {4}to allow it: gate-allow test-skipped: <why, 20 characters or more>$/m);
    assert.doesNotMatch(out.out, /gate-allow test-focused/);
  });

  test('prints none for a line already allowed, and none for a clean run', () => {
    write(r.repo, { 'test/skip.test.js': "import { test } from 'node:test';\ntest.skip('x', () => {}); // gate-allow test-skipped: waits for the upstream fix in #12\n" });
    let out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.doesNotMatch(out.out, /to allow it/);
    write(r.repo, { 'test/skip.test.js': null });
    out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.doesNotMatch(out.out, /to allow it/);
  });
});
