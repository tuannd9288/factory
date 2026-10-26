// The factory's own modules (#71) pass the check scripts/verify runs on them. That verify runs modules/*/test and refuses
// colliding modules is proved against a copy of the factory in verify-state.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factory, run } from './helpers.mjs';

test('the factory\'s own modules pass that check', () => {
  const names = ['deletion-proof'];
  const out = run(factory, 'node', ['bin/lib/module.mjs', 'check', '.', ...names]);
  assert.equal(out.code, 0, out.out);
});
