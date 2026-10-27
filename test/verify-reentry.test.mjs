// .gate/bin/verify reached again through gate_fast or the native verify (a hook or a repository verify that calls it)
// fails at once, naming the loop, instead of recursing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { script } from './helpers.mjs';
import { seeded } from './seed-world.mjs';

describe('.gate/bin/verify re-entry', () => {
  test('a pre-commit hook that calls .gate/bin/verify --fast, reached through gate_fast, fails with a message naming the loop', () => {
    const s = seeded();
    try {
      assert.equal(s.onboard().code, 0);
      // The hook stops its own recursion after three levels, so that without a guard this test ends rather than loops.
      writeFileSync(join(s.repo, '.githooks/pre-commit'), '#!/bin/sh\nn=${DEPTH:-0}\n[ "$n" -ge 3 ] && exit 0\nDEPTH=$((n + 1)) exec .gate/bin/verify --fast\n');
      const out = script(s.repo, 'verify', ['--fast']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /verify: fast failed/);
      assert.match(out.out, /loop/);
    } finally {
      s.cleanup();
    }
  });

  test('a repository verify that calls .gate/bin/verify, reached through native, fails with a message naming the loop', () => {
    const s = seeded();
    try {
      assert.equal(s.onboard().code, 0);
      writeFileSync(join(s.repo, 'scripts/verify'), '#!/bin/sh\nexec .gate/bin/verify --only tests\n');
      const out = script(s.repo, 'verify', ['--only', 'native']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /verify: native failed/);
      assert.match(out.out, /loop/);
    } finally {
      s.cleanup();
    }
  });

  test('prove-check, which runs verify on purpose, still passes', () => {
    const s = seeded();
    try {
      assert.equal(s.onboard().code, 0);
      const out = script(s.repo, 'prove-check', ['native']);
      assert.equal(out.code, 0, out.out);
    } finally {
      s.cleanup();
    }
  });
});
