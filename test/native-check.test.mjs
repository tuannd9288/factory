// The `native` check: a repository that keeps its own scripts/verify names it in GATE_NATIVE, and the kit's verify runs
// it as one of its checks, with a generic proof fixture; `verify --fast` runs gate_fast, which calls the repository's
// own pre-commit hook.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, git, repoWithKit, script, write } from './helpers.mjs';

const ADAPTER = '\nGATE_NATIVE=scripts/verify\nGATE_CHECKS="native"\ngate_fast() { .githooks/pre-commit; }\n';
const OWN_VERIFY = '#!/bin/sh\necho "own verify ran"\nexit 0\n';
const OWN_HOOK = '#!/bin/sh\necho "own hook ran" >&2\nexit 0\n';

describe('a repository with its own verify', () => {
  let r;
  before(() => {
    r = repoWithKit({
      '.gate/config.sh': readFileSync(join(factory, 'kit/.gate/config.sh'), 'utf8') + ADAPTER,
      'scripts/verify': OWN_VERIFY,
      '.githooks/pre-commit': OWN_HOOK,
    }, [], ['scripts/verify', '.githooks/pre-commit']);
  });
  after(() => r.cleanup());

  test('verify runs it among its checks and passes', () => {
    const out = script(r.repo, 'verify', ['--only', 'native']);
    assert.equal(out.code, 0, out.out);
  });

  test('a failing native verify fails verify, naming native and showing what it printed', () => {
    write(r.repo, { 'scripts/verify': '#!/bin/sh\necho "own verify says no"\nexit 1\n' });
    const out = script(r.repo, 'verify', ['--only', 'native']);
    git(r.repo, 'checkout', '-q', '--', 'scripts/verify');
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /verify: native failed/);
    assert.match(out.out, /own verify says no/);
  });

  test('prove-check shows the check failing with the kit\'s generic fixture', () => {
    const out = script(r.repo, 'prove-check', ['native']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /prove-check: 1 checks fail on their fixtures/);
  });

  test('verify --fast runs gate_fast, which is the repository\'s own pre-commit hook', () => {
    write(r.repo, { '.githooks/pre-commit': '#!/bin/sh\necho "own hook says no" >&2\nexit 1\n' });
    const out = script(r.repo, 'verify', ['--fast']);
    git(r.repo, 'checkout', '-q', '--', '.githooks/pre-commit');
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /verify: fast failed/);
    assert.match(out.out, /own hook says no/);
  });
});
