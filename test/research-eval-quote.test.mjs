// The research eval's path check (#92, re-review 3, B1): a Bash command is read quote by quote. Single-quoted text is literal and is
// checked as written: a single-quoted path outside is invalid, and a single-quoted regex that holds a backslash and a "$" is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathWorld } from './research-eval-paths-world.mjs';

test('single-quoted text is checked as written: a path outside is invalid; a regex with a backslash and a "$" is valid', () => pathWorld((w) => {
  assert.deepEqual(w.outside("cat '/etc/hosts'"), ['/etc/hosts']);
  assert.deepEqual(w.outside(`git -C ${w.readable} grep -n 'x$HOME\\.y|a\\\\b$' -- packages`), []);
}));

test('a path split across quotes is one path', () => pathWorld((w) => {
  assert.deepEqual(w.outside('wc -c "/et""c/hosts"'), ['/etc/hosts']);
}));
