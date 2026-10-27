// scripts/verify against a throwaway copy of the factory that holds only scripts/verify and a few tests: a test that
// writes into a folder the environment names for state fails the run, and the caller's own folders stay untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git } from './helpers.mjs';

const GOOD_SECTION = '<!-- factory:gate:begin -->\n## Gate\n<!-- factory:gate:end -->\n';
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

// `setup(copy)` may prepare the copy (a git history) and return environment variables for the run.
function verify(tests, setup = null) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-state-'));
  try {
    const copy = join(dir, 'factory');
    for (const [path, text] of Object.entries({
      'kit/.gate/gate-section.md': GOOD_SECTION,
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
    // The check of the kit's Gate block runs the library the kit's own verify runs.
    mkdirSync(join(copy, 'kit/.gate/bin/lib'), { recursive: true });
    copyFileSync(join(factory, 'kit/.gate/bin/lib/instructions.mjs'), join(copy, 'kit/.gate/bin/lib/instructions.mjs'));
    mkdirSync(join(copy, 'bin/lib'), { recursive: true });
    // The modules check (bin/lib/module.mjs) runs once a modules/ folder exists, and reads the kit tree through evidence.mjs, which imports adapter.mjs and settings.mjs.
    for (const lib of ['pack.mjs', 'own.mjs', 'module.mjs', 'evidence.mjs', 'adapter.mjs', 'settings.mjs']) copyFileSync(join(factory, 'bin/lib', lib), join(copy, 'bin/lib', lib));
    const caller = Object.fromEntries(FOLDERS.map((name) => [name, join(dir, 'caller', name)]));
    for (const path of Object.values(caller)) mkdirSync(path, { recursive: true });
    const { NODE_TEST_CONTEXT, GATE_BASE, GITHUB_EVENT_NAME, ...outer } = process.env;
    const extra = setup ? setup(copy) : {};
    const r = spawnSync('bash', [join(copy, 'scripts/verify')], { encoding: 'utf8', env: { ...outer, ...caller, ...extra } });
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

// Found by #46's review: direnv, which bin/onboard runs, records each folder it allows under XDG_DATA_HOME
// (~/.local/share/direnv/allow by default), and a test can also remove a folder it was given.
const DIRENV = String.raw`import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
test('allows a folder the way direnv allow does', () => {
  mkdirSync(join(process.env.XDG_DATA_HOME, 'direnv/allow'), { recursive: true });
  writeFileSync(join(process.env.XDG_DATA_HOME, 'direnv/allow/0123abcd'), '/tmp/factory-own-x/root/app/.envrc\n');
});
`;
const REMOVES = String.raw`import { test } from 'node:test';
import { rmSync } from 'node:fs';
test('removes the state folder it was given', () => {
  rmSync(process.env.FACTORY_STATE, { recursive: true });
});
`;

test('scripts/verify fails a run in which a test wrote into XDG_DATA_HOME, where direnv allow records a folder', () => {
  const caller = mkdtempSync(join(tmpdir(), 'verify-xdg-'));
  const was = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = caller;
  try {
    const r = verify({ 'test/direnv.test.mjs': DIRENV });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^ {2}XDG_DATA_HOME\/direnv\/allow\/0123abcd$/m);
    assert.deepEqual(readdirSync(caller), [], 'the run wrote into the XDG_DATA_HOME its caller named');
  } finally {
    if (was === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = was;
    rmSync(caller, { recursive: true, force: true });
  }
});

test('scripts/verify fails a run in which a test removed a state folder it was given', () => {
  const r = verify({ 'test/removes.test.mjs': REMOVES });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^verify: a test removed or replaced the FACTORY_STATE folder it was given$/m);
});

// What scripts/verify runs and checks beyond the state folders: the tests of modules and packs, the modules together
// (#71), and the line cap on each composed AGENTS.md (#7).
const FAILS = (what) => `import { test } from 'node:test';\ntest('${what}', () => { throw new Error('${what}'); });\n`;

test('scripts/verify runs the tests under modules/*/test: a failing one fails the run', () => {
  const r = verify({ 'modules/x/test/x.test.mjs': FAILS('a module test ran') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a module test ran/);
  assert.match(r.out, /the kit's tests failed/);
});

test('scripts/verify runs the tests under packs/*/test: a failing one fails the run', () => {
  const pack = { 'kit/AGENTS.md': '# kit\n\n## What the Human keeps\n\n- x\n', 'packs/x/AGENTS.md': '## X\n\nA rule.\n\n', 'packs/x/settings.json': '{}\n' };
  const r = verify({ ...pack, 'packs/x/test/x.test.mjs': FAILS('a pack test ran') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a pack test ran/);
  assert.equal(verify(pack).code, 0, 'the same pack with no failing test passes');
});

test('scripts/verify checks the modules together: two that lay one path fail the run, naming the path', () => {
  const r = verify({ 'modules/a/kit/x.txt': 'a\n', 'modules/b/kit/x.txt': 'b\n' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^verify: modules: x\.txt: module b lays it, and module a already does$/m);
  assert.equal(verify({ 'modules/a/kit/x.txt': 'a\n', 'modules/b/kit/y.txt': 'b\n' }).code, 0, 'modules that lay different paths pass');
});

test('scripts/verify fails a kit Gate block over its budget of 26 lines, and passes one of exactly 26', () => {
  const block = (n) => `<!-- factory:gate:begin -->\n${'x\n'.repeat(n - 2)}<!-- factory:gate:end -->\n`;
  const r = verify({ 'kit/.gate/gate-section.md': block(27) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^verify: kit\/\.gate\/gate-section\.md: .*27 lines/m);
  assert.equal(verify({ 'kit/.gate/gate-section.md': block(26) }).code, 0);
});

test('scripts/verify checks the subject of every commit since GATE_BASE: a bad one fails the run, a good one passes', () => {
  const tests = { 'kit/.gate/bin/lib/subject.mjs': readFileSync(join(factory, 'kit/.gate/bin/lib/subject.mjs'), 'utf8') };
  const from = (subject) => (copy) => {
    git(copy, 'init', '-q', '-b', 'main');
    const start = commit(copy, {}, 'Start');
    commit(copy, { 'change.txt': 'x\n' }, subject);
    return { GATE_BASE: start };
  };
  const bad = verify(tests, from('WIP'));
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /^verify: a commit subject breaks a rule$/m);
  const good = verify(tests, from('Say what the change does'));
  assert.equal(good.code, 0, good.out);
});
