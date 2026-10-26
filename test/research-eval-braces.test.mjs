// The research eval's path check (#92, re-review 3, B1): a brace outside single quotes (brace expansion, `{ ...; }`) makes its word
// unplaceable, so outside. Braces inside single quotes are text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathWorld } from './research-eval-paths-world.mjs';

test('a brace outside single quotes is outside', () => pathWorld((w) => {
  for (const command of [
    'wc -c {/etc/hosts,}',
    'wc -c /etc/{hosts,passwd}',
    'cat "{a}"',
    '{ echo x; }',
    'ls x}',
  ]) assert.ok(w.outside(command).length > 0, command);
}));

test('a brace inside single quotes is text', () => pathWorld((w) => {
  assert.deepEqual(w.outside("awk '{print}' notes.txt; grep -n 'a{2}' notes.txt"), []);
}));
