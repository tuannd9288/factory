// The one change a module makes to the kit's red-check (#71): where scripts/lib/deletion.mjs exists, a source change with
// no test goes to it first. And the proof that off is off: a repository without the module gets main's verdicts, byte for
// byte (main's red-check and prove-check are kept in test/fixtures, as e65c3c8 had them), calls neither the module's
// script nor npx, and its prove-check --all runs main's fixtures and no others.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, factory, git, quiet, repoWithKit, run, script } from './helpers.mjs';

const RED_AT_BASE =
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/math.js';\n\ntest('multiplies', () => {\n  assert.equal(m.mul(2, 3), 6);\n});\n";
const MUL = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n';
const KEPT = (line) =>
  `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\n${line}\ntest('adds two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n`;
const PROOF = '// gate-allow test-deleted: test/math.test.js; kept: test/add.test.js "adds two numbers"; red: src/math.js "a + b" -> "a - b"';
const fixture = (name) => join(factory, 'test/fixtures', name);

/** Main's version of a script, outside the repository (the scripts find scripts/lib relative to where they run). */
const placeMain = (dir, name) => {
  copyFileSync(fixture(`${name}.main`), join(dir, `${name}-main`));
  chmodSync(join(dir, `${name}-main`), 0o755);
  return (repo, args, env = {}) => run(repo, join(dir, `${name}-main`), args, { ...quiet, ...env });
};

describe('off is off: a repository without the module gets main\'s red-check verdicts', () => {
  let r;
  let bin;
  let log;
  let mainRedCheck;
  before(() => {
    r = repoWithKit({ 'src/old.js': 'export const old = 1;\n' });
    mainRedCheck = placeMain(r.dir, 'red-check');
    // A fake node that passes everything through but records it and refuses the module's script, and a fake npx that
    // refuses to run at all. red-check needs node for its own helpers, so a node that fails on every call cannot be used.
    bin = join(r.dir, 'fake-bin');
    log = join(r.dir, 'calls.log');
    mkdirSync(bin);
    const real = process.execPath;
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "node $*" >>"${log}"\ncase "$*" in *deletion.mjs*) echo "fake node: the module's script was called" >&2; exit 99;; esac\nexec "${real}" "$@"\n`);
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "npx $*" >>"${log}"\necho "fake npx: called" >&2\nexit 99\n`);
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'npx'), 0o755);
  });
  after(() => r.cleanup());

  const branch = (name, files) => {
    git(r.repo, 'switch', '-q', '-C', name, 'origin/main');
    commit(r.repo, files, name);
  };
  const both = (extra = [], env = {}) => {
    rmSync(log, { force: true });
    const ours = script(r.repo, 'red-check', ['--base', 'origin/main', ...extra], env);
    const main = mainRedCheck(r.repo, ['--base', 'origin/main', ...extra], env);
    return { ours, main };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');

  const SCENARIOS = {
    'no source change': () => ({ files: { 'README.md': '# app\n\nMore words.\n' } }),
    'a test red at the base and green at the head': () => ({ files: { 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE } }),
    'a test that already passes at the base': () => ({ files: { 'src/math.js': MUL, 'test/add2.test.js': RED_AT_BASE.replace('m.mul(2, 3), 6', 'm.add(2, 4), 6') } }),
    'a test that selects no test': () => ({ files: { 'src/math.js': MUL, 'test/empty.test.js': "import { test } from 'node:test';\n" } }),
    'a source change with no test': () => ({ files: { 'src/math.js': MUL } }),
    'a deleted source file with no test': () => ({ files: { 'src/old.js': null } }),
    'a source change with a short No-red': () => ({ files: { 'src/math.js': MUL }, body: 'No-red: refactor\n' }),
    'a source change with a No-red reason': () => ({ files: { 'src/math.js': MUL }, body: 'Summary\nNo-red: adds a helper nothing calls yet\n' }),
    'a dropped test with its proof': () => ({ files: { 'test/math.test.js': null, 'test/add.test.js': KEPT(PROOF) } }),
    'tests that do not pass at the head': () => ({ files: { 'src/math.js': MUL.replace('a * b', 'a + b'), 'test/mul.test.js': RED_AT_BASE } }),
  };
  for (const [name, make] of Object.entries(SCENARIOS)) {
    test(`${name}: the same exit and the same words as main's red-check, and no module script, no npx`, () => {
      const { files, body } = make();
      branch(`s-${name.replace(/\W+/g, '-')}`, files);
      const args = [];
      if (body !== undefined) {
        writeFileSync(join(r.dir, 'body.txt'), body);
        args.push('--body', join(r.dir, 'body.txt'));
      }
      const { ours, main } = both(args, { PATH: `${bin}:${process.env.PATH}` });
      assert.equal(ours.code, main.code, `${ours.out}\n---\n${main.out}`);
      assert.equal(ours.out, main.out);
      assert.doesNotMatch(calls(), /deletion\.mjs|^npx /m);
      assert.doesNotMatch(ours.out, /fake (node|npx)/);
    });
  }

  test('a source change with no test prints main\'s exact lines and exits 1, with the fake node and npx first on PATH', () => {
    branch('exact', { 'src/math.js': MUL });
    const { ours } = both([], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(ours.code, 1);
    assert.equal(
      ours.out,
      "red-check: source changed with no new or changed test:\n  src/math.js\nAdd a test that fails without the change, or give the PR body a line 'No-red: <why no test can fail first>'.\n",
    );
    assert.doesNotMatch(calls(), /deletion\.mjs|^npx /m);
  });

  test('prove-check --all says what main\'s says, and runs the same checks', () => {
    const mainProveCheck = placeMain(r.dir, 'prove-check');
    git(r.repo, 'switch', '-q', 'work');
    const ours = script(r.repo, 'prove-check', ['--all']);
    const main = mainProveCheck(r.repo, ['--all']);
    assert.equal(ours.code, 0, ours.out);
    assert.equal(ours.out, main.out);
    assert.equal(ours.out, 'prove-check: 7 checks fail on their fixtures\n');
  });
});

