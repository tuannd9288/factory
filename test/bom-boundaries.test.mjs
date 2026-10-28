// A byte-order mark at the start of AGENTS.md is refused at the boundaries the real path uses (#132): bin/onboard on the
// clone's file and on an --own file, and .gate/bin/verify on a working tree. The unit test of insertGate
// (test/instructions-bom.test.mjs) proves the rule below those boundaries, where a decoder that strips a mark had hidden it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoWithKit, script } from './helpers.mjs';
import { seeded } from './seed-world.mjs';

const BOM = '﻿';

describe('a BOM at the start of AGENTS.md', () => {
  test('onboard refuses the clone\'s file, removes the clone and says why', () => {
    const s = seeded({ 'AGENTS.md': `${BOM}# app\n\nrules\n`, 'CLAUDE.md': '@AGENTS.md\n' }, { own: false });
    try {
      const out = s.onboard();
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /byte-order mark/);
      assert.ok(!existsSync(s.repo), 'the clone is removed');
    } finally {
      s.cleanup();
    }
  });

  test('onboard refuses an --own file that has one, before it clones, and leaves the file as it was', () => {
    const s = seeded({ 'AGENTS.md': '# app\n', 'CLAUDE.md': '@AGENTS.md\n' }, { own: false });
    try {
      const prepared = `${BOM}# app\n\nprepared\n`;
      writeFileSync(join(s.dir, 'bom.md'), prepared);
      const out = s.onboard('--own', join(s.dir, 'bom.md'));
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /byte-order mark/);
      assert.match(out.out, /nothing done/);
      assert.ok(!existsSync(s.repo));
      assert.equal(readFileSync(join(s.dir, 'bom.md'), 'utf8'), prepared);
    } finally {
      s.cleanup();
    }
  });

  test('verify refuses a working tree whose AGENTS.md has one, although the block and the limits are right', () => {
    const r = repoWithKit();
    try {
      const good = readFileSync(join(r.repo, 'AGENTS.md'), 'utf8');
      assert.equal(script(r.repo, 'verify', ['--only', 'instructions']).code, 0);
      writeFileSync(join(r.repo, 'AGENTS.md'), `${BOM}${good}`);
      const out = script(r.repo, 'verify', ['--only', 'instructions']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /byte-order mark/);
    } finally {
      r.cleanup();
    }
  });
});
