// bin/onboard over a repository with its own verify and hooks: they stay byte for byte, the adapter lines go at the end
// of .gate/config.sh, and the full verify runs the repository's own verify as the native check.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, git, script } from './helpers.mjs';
import { ADAPTER, OWN_VERIFY, PRE_COMMIT, PRE_PUSH, SIZE, seeded } from './seed-world.mjs';

const KIT_CONFIG = readFileSync(join(factory, 'kit/.gate/config.sh'), 'utf8');

describe('bin/onboard over a repository with its own verify', () => {
  test("keeps its scripts/ and .githooks/ byte for byte, with their modes, and out of the kit's inventory", () => {
    const s = seeded();
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      for (const [path, text] of Object.entries({ 'scripts/verify': OWN_VERIFY, 'scripts/size.mjs': SIZE, '.githooks/pre-commit': PRE_COMMIT, '.githooks/pre-push': PRE_PUSH })) {
        assert.equal(s.read(path), text, path);
        assert.equal(git(s.repo, 'diff', '--name-only', 'main', 'factory/kit', '--', path), '', `${path} changed`);
        assert.equal(statSync(join(s.repo, path)).mode & 0o111, path === 'scripts/size.mjs' ? 0 : 0o111, `${path} mode`);
      }
      const inventory = s.read('.gate/kit-files').split('\n');
      assert.ok(!inventory.includes('scripts/verify') && inventory.includes('.gate/bin/verify'), inventory.join('\n'));
    } finally {
      s.cleanup();
    }
  });

  test('ends .gate/config.sh with the adapter lines, and its full verify runs the repository\'s own verify as native', () => {
    const s = seeded();
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(s.read('.gate/config.sh'), KIT_CONFIG + ADAPTER);
      assert.equal(s.mark(), 'ran\n', 'the repository\'s own scripts/verify did not run once during onboard');
      // The tests keep their per-file report: one named file runs alone and the report names it.
      const tests = script(s.repo, 'verify', ['--tests', 'test/math.test.js']);
      assert.equal(tests.code, 0, tests.out);
      const report = readFileSync(join(s.repo, '.gate/report.xml'), 'utf8');
      assert.match(report, /math\.test\.js/);
    } finally {
      s.cleanup();
    }
  });

  test('writes no adapter without a scripts/verify, none for a hook that calls .gate/bin/verify, and keeps its own config', () => {
    let s = seeded({ 'scripts/verify': null, 'scripts/size.mjs': null });
    try {
      assert.equal(s.onboard().code, 0);
      assert.equal(s.read('.gate/config.sh'), KIT_CONFIG);
    } finally {
      s.cleanup();
    }
    s = seeded({ '.githooks/pre-commit': '#!/bin/sh\nexec .gate/bin/verify --fast\n' });
    try {
      assert.equal(s.onboard().code, 0);
      assert.equal(s.read('.gate/config.sh'), KIT_CONFIG + ADAPTER.replace('gate_fast() { .githooks/pre-commit; }\n', ''));
    } finally {
      s.cleanup();
    }
    const own = `${KIT_CONFIG}# ours\n`;
    s = seeded({ '.gate/config.sh': own });
    try {
      assert.equal(s.onboard().code, 0);
      assert.equal(s.read('.gate/config.sh'), own);
    } finally {
      s.cleanup();
    }
  });

  test('adds native to the checks the config already names, so both run', () => {
    const s = seeded();
    try {
      assert.equal(s.onboard().code, 0);
      // A later session fills the kit's own line above the adapter block and defines the check.
      const config = s.read('.gate/config.sh').replace('GATE_CHECKS=""', 'GATE_CHECKS="lint"');
      writeFileSync(join(s.repo, '.gate/config.sh'), `${config}check_lint() { true; }\n`);
      for (const check of ['lint', 'native']) {
        const out = script(s.repo, 'verify', ['--only', check]);
        assert.equal(out.code, 0, `${check}: ${out.out}`);
      }
    } finally {
      s.cleanup();
    }
  });
});
