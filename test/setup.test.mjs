// .gate/bin/setup: points git at the kit's hooks only where the repository has none of its own, and makes a checkout
// ready to test in CI.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, git, run, write } from './helpers.mjs';

const SETUP = readFileSync(join(factory, 'kit/.gate/bin/setup'), 'utf8');

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { '.gate/bin/setup': SETUP, '.gate/config.sh': 'gate_prepare() { echo "prepared $1" >"$1/prepared"; }\n', ...files });
  chmodSync(join(dir, '.gate/bin/setup'), 0o755);
  return { dir, setup: (args = []) => run(dir, join(dir, '.gate/bin/setup'), args), hooks: () => run(dir, 'git', ['config', '--local', '--get', 'core.hooksPath']).out.trim(), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('.gate/bin/setup', () => {
  test('a repository with no hooks of its own gets the kit\'s', () => {
    const r = repo({});
    try {
      assert.equal(r.setup().code, 0);
      assert.equal(r.hooks(), '.gate/hooks');
    } finally {
      r.done();
    }
  });

  test('a repository with its own .githooks keeps them: the hooks path is left as it is', () => {
    const r = repo({ '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' });
    try {
      assert.equal(r.setup().code, 0);
      assert.equal(r.hooks(), '');
      git(r.dir, 'config', 'core.hooksPath', '.githooks');
      assert.equal(r.setup().code, 0);
      assert.equal(r.hooks(), '.githooks');
    } finally {
      r.done();
    }
  });

  test('a hooks path somebody set is left alone', () => {
    const r = repo({});
    try {
      git(r.dir, 'config', 'core.hooksPath', 'tools/hooks');
      assert.equal(r.setup().code, 0);
      assert.equal(r.hooks(), 'tools/hooks');
    } finally {
      r.done();
    }
  });

  test('--ci runs gate_prepare on the checkout', () => {
    const r = repo({});
    try {
      assert.equal(r.setup(['--ci']).code, 0);
      assert.match(readFileSync(join(r.dir, 'prepared'), 'utf8'), /prepared /);
    } finally {
      r.done();
    }
  });
});
