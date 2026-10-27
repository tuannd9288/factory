// `policy check --native <path>`: the repository's own verify is a gate input, so the path GATE_NATIVE names must be
// one .gate/protected lists (tier 3); otherwise a repository could keep its gate outside the Human's approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run, write } from './helpers.mjs';

const POLICY = join(factory, 'kit/.gate/bin/lib/policy.mjs');
const kit = (path) => readFileSync(join(factory, 'kit', path), 'utf8');

function check(args) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-native-'));
  try {
    write(dir, { '.gate/protected': kit('.gate/protected'), '.github/CODEOWNERS': kit('.github/CODEOWNERS') });
    return run(dir, 'node', [POLICY, 'check', '--rules', dir, ...args]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a native verify under a protected path passes', () => {
  const out = check(['--native', 'scripts/verify']);
  assert.equal(out.code, 0, out.out);
});

test('a native verify outside every protected path fails, naming it', () => {
  const out = check(['--native', 'tools/verify']);
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /tools\/verify/);
  assert.match(out.out, /GATE_NATIVE/);
});

test('with no native verify the check is the one it always was', () => {
  const out = check([]);
  assert.equal(out.code, 0, out.out);
});
