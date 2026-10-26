// The research eval's path check (#92, re-review 3, B1): a backslash outside single quotes makes its word unplaceable, so outside,
// whatever it escapes. The cost is accepted: an unquoted regex such as jiti\.import is an invalid run; the same regex in single
// quotes is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathWorld } from './research-eval-paths-world.mjs';

test('a backslash outside single quotes is outside', () => pathWorld((w) => {
  for (const command of [
    'wc -c \\/etc/hosts',
    'cat "\\/etc/hosts"',
    'wc -c /etc/ho\\sts',
    'grep -n jiti\\.import packages',
    'echo \\" ; wc -c "\\/etc/hosts"',
  ]) assert.ok(w.outside(command).length > 0, command);
}));

test('a backslash inside single quotes is text', () => pathWorld((w) => {
  assert.deepEqual(w.outside("grep -n 'jiti\\.import' packages"), []);
}));
