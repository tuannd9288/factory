// How CLAUDE.md reaches AGENTS.md (#132, K3): a regular file whose first line is exactly @AGENTS.md, with prose after it
// if the repository wants, or a Git symlink whose relative target is the root AGENTS.md. Entries are { mode, bytes } as
// git holds them (mode 120000: the bytes are the link's target).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const file = (text, mode = '100644') => ({ mode, bytes: Buffer.from(text) });
const link = (target) => ({ mode: '120000', bytes: Buffer.from(target) });

describe('carrierProblems: accepted', () => {
  test('a file that starts with the import, with or without a final newline, and one with an addendum', async () => {
    const { carrierProblems } = await lib();
    for (const text of ['@AGENTS.md\n', '@AGENTS.md', '@AGENTS.md\n\n## Claude only\nUse the plan mode.\n', '@AGENTS.md\n@docs/extra.md\n']) {
      assert.deepEqual(carrierProblems(file(text)), [], JSON.stringify(text));
    }
    assert.deepEqual(carrierProblems(file('@AGENTS.md\n', '100755')), []);
  });

  test('a relative symlink to the root AGENTS.md', async () => {
    const { carrierProblems } = await lib();
    assert.deepEqual(carrierProblems(link('AGENTS.md')), []);
    assert.deepEqual(carrierProblems(link('./AGENTS.md')), []);
  });
});

describe('carrierProblems: refused', () => {
  test('a missing CLAUDE.md', async () => {
    const { carrierProblems } = await lib();
    assert.match(carrierProblems(null).join('\n'), /CLAUDE\.md is missing/);
  });

  test('a file whose first line is not exactly the import', async () => {
    const { carrierProblems } = await lib();
    for (const text of ['AGENTS.md\n', '', '\n@AGENTS.md\n', '# Notes\n@AGENTS.md\n', '@agents.md\n', ' @AGENTS.md\n', '@AGENTS.md \n', '@AGENTS.md\r\n', 'See @AGENTS.md\n', '@AGENTS.md.bak\n']) {
      const out = carrierProblems(file(text));
      assert.equal(out.length, 1, JSON.stringify(text));
      assert.match(out[0], /first line/);
    }
  });

  test('a link that is absolute, leaves the repository, goes round, points elsewhere or is not one line', async () => {
    const { carrierProblems } = await lib();
    const refused = [
      ['/etc/AGENTS.md', /absolute/],
      ['/Users/x/app/AGENTS.md', /absolute/],
      ['../AGENTS.md', /leaves the repository|\.\./],
      ['../app/AGENTS.md', /leaves the repository|\.\./],
      ['a/../AGENTS.md', /\.\./],
      ['CLAUDE.md', /itself|cycle/],
      ['./CLAUDE.md', /itself|cycle/],
      ['docs/AGENTS.md', /AGENTS\.md at the root/],
      ['agents.md', /AGENTS\.md at the root/],
      ['AGENTS.md/', /AGENTS\.md at the root/],
      ['AGENTS.md\n', /one line/],
      ['', /empty/],
    ];
    for (const [target, why] of refused) {
      const out = carrierProblems(link(target));
      assert.equal(out.length, 1, JSON.stringify(target));
      assert.match(out[0], why, JSON.stringify(target));
    }
  });

  test('a directory, a submodule or any other kind of entry', async () => {
    const { carrierProblems } = await lib();
    assert.equal(carrierProblems({ mode: '040000', bytes: Buffer.alloc(0) }).length, 1);
    assert.equal(carrierProblems({ mode: '160000', bytes: Buffer.alloc(0) }).length, 1);
  });
});
