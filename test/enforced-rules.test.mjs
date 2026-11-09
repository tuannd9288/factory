// #94: the Gate block points every session at main's .gate/enforced-rules.md; the kit must lay it, and it must be a tier-3
// path, so a pull request cannot edit the rules it is held to below tier 3.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const FILE = '.gate/enforced-rules.md';

describe('the file the reviewer reads', () => {
  test('the kit holds it, not empty', () => {
    assert.ok(statSync(join(factory, 'kit', FILE)).size > 0);
  });

  test('it is under a protected pattern of the kit\'s .gate/protected, which makes a change to it tier 3', () => {
    const lines = readFileSync(join(factory, 'kit/.gate/protected'), 'utf8').split('\n');
    assert.ok(lines.includes('/.gate'));
  });
});
