// The size of the composed root AGENTS.md (#132, 2a): at most 150 lines and 32 KiB of UTF-8. A line counts without its
// final newline; a rejected file is only reported, never cut.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');

describe('countLines', () => {
  test('counts the last line whether or not a newline ends it', async () => {
    const { countLines } = await lib();
    assert.deepEqual(['', 'a', 'a\n', 'a\nb', 'a\n\n', '\n'].map(countLines), [0, 1, 1, 2, 2, 1]);
  });
});

describe('sizeProblems', () => {
  test('passes exactly 150 lines, with or without the final newline, and fails the 151st', async () => {
    const { sizeProblems } = await lib();
    assert.deepEqual(sizeProblems('x\n'.repeat(150)), []);
    assert.deepEqual(sizeProblems(`${'x\n'.repeat(149)}x`), []);
    assert.equal(sizeProblems('x\n'.repeat(151)).length, 1);
    assert.equal(sizeProblems(`${'x\n'.repeat(150)}x`).length, 1);
  });

  test('passes exactly 32768 bytes and fails 32769, counting UTF-8 bytes and not characters', async () => {
    const { sizeProblems } = await lib();
    assert.deepEqual(sizeProblems(`${'a'.repeat(32767)}\n`), []);
    assert.equal(sizeProblems(`${'a'.repeat(32768)}\n`).length, 1);
    assert.deepEqual(sizeProblems('é'.repeat(16384)), []);
    assert.equal(sizeProblems('é'.repeat(16385)).length, 1);
    assert.deepEqual(sizeProblems(Buffer.from('é'.repeat(16384))), []);
  });

  test('reports the lines and the bytes together, so the repository sees which limit it broke', async () => {
    const { sizeProblems } = await lib();
    const [over] = sizeProblems('x'.repeat(100).concat('\n').repeat(400));
    assert.match(over, /AGENTS\.md has 400 lines \(at most 150\) and 40400 bytes \(at most 32768\)/);
    const [onlyLines] = sizeProblems('x\n'.repeat(151));
    assert.match(onlyLines, /has 151 lines \(at most 150\) and 302 bytes \(at most 32768\)/);
  });

  test('says the kit does not shorten the file', async () => {
    const { sizeProblems } = await lib();
    assert.match(sizeProblems('x\n'.repeat(151))[0], /the repository does/);
  });
});
