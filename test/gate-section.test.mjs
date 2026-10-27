// The kit's canonical Gate block, .gate/gate-section.md (#132): the one file a repository's block is compared with. It is
// one well-formed block and nothing else, it fits the budget that leaves a repository room under 2a's 150 lines and
// 32 KiB, and every kit file the block names is in the kit.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const SECTION = join(factory, 'kit/.gate/gate-section.md');
const BEGIN = '<!-- factory:gate:begin -->';
const END = '<!-- factory:gate:end -->';

// The real block's shape and budget are checked once, by scripts/verify (instructions.mjs section); here only what it names.
describe('kit/.gate/gate-section.md', () => {
  test('every kit file the block names is a regular file in the kit', async () => {
    const { REQUIRED } = await lib();
    assert.ok(REQUIRED.length >= 7);
    for (const path of REQUIRED) assert.ok(statSync(join(factory, 'kit', path)).isFile(), path);
  });
});

describe('sectionProblems', () => {
  const block = `${BEGIN}\n## Gate\n\nbody\n${END}\n`;

  test('passes a block alone', async () => {
    const { sectionProblems } = await lib();
    assert.deepEqual(sectionProblems(block), []);
    assert.deepEqual(sectionProblems(block, { budget: true }), []);
  });

  test('fails text before it, text after it, a second block and a block with no end', async () => {
    const { sectionProblems } = await lib();
    for (const text of [`# App\n\n${block}`, `${block}\nrules\n`, `${block}${block}`, `${BEGIN}\nbody\n`, 'no block\n', '']) {
      assert.equal(sectionProblems(text).length, 1, JSON.stringify(text));
    }
  });

  test('fails a block over 26 lines or over 3072 bytes, only when asked for the budget', async () => {
    const { sectionProblems } = await lib();
    const long = `${BEGIN}\n${'line\n'.repeat(24)}${END}\n`;
    assert.deepEqual(sectionProblems(long, { budget: true }), []);
    const longer = `${BEGIN}\n${'line\n'.repeat(25)}${END}\n`;
    assert.deepEqual(sectionProblems(longer), []);
    assert.equal(sectionProblems(longer, { budget: true }).length, 1);
    const wide = `${BEGIN}\n${'x'.repeat(3100)}\n${END}\n`;
    assert.equal(sectionProblems(wide, { budget: true }).length, 1);
  });
});
