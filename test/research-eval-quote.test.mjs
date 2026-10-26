// The research eval's path check (#92, re-review 3, B1): a Bash command is read quote by quote. Single-quoted text is literal and is
// checked as written: a single-quoted path outside is invalid, and a single-quoted regex that holds a backslash and a "$" is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathWorld } from './research-eval-paths-world.mjs';

test('single-quoted text is checked as written: a path outside is invalid; a regex with a backslash and a "$" is valid', () => pathWorld((w) => {
  assert.deepEqual(w.outside("cat '/etc/hosts'"), ['/etc/hosts']);
  assert.deepEqual(w.outside(`git -C ${w.readable} grep -n 'x$HOME\\.y|a\\\\b$' -- packages`), []);
}));

test('double-quoted text follows the shell: only a "$" and a backtick expand there', () => pathWorld((w) => {
  // The probe's first run (2026-10-26), invalid on this regex alone, though the command reads nothing outside.
  assert.deepEqual(w.outside(`cd ${w.readable} && grep -n "jiti\\|import(\\|require(\\|createJiti\\|load" packages/knip/src/util/loader.ts`), []);
  assert.deepEqual(w.outside('git grep -n -E "\\.md|a{2}" -- packages; cat "{a}" "\\$HOME" "\\/x"'), []);
  for (const command of ['cat "$HOME/x"', 'cat "${HOME}"/x', 'cat "`echo /etc/hosts`"', 'cat "a\\"$HOME'])
    assert.ok(w.outside(command).length > 0, command);
}));

test('a path split across quotes is one path', () => pathWorld((w) => {
  assert.deepEqual(w.outside('wc -c "/et""c/hosts"'), ['/etc/hosts']);
}));
