// --own over a clone whose AGENTS.md is a symlink (#132, REVIEW-3 N4): refused as it is without --own. The clone is removed
// and nothing is written; onboard used to replace the link, and the kit evidence then failed the mode change after the commit.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seeded } from './seed-world.mjs';

describe('bin/onboard with --own over a symlinked AGENTS.md', () => {
  test('refuses, removes the clone, and leaves the --own file as it was', () => {
    const s = seeded({ 'AGENTS.md': null, 'docs/rules.md': '# app\n\nrules\n', 'CLAUDE.md': '@AGENTS.md\n' }, { own: false, links: { 'AGENTS.md': 'docs/rules.md' } });
    try {
      const prepared = '# app\n\nprepared\n';
      writeFileSync(join(s.dir, 'prepared.md'), prepared);
      const out = s.onboard('--own', join(s.dir, 'prepared.md'));
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /AGENTS\.md is a link/);
      assert.ok(!existsSync(s.repo), 'the clone is removed');
      assert.equal(readFileSync(join(s.dir, 'prepared.md'), 'utf8'), prepared);
    } finally {
      s.cleanup();
    }
  });
});
