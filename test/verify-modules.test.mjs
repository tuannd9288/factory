// The factory's own scripts/verify covers modules (#71): it runs modules/*/test, and refuses a set of modules whose files
// collide with the kit's or with each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const verify = readFileSync(join(factory, 'scripts/verify'), 'utf8');

test('scripts/verify runs the tests of every module beside the kit\'s and the packs\'', () => {
  assert.match(verify, /'modules\/\*\/test\/\*\.test\.mjs'/);
});

test('scripts/verify checks all the modules together for a path two of them, or a module and the kit, lay', () => {
  assert.match(verify, /node bin\/lib\/module\.mjs check \. \$\(ls modules\)/);
});

test('the factory\'s own modules pass that check', () => {
  const names = ['deletion-proof'];
  const out = run(factory, 'node', ['bin/lib/module.mjs', 'check', '.', ...names]);
  assert.equal(out.code, 0, out.out);
});