describe('prove-check --all with a red-check-* fixture on disk', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());
  const GOOD = '# Proof: a source change with no test fails red-check.\n# Run: scripts/red-check --base HEAD~1\n# Says: source changed with no new or changed test\nmkdir -p src\necho "export const z = 1;" >src/z.js\ngit add -A\ngit commit -qm z\n';
  const BAD = GOOD.replace('# Run: scripts/red-check --base HEAD~1', '# Run: true');

  test('runs it with the others, and counts it', () => {
    commit(r.repo, { '.gate/proofs/red-check-demo.sh': GOOD }, 'a fixture a module lays');
    const out = script(r.repo, 'prove-check', ['--all']);
    assert.equal(out.code, 0, out.out);
    assert.equal(out.out, 'prove-check: 8 checks fail on their fixtures\n');
  });
  test('fails when such a fixture does not fail its check', () => {
    commit(r.repo, { '.gate/proofs/red-check-bad.sh': BAD }, 'a fixture that proves nothing');
    const out = script(r.repo, 'prove-check', ['--all']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /prove-check: red-check-bad PASSED its fixture/);
    assert.match(out.out, /prove-check: not proved: red-check-bad$/m);
  });
  test('runs a .patch fixture too, and never one that is not red-check-*', () => {
    commit(r.repo, { '.gate/proofs/red-check-bad.sh': null, '.gate/proofs/other-demo.sh': BAD }, 'only a stranger');
    const out = script(r.repo, 'prove-check', ['--all']);
    assert.equal(out.code, 0, out.out);
    assert.equal(out.out, 'prove-check: 8 checks fail on their fixtures\n');
  });
});

