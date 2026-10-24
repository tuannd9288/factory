// scripts/verify against a throwaway copy of the factory that holds only scripts/verify and a few tests: a test that
// writes into a folder the environment names for state fails the run, and the caller's own folders stay untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const FOLDERS = ['FACTORY_STATE', 'AGENT_PROFILES', 'FACTORY_ROOT'];

// What bin/factory-queue, bin/onboard and the ledger would leave behind if a test let them use the folders they get.
const LEAK = String.raw`import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
test('forgets its own folders', () => {
  writeFileSync(join(process.env.FACTORY_STATE, 'queue-run.failed'), 'usage\n');
  mkdirSync(join(process.env.AGENT_PROFILES, 'o/app/claude'), { recursive: true });
  mkdirSync(join(process.env.FACTORY_ROOT, 'app'), { recursive: true });
  writeFileSync(join(process.env.FACTORY_ROOT, 'app/README.md'), '# app\n');
});
`;

function verify(tests) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-state-'));
  try {
    const copy = join(dir, 'factory');
    for (const [path, text] of Object.entries({
      'kit/AGENTS.md': '# kit\n',
      '.github/workflows/verify.yml': 'name: verify\n',
      'kit/.github/workflows/gate.yml': 'name: gate\n',
      'test/ok.test.mjs': "import { test } from 'node:test';\ntest('passes', () => {});\n",
      ...tests,
    })) {
      mkdirSync(join(copy, path, '..'), { recursive: true });
      writeFileSync(join(copy, path), text);
    }
    mkdirSync(join(copy, 'scripts'));
    copyFileSync(join(factory, 'scripts/verify'), join(copy, 'scripts/verify'));
    const caller = Object.fromEntries(FOLDERS.map((name) => [name, join(dir, 'caller', name)]));
    for (const path of Object.values(caller)) mkdirSync(path, { recursive: true });
    const { NODE_TEST_CONTEXT, GATE_BASE, GITHUB_EVENT_NAME, ...outer } = process.env;
    const r = spawnSync('bash', [join(copy, 'scripts/verify')], { encoding: 'utf8', env: { ...outer, ...caller } });
    const left = Object.values(caller).flatMap((path) => readdirSync(path, { recursive: true }));
    return { code: r.status, out: `${r.stdout}${r.stderr}`, left };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scripts/verify fails a run in which a test wrote into a state folder, and names what it wrote', () => {
  const r = verify({ 'test/leak.test.mjs': LEAK });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^verify: a test wrote outside its own folders/m);
  for (const path of ['FACTORY_STATE/queue-run.failed', 'AGENT_PROFILES/o/app/claude', 'FACTORY_ROOT/app/README.md'])
    assert.match(r.out, new RegExp(`^  ${path}$`, 'm'), r.out);
  assert.deepEqual(r.left, [], 'the run wrote into the folders its caller named');
});

test('scripts/verify passes a run in which no test wrote into a state folder', () => {
  const r = verify({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^verify: 1 tests passed/m);
  assert.deepEqual(r.left, []);
});