describe('the red-check hook', () => {
  let r;
  let log;
  before(() => {
    r = repoWithKit({ 'src/old.js': 'export const old = 1;\n', 'src/gone.js': 'export const gone = 1;\n' });
    log = join(r.dir, 'module.log');
    // The stand-in is never committed: a script outside .gate/kit-files would be a source change of its own.
    appendFileSync(join(r.repo, '.git/info/exclude'), '.gate/bin/lib/deletion.mjs\n');
  });
  after(() => r.cleanup());

  /** A stand-in for the module's script, untracked: it logs its arguments and the sources file, then says and exits. */
  const stub = (code, lines = []) => {
    mkdirSync(join(r.repo, 'scripts/lib'), { recursive: true });
    writeFileSync(
      join(r.repo, '.gate/bin/lib/deletion.mjs'),
      `import { appendFileSync, readFileSync } from 'node:fs';\nconst a = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, sources: readFileSync(a[a.indexOf('--sources') + 1], 'utf8') }) + '\\n');\nfor (const l of ${JSON.stringify(lines)}) console.log(l);\nprocess.exit(${code});\n`,
    );
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const redCheck = (name, files, body) => {
    git(r.repo, 'switch', '-q', '-C', name, 'origin/main');
    commit(r.repo, files, name);
    const args = ['--base', 'origin/main'];
    if (body !== undefined) {
      writeFileSync(join(r.dir, 'body.txt'), body);
      args.push('--body', join(r.dir, 'body.txt'));
    }
    return script(r.repo, 'red-check', args);
  };
  after(() => rmSync(join(r.repo, '.gate/bin/lib/deletion.mjs'), { force: true }));

  test('runs the module\'s script on a source change with no test, with the base, the sources and a work folder', () => {
    rmSync(log, { force: true });
    stub(0, ['red-check: passed by the stub']);
    const out = redCheck('hook-pass', { 'src/old.js': null, 'src/gone.js': null });
    assert.equal(out.code, 0, out.out);
    assert.equal(out.out, 'red-check: passed by the stub\n');
    const [call] = calls();
    assert.equal(calls().length, 1);
    assert.deepEqual(call.args.filter((a) => a === 'prove' || a.startsWith('--')), ['prove', '--base', '--sources', '--work']);
    assert.equal(call.args[2], git(r.repo, 'rev-parse', 'origin/main'));
    assert.equal(call.sources, 'src/gone.js\nsrc/old.js\n');
  });
  test('prints source changed, the source paths, the script\'s reasons and the hint when it exits 1', () => {
    rmSync(log, { force: true });
    stub(1, ['red-check: not a pure deletion: check 1: src/old.js is modified']);
    const out = redCheck('hook-refuse', { 'src/old.js': 'export const old = 2;\n' });
    assert.equal(out.code, 1, out.out);
    assert.equal(
      out.out,
      "red-check: source changed with no new or changed test:\n  src/old.js\nred-check: not a pure deletion: check 1: src/old.js is modified\nAdd a test that fails without the change, or give the PR body a line 'No-red: <why no test can fail first>'.\n",
    );
  });
  test('exits 2 when it exits 2, with the sources and its words, and no hint', () => {
    rmSync(log, { force: true });
    stub(2, ['red-check: could not search the head']);
    const out = redCheck('hook-error', { 'src/old.js': null });
    assert.equal(out.code, 2, out.out);
    assert.equal(out.out, 'red-check: source changed with no new or changed test:\n  src/old.js\nred-check: could not search the head\n');
  });
  test('is not asked when there is a test, a No-red line or no source change', () => {
    rmSync(log, { force: true });
    stub(0, ['red-check: passed by the stub']);
    let out = redCheck('hook-test', { 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE });
    assert.match(out.out, /red at the base/);
    out = redCheck('hook-no-red', { 'src/old.js': null }, 'No-red: removes a file nothing uses at all\n');
    assert.match(out.out, /passed by the PR body's No-red/);
    out = redCheck('hook-docs', { 'README.md': '# app\n\nMore.\n' });
    assert.match(out.out, /no source change/);
    assert.deepEqual(calls(), []);
  });
});
