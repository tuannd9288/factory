// The kit's checks, each shown failing on a bad input and passing on a good one.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { APP, commit, factory, git, quiet, repoWithKit, run, script, write } from './helpers.mjs';

const RED_AT_BASE =
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/math.js';\n\ntest('multiplies', () => {\n  assert.equal(m.mul(2, 3), 6);\n});\n";
const MUL = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n';

// A test kept in the place of test/math.test.js, and the proof that lets a change drop that file: the kept test, and
// a break of the code that turns it red (kit AGENTS.md, Hand-in rule exceptions).
const KEPT = (line) =>
  `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\n${line}\ntest('adds two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n`;
const PROOF = '// gate-allow test-deleted: test/math.test.js; kept: test/add.test.js "adds two numbers"; red: src/math.js "a + b" -> "a - b"';
// test/math.test.js with its one assertion turned into a plain check, and the proof for it.
const WEAKENED = (line) =>
  `import { test } from 'node:test';\nimport { add } from '../src/math.js';\n\n${line}\ntest('adds', () => {\n  if (add(2, 3) !== 5) throw new Error('add');\n});\n`;
const LOST = '// gate-allow assertions-removed: test/math.test.js; kept: test/math.test.js "adds"; red: src/math.js "a + b" -> "a - b"';

describe('rules', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());

  test('blocks a focused test', () => {
    write(r.repo, { 'test/focus.test.js': "import { test } from 'node:test';\ntest.only('x', () => {});\n" });
    const out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /test-focused \(block\)/);
    write(r.repo, { 'test/focus.test.js': null });
  });

  test('reads code, not strings: .only( inside a string passes', () => {
    write(r.repo, { 'src/doc.js': "export const tip = 'never leave test.only( in a test';\n" });
    const out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    write(r.repo, { 'src/doc.js': null });
  });

  test('blocks a deleted test file and lost assertions', () => {
    git(r.repo, 'rm', '-q', 'test/math.test.js');
    let out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /test-deleted/);
    git(r.repo, 'checkout', '-q', 'HEAD', '--', 'test/math.test.js');
    write(r.repo, { 'test/math.test.js': readFileSync(join(r.repo, 'test/math.test.js'), 'utf8').replace('  assert.equal(add(2, 3), 5);\n', '') });
    out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /assertions-removed/);
    git(r.repo, 'checkout', '-q', 'HEAD', '--', 'test/math.test.js');
  });

  test('blocks a high-entropy secret, not a placeholder', () => {
    write(r.repo, { 'src/key.js': "export const apiKey = 'Zq8LmV2xR7pT4wK9sB3n';\n" });
    let out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /hardcoded-secret/);
    assert.doesNotMatch(out.out, /Zq8LmV2xR7pT4wK9sB3n/);
    write(r.repo, { 'src/key.js': "export const apiKey = 'your-api-key-here-xx';\n" });
    out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    write(r.repo, { 'src/key.js': null });
  });

  test('a gate-allow comment with a reason allows one line', () => {
    write(r.repo, { 'test/skip.test.js': "import { test } from 'node:test';\ntest.skip('x', () => {}); // gate-allow test-skipped: waits for the upstream fix in #12\n" });
    let out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /\(allowed\)/);
    write(r.repo, { 'test/skip.test.js': "import { test } from 'node:test';\ntest.skip('x', () => {}); // gate-allow test-skipped: later\n" });
    out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    write(r.repo, { 'test/skip.test.js': null });
  });

  test("allows a deleted test only with the proof: the test kept in its place and a break that turns it red", () => {
    try {
      git(r.repo, 'rm', '-q', 'test/math.test.js');
      // The Human's case: a gate-allow with a reason and no proof stays blocking.
      write(r.repo, { 'test/add.test.js': KEPT('// gate-allow test-deleted: test/add.test.js covers addition from now on') });
      let out = script(r.repo, 'rules', ['--base', 'origin/main']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /test-deleted \(block\) .*kept: <test file> "<test name>"; red: <source file> "<from>" -> "<to>"/);
      write(r.repo, { 'test/add.test.js': KEPT(PROOF) });
      out = script(r.repo, 'rules', ['--base', 'origin/main']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /test\/math\.test\.js:0: test-deleted \(allowed\)/);
      // The pre-commit hook reads the index: the proof holds there too.
      git(r.repo, 'add', '-A');
      out = script(r.repo, 'rules', ['--staged']);
      assert.equal(out.code, 0, out.out);
      // A proof whose kept test is not in its file, or whose break edits a test, or whose text is not in the code.
      for (const [bad, why] of [
        [PROOF.replace('"adds two numbers"', '"subtracts"'), /test\/add\.test\.js does not hold the test "subtracts"/],
        [PROOF.replace('red: src/math.js', 'red: test/add.test.js'), /the break edits test\/add\.test\.js, a test/],
        [PROOF.replace('"a + b"', '"a * b"'), /src\/math\.js holds "a \* b" 0 times, not once/],
        [PROOF.replace('kept: test/add.test.js', 'kept: test/math.test.js'), /the kept test is the one dropped/],
      ]) {
        write(r.repo, { 'test/add.test.js': KEPT(bad) });
        out = script(r.repo, 'rules', ['--base', 'origin/main']);
        assert.equal(out.code, 1, out.out);
        assert.match(out.out, why);
      }
    } finally {
      git(r.repo, 'reset', '-q', '--hard', 'HEAD');
      write(r.repo, { 'test/add.test.js': null });
    }
  });

  test('allows lost assertions only with the same proof', () => {
    try {
      write(r.repo, { 'test/math.test.js': WEAKENED('// gate-allow assertions-removed: the plain check says the same thing') });
      let out = script(r.repo, 'rules', ['--base', 'origin/main']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /assertions-removed \(block\)/);
      write(r.repo, { 'test/math.test.js': WEAKENED(LOST) });
      out = script(r.repo, 'rules', ['--base', 'origin/main']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /test\/math\.test\.js:0: assertions-removed \(allowed\)/);
    } finally {
      git(r.repo, 'checkout', '-q', 'HEAD', '--', 'test/math.test.js');
    }
  });

  test('blocks an edit to a line a Failing-test commit added', () => {
    git(r.repo, 'switch', '-q', '-c', 'ft');
    commit(r.repo, { 'test/mul.test.js': RED_AT_BASE }, 'Add the failing multiply test\n\nFailing-test: node --test test/mul.test.js');
    commit(r.repo, { 'src/math.js': MUL }, 'Multiply');
    let out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    write(r.repo, { 'test/mul.test.js': RED_AT_BASE.replace('assert.equal(m.mul(2, 3), 6);', 'assert.ok(m.mul);') });
    out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /failing-test-edited/);
    git(r.repo, 'add', '-A');
    out = script(r.repo, 'rules', ['--staged']);
    assert.equal(out.code, 1, out.out);
    git(r.repo, 'reset', '-q', '--hard');
    git(r.repo, 'switch', '-q', 'work');
  });

  test('cannot run without its table, and says so', () => {
    const table = join(r.repo, '.gate/handin.json');
    const saved = readFileSync(table);
    rmSync(table);
    const out = script(r.repo, 'rules', ['--base', 'origin/main']);
    writeFileSync(table, saved);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /could not run/);
  });
});

describe('junit reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'junit-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const read = (xml) => {
    writeFileSync(join(dir, 'r.xml'), xml);
    return run(dir, 'node', [join(factory, 'kit/.gate/bin/lib/junit.mjs'), join(dir, 'r.xml')]).out.trim();
  };

  test('counts a node file that could not load as an error, not a failure', () => {
    assert.equal(read('<testsuites><testcase name="b.test.mjs" file="/x/b.test.mjs"><failure message="test failed"/></testcase></testsuites>'), 'tests=0 failures=0 errors=1 skipped=0');
  });
  test('also when the file was named by a relative path', () => {
    assert.equal(read('<testsuites><testcase name="test/b.test.mjs" file="/x/test/b.test.mjs"><failure message="test failed"/></testcase></testsuites>'), 'tests=0 failures=0 errors=1 skipped=0');
  });
  test('counts a node file with no test as no test', () => {
    assert.equal(read('<testsuites><testcase name="c.test.mjs" file="/x/c.test.mjs"/></testsuites>'), 'tests=0 failures=0 errors=0 skipped=0');
  });
  test('counts failures, errors and skips', () => {
    assert.equal(
      read('<testsuites><testsuite><testcase name="a"><failure/></testcase><testcase name="b"><error/></testcase><testcase name="c"><skipped/></testcase><testcase name="d"/></testsuite></testsuites>'),
      'tests=3 failures=1 errors=1 skipped=1',
    );
  });
  test('a missing report is an error', () => {
    assert.equal(run(dir, 'node', [join(factory, 'kit/.gate/bin/lib/junit.mjs'), join(dir, 'none.xml')]).out.trim(), 'tests=0 failures=0 errors=1 skipped=0');
  });
});

describe('red-check', () => {
  let r;
  before(() => (r = repoWithKit({ 'src/old.js': 'export const old = 1;\n' })));
  after(() => r.cleanup());
  const branch = (name, files, body) => {
    git(r.repo, 'switch', '-q', '-C', name, 'origin/main');
    commit(r.repo, files, name);
    const args = ['--base', 'origin/main'];
    if (body !== undefined) {
      writeFileSync(join(r.dir, 'body.txt'), body);
      args.push('--body', join(r.dir, 'body.txt'));
    }
    return script(r.repo, 'red-check', args);
  };

  test('passes with no source change', () => {
    const out = branch('docs', { 'README.md': '# app\n\nMore words.\n' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /no source change/);
  });
  test('passes a test that is red at the base and green at the head', () => {
    const out = branch('red', { 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /red at the base/);
  });
  test('fails a test that already passes at the base', () => {
    const out = branch('green', { 'src/math.js': MUL, 'test/add2.test.js': RED_AT_BASE.replace('m.mul(2, 3), 6', 'm.add(2, 4), 6') });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /pass at the base/);
  });
  test('fails a test that cannot load at the base', () => {
    const out = branch('load', { 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE.replace("import * as m from '../src/math.js';", "import { mul } from '../src/math.js';\nconst m = { mul };") });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /could not run/);
  });
  test('fails a test file that selects no test', () => {
    const out = branch('empty', { 'src/math.js': MUL, 'test/empty.test.js': "import { test } from 'node:test';\n" });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /select no test/);
  });
  test('fails a source change with no test, unless No-red gives a reason of 20 characters', () => {
    let out = branch('notest', { 'src/math.js': MUL });
    assert.equal(out.code, 1, out.out);
    out = branch('notest-short', { 'src/math.js': MUL }, 'No-red: refactor\n');
    assert.equal(out.code, 1, out.out);
    out = branch('notest-reason', { 'src/math.js': MUL }, 'Summary\nNo-red: adds a helper nothing calls yet\n');
    assert.equal(out.code, 0, out.out);
  });
  test('counts a deleted source file as a source change', () => {
    const out = branch('gone', { 'src/old.js': null });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /source changed with no new or changed test:\n {2}src\/old\.js/);
  });
  test('proves a dropped test: the kept test red under the break and green without it, before any source change', () => {
    let out = branch('drop', { 'test/math.test.js': null, 'test/add.test.js': KEPT(PROOF) });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^red-check: test\/math\.test\.js dropped: test\/add\.test\.js "adds two numbers" is red under src\/math\.js "a \+ b" -> "a - b" \(1 of 1 failed\), green without it$/m);
    // A break the kept test does not see proves nothing: addition is commutative.
    out = branch('drop-green', { 'test/math.test.js': null, 'test/add.test.js': KEPT(PROOF.replace('"a + b" -> "a - b"', '"a + b" -> "b + a"')) });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /test\/add\.test\.js "adds two numbers" stays green under src\/math\.js "a \+ b" -> "b \+ a"/);
    out = branch('drop-weak', { 'test/math.test.js': WEAKENED(LOST) });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /test\/math\.test\.js dropped: test\/math\.test\.js "adds" is red under/);
  });
  test('fails when the tests do not pass at the head', () => {
    const out = branch('broken', { 'src/math.js': MUL.replace('a * b', 'a + b'), 'test/mul.test.js': RED_AT_BASE });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /at the head/);
  });
});

describe('tier', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());
  const tierOf = (files, args = []) => {
    git(r.repo, 'switch', '-q', '-C', 't', 'origin/main');
    commit(r.repo, files, 't');
    return script(r.repo, 'tier', ['--base', 'origin/main', ...args]);
  };

  test('tier 1 for a plain source change', () => {
    assert.match(tierOf({ 'src/math.js': MUL }).out, /^tier 1/);
  });
  test('tier 2 for a load-bearing path and for a dependency manifest', () => {
    git(r.repo, 'switch', '-q', 'main');
    commit(r.repo, { '.gate/load-bearing': 'src/auth/\n' }, 'auth is load-bearing');
    git(r.repo, 'push', '-q', 'origin', 'main');
    assert.match(tierOf({ 'src/auth/token.js': 'export const t = 1;\n' }).out, /^tier 2\n {2}src\/auth\/token\.js \(load-bearing: src\/auth\/\)/);
    assert.match(tierOf({ 'package.json': '{ "name": "app", "type": "module", "dependencies": { "x": "1" } }\n' }).out, /^tier 2/);
  });
  test('tier 3 for a path CODEOWNERS lists, and --max fails above it', () => {
    const out = tierOf({ 'scripts/verify': '#!/bin/sh\nexit 0\n' }, ['--max', '2']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^tier 3/);
  });
  test('a tier label from an earlier commit only raises the tier', () => {
    assert.match(tierOf({ 'src/math.js': MUL }, ['--labels', 'tier-2,bug']).out, /^tier 2/);
  });
  test('tier 3 for what decides the checks: a type-check config, a manifest test script, a .gitattributes', () => {
    assert.match(tierOf({ 'tsconfig.json': '{ "compilerOptions": { "strict": false } }\n' }).out, /^tier 3\n {2}tsconfig\.json \(protected: tsconfig\*\.json\)/);
    assert.match(tierOf({ 'package.json': '{ "name": "app", "private": true, "type": "module", "scripts": { "test": "true" } }\n' }).out, /^tier 3\n {2}package\.json/);
    assert.match(tierOf({ 'src/.gitattributes': '*.js -diff\n' }).out, /^tier 3/);
  });
  test('fails closed when a policy file or the diff cannot be read', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-policy-'));
    let out = tierOf({ 'src/math.js': MUL }, ['--rules', empty]);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /could not read .*\.gate\/protected/);
    rmSync(empty, { recursive: true });
    out = script(r.repo, 'tier', ['--base', 'no-such-commit']);
    assert.equal(out.code, 2, out.out);
  });
  test('tier 2 for a dropped test: a deleted test file, or the proof that lets it go', () => {
    assert.match(tierOf({ 'test/math.test.js': null }).out, /^tier 2\n {2}test\/math\.test\.js \(test deleted\)/);
    assert.match(tierOf({ 'test/math.test.js': WEAKENED(LOST) }).out, /^tier 2\n {2}test\/math\.test\.js \(proof for a dropped test\)/);
  });
  test('a needs-human label makes the pull request the Human\'s: tier 3', () => {
    assert.match(tierOf({ 'src/math.js': MUL }, ['--labels', 'needs-human']).out, /^tier 3\n {2}label needs-human/);
  });
  test('the rules come from --rules, not from the change', () => {
    const main = join(r.dir, 'main-checkout');
    if (!existsSync(main)) git(r.dir, 'clone', '-q', join(r.dir, 'app.git'), main);
    let out = tierOf({ '.github/CODEOWNERS': '# narrowed\n', '.gate/protected': '/README.md\n', '.gate/load-bearing': '# emptied\n', 'src/auth/x.js': 'export const x = 1;\n' });
    assert.match(out.out, /^tier 1/);
    out = tierOf({ '.github/CODEOWNERS': '# narrowed\n', '.gate/protected': '/README.md\n', '.gate/load-bearing': '# emptied\n', 'src/auth/x.js': 'export const x = 1;\n' }, ['--rules', main]);
    assert.match(out.out, /^tier 3\n {2}\.gate\/load-bearing \(protected: \/\.gate\/\)/);
  });
});

describe('verify and prove-check', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());

  test('passes quietly on a good tree: one summary line', () => {
    const out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out.trim(), /^verify: 6 passed in \d+s$/);
  });
  test('fails when CODEOWNERS does not end with every protected path', () => {
    const owners = readFileSync(join(r.repo, '.github/CODEOWNERS'), 'utf8');
    write(r.repo, { '.gate/protected': `${readFileSync(join(r.repo, '.gate/protected'), 'utf8')}gate-proof/\n` });
    let out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /policy failed[\s\S]*gate-proof\/ is not among the last lines of \.github\/CODEOWNERS/);
    git(r.repo, 'checkout', '-q', '--', '.gate/protected');
    write(r.repo, { '.github/CODEOWNERS': `${owners}* @someone\n` });
    out = script(r.repo, 'verify', ['--only', 'policy']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /\* is not a protected path/);
    git(r.repo, 'checkout', '-q', '--', '.github/CODEOWNERS');
  });
  test('fails an AGENTS.md over 150 lines', () => {
    write(r.repo, { 'AGENTS.md': `${readFileSync(join(r.repo, 'AGENTS.md'), 'utf8')}${'x\n'.repeat(150)}` });
    const out = script(r.repo, 'verify', ['--only', 'instructions']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /at most 150/);
    git(r.repo, 'checkout', '-q', '--', 'AGENTS.md');
  });
  test('fails when no test runs', () => {
    write(r.repo, { '.gate/config.sh': readFileSync(join(r.repo, '.gate/config.sh'), 'utf8').replace('"$@"\n}', 'gate-proof-nothing/ "$@"\n}') });
    const out = script(r.repo, 'verify', ['--only', 'tests']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no tests ran|tests failed|could not run/);
    git(r.repo, 'checkout', '-q', '--', '.gate/config.sh');
  });
  test('fails a JUnit report that lists failures although the runner exits 0', () => {
    const config = readFileSync(join(r.repo, '.gate/config.sh'), 'utf8');
    write(r.repo, {
      '.gate/config.sh': config.replace('"$@"\n}', '"$@" || true\n}'),
      'test/fail.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2));\n",
    });
    const out = script(r.repo, 'verify', ['--only', 'tests']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tests failed \(exit 0\): tests=\d+ failures=1/);
    git(r.repo, 'checkout', '-q', '--', '.gate/config.sh');
    write(r.repo, { 'test/fail.test.js': null });
  });
  test('prove-check fails a check that passes its fixture', () => {
    write(r.repo, { '.gate/bin/rules': '#!/usr/bin/env bash\nexit 0\n' });
    const out = script(r.repo, 'prove-check', ['rules']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /rules PASSED its fixture/);
    git(r.repo, 'checkout', '-q', '--', '.gate/bin/rules');
  });
  test('a check of the repository without a fixture fails verify', () => {
    const config = readFileSync(join(r.repo, '.gate/config.sh'), 'utf8');
    write(r.repo, { '.gate/config.sh': config.replace('GATE_CHECKS=""', 'GATE_CHECKS="lint"\ncheck_lint() { :; }') });
    const out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /lint has no fixture/);
    git(r.repo, 'checkout', '-q', '--', '.gate/config.sh');
  });
});

describe('verify-trusted', () => {
  let r;
  let trusted;
  before(() => {
    r = repoWithKit();
    trusted = join(r.dir, 'trusted');
    git(r.dir, 'clone', '-q', join(r.dir, 'app.git'), trusted);
  });
  after(() => r.cleanup());
  const candidate = (files, env = {}) => {
    git(r.repo, 'switch', '-q', '-C', 'c', 'origin/main');
    commit(r.repo, files, 'candidate');
    return run(trusted, join(trusted, '.gate/bin/verify-trusted'), [r.repo, git(r.repo, 'rev-parse', 'origin/main')], env);
  };

  test('passes a good candidate that changes no protected path', () => {
    const out = candidate({ 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /main's verify and red-check pass on the candidate/);
  });
  test('hands the PR body to red-check, so a No-red line passes it there and review judges the reason', () => {
    assert.equal(candidate({ 'src/math.js': MUL }).code, 1);
    write(r.dir, { 'body.txt': 'Summary\nNo-red: adds a helper nothing calls yet\n' });
    const out = candidate({ 'src/math.js': MUL }, { GATE_BODY_FILE: join(r.dir, 'body.txt') });
    assert.equal(out.code, 0, out.out);
  });
  test('runs main\'s verify on every candidate, not only on a gate change', () => {
    const out = candidate({ 'test/focus.test.js': "import { test } from 'node:test';\ntest.only('x', () => {});\n" });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /main's verify fails on the candidate's code[\s\S]*test-focused/);
  });
  test('lays main\'s copy of every protected path over the candidate: a .gitattributes hiding code from the rules', () => {
    const out = candidate({ '.gitattributes': '*.js -diff\n', 'test/focus.test.js': "import { test } from 'node:test';\ntest.only('x', () => {});\n" });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /test-focused/);
  });
  test('fails a verify replaced by exit 0', () => {
    const out = candidate({ '.gate/bin/verify': '#!/usr/bin/env bash\nexit 0\n' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no longer fail on main's fixtures/);
  });
  test('fails a rules check switched off inside verify', () => {
    const verify = readFileSync(join(r.repo, '.gate/bin/verify'), 'utf8').replace('.gate/bin/rules ${GATE_BASE:+--base "$GATE_BASE"}', 'true');
    const out = candidate({ '.gate/bin/verify': verify });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /rules PASSED its fixture/);
  });
  test('fails a candidate that switches its own red-check off and changes code with no test', () => {
    const out = candidate({ '.github/workflows/gate.yml': '# every job passes\n', 'src/math.js': MUL });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /main's red-check fails on the candidate's code/);
  });
  test('fails a candidate whose code main\'s verify rejects', () => {
    const out = candidate({ '.gate/bin/rules': '#!/usr/bin/env bash\nexit 0\n', 'test/focus.test.js': "import { test } from 'node:test';\ntest.only('x', () => {});\n" });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /main's verify fails on the candidate's code/);
  });
});

describe('review, verdict, tier and rounds', () => {
  // The trusted jobs run in main's checkout, into which the candidate's commits are fetched without a work tree.
  let r;
  let trusted;
  let fake;
  before(() => {
    r = repoWithKit();
    git(r.repo, 'switch', '-q', 'main');
    commit(r.repo, { '.gate/load-bearing': 'src/auth/\n' }, 'auth is load-bearing');
    git(r.repo, 'push', '-q', 'origin', 'main');
    trusted = join(r.dir, 'trusted');
    git(r.dir, 'clone', '-q', join(r.dir, 'app.git'), trusted);
    fake = join(r.dir, 'fake');
    write(fake, {
      'bin/gh': [
        '#!/bin/sh',
        // A runs listing is asked for a head: any other head lists nothing, as GitHub would for a head that is not the run's.
        // A remove of the label raised fails while noremove exists.
        'case "$*" in *"--remove-label raised"*) if [ -e "$FAKE/noremove" ]; then echo boom >&2; exit 1; fi ;; esac',
        'case "$*" in *head_sha=*) h=${2#*head_sha=}; h=${h%%&*}; if [ "$h" != "$(cat "$FAKE/head")" ]; then echo \'{"total_count":0,"workflow_runs":[]}\'; exit 0; fi ;; esac',
        // The label query is answered only when it asks who added each label: the approval time follows the bot's own event.
        'case "$*" in *itemTypes:*LABELED_EVENT*) case "$*" in *"actor{login}"*) ;; *) echo "fake gh: the label query does not ask for actor{login}" >&2; exit 1 ;; esac ;; esac',
        'case "$*" in',
        // The review job is found through the run (99) and its annotations through the job's id (501), never by name.
        // The closing issues, as gh prints them (2026-10-26): porcelain commands only. None unless a test writes closing.json.
        '  "pr view 7 --repo o/app --json closingIssuesReferences") echo "pr view" >>"$FAKE/ghlog"; [ -e "$FAKE/ghfails" ] && { echo "HTTP 502" >&2; exit 1; }; cat "$FAKE/closing.json" 2>/dev/null || echo \'{"closingIssuesReferences":[]}\' ;;',
        '  "issue view "*" --repo o/app --json number,title,labels,body") echo "issue view $3" >>"$FAKE/ghlog"; cat "$FAKE/issue-$3.json" ;;',
        '  *actions/runs/99/jobs?filter=all*) echo jobs >>"$FAKE/calls"; cat "$FAKE/jobs.json" ;;',
        '  *check-runs/501/annotations*) echo annotations >>"$FAKE/calls"; cat "$FAKE/annotations.json" ;;',
        '  *check-runs/601/annotations*) cat "$FAKE/ann601.json" ;;',
        '  *check-runs/777/annotations*) cat "$FAKE/ann777.json" 2>/dev/null || echo "[]" ;;',
        '  *actions/runs/98/jobs?filter=all*) cat "$FAKE/jobs98.json" ;;',
        '  *actions/workflows/gate-trusted.yml/runs?head_sha=*) echo runs >>"$FAKE/calls"; cat "$FAKE/runs.json" ;;',
        '  *check-runs*) cat "$FAKE/verify.json" ;;',
        // The pagination is matched literally: a query that asks for the wrong end or no pageInfo falls to exit 1.
        // From the second read on, labels2.json answers when it exists: the labels as they are after the wait.
        '  *"first:100,itemTypes:[LABELED_EVENT]){pageInfo{hasNextPage} nodes"*) n=$(cat "$FAKE/labels.n" 2>/dev/null || echo 0); echo $((n + 1)) >"$FAKE/labels.n"; if [ "$n" -ge 1 ] && [ -e "$FAKE/labels2.json" ]; then cat "$FAKE/labels2.json"; else cat "$FAKE/labels.json"; fi ;;',
        '  *"commits(last:100){pageInfo{hasPreviousPage} nodes"*checkSuites*) cat "$FAKE/rounds.json" ;;',
        '  *reviews*) cat "$FAKE/reviews.json" ;;',
        '  "pr edit"*raised*) [ -e "$FAKE/nolabel" ] && { echo "Could not resolve to a Label with the name raised" >&2; exit 1; }; echo "$*" >>"$FAKE/edits" ;;',
        '  "pr edit"*) echo "$*" >>"$FAKE/edits" ;;',
        '  *) echo "fake gh: $*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
    });
    run(fake, 'chmod', ['+x', 'bin/gh']);
    verify('success');
    reviewJob('success');
    annotations();
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99 }] }) });
  });
  after(() => r.cleanup());
  /** The verify check run gate.yml reports on every head: success, failure, or in_progress. */
  const verify = (state) =>
    write(fake, { 'verify.json': JSON.stringify({ check_runs: [{ name: 'verify', app: { slug: 'github-actions' }, started_at: '2026-10-21T10:00:00Z', status: state === 'in_progress' ? state : 'completed', conclusion: state === 'in_progress' ? null : state }] }) });
  const labels = (...names) =>
    write(fake, { 'labels2.json': null, 'labels.n': null, 'labels.json': JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: names.map((name) => ({ label: { name }, createdAt: '2026-10-21T09:00:00Z' })) } } } } }) });
  /** The jobs of run 99, as `filter=all` lists them: the review job (check run 501) and the tier jobs, per attempt. */
  const reviewJob = (state, ...more) =>
    write(fake, {
      'jobs.json': JSON.stringify({
        jobs: [{ id: 501, name: 'review', run_attempt: 1, check_run_url: CHECK_RUN(501), status: state === 'in_progress' ? state : 'completed', conclusion: state === 'in_progress' ? null : state }, ...more],
        total_count: 1 + more.length,
      }),
    });
  const CHECK_RUN = (id) => `https://api.github.com/repos/o/app/check-runs/${id}`;
  /** The annotations of check run 501: the result of a review that reached it is `none`, or `raise: <why>` for a reason. */
  const result = (message, extra = {}) => ({ title: 'review-result', message, annotation_level: 'notice', ...extra });
  const annotations = (...messages) => write(fake, { 'annotations.json': JSON.stringify(messages.length ? messages.map((message) => result(`raise: ${message}`)) : [result('none')]) });
  const reviews = (list) => write(fake, { 'reviews.json': JSON.stringify([list]) });
  /** Runs one job in the trusted checkout on a head already fetched there, as a re-run does. */
  const again = (kind, head, env = {}) => {
    write(fake, { edits: '', calls: '' });
    write(fake, { head });
    const out = run(trusted, join(trusted, '.gate/bin/review'), [kind, '--base', git(trusted, 'rev-parse', 'origin/main'), '--head', head], {
      PATH: `${join(fake, 'bin')}:${process.env.PATH}`,
      FAKE: fake,
      GITHUB_REPOSITORY: 'o/app',
      GATE_HEAD: head,
      GATE_REVIEW_WAIT: '0',
      GATE_RESULT_POLL: '0',
      ...env,
    });
    return { ...out, head, edits: readFileSync(join(fake, 'edits'), 'utf8'), calls: readFileSync(join(fake, 'calls'), 'utf8') };
  };
  /** Commits files on a candidate branch, fetches it into the trusted checkout, and runs one job there. */
  const job = (kind, files, env = {}) => {
    git(r.repo, 'switch', '-q', '-C', 'rv', 'origin/main');
    const head = commit(r.repo, files, 'rv');
    git(trusted, 'fetch', '-q', r.repo, 'rv');
    return again(kind, head, env);
  };
  const pr = { GATE_PR: '7', GATE_PR_AUTHOR: 'agent-bot', GITHUB_RUN_ID: '99' };
  const beforeNoRemove = () => write(fake, { noremove: null });
  beforeEach(beforeNoRemove);
  // Every test starts from the same fake GitHub: a test that fails before its last line restores nothing.
  beforeEach(() => {
    verify('success');
    reviewJob('success');
    annotations();
    labels();
    reviews([]);
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99 }] }), 'jobs98.json': null, 'ann601.json': null, 'ann777.json': null, nolabel: null, 'closing.json': null, ghfails: null });
  });
  const review = (login, state, commit_id, at = '2026-10-21T10:00:00Z') => ({ user: { login }, state, commit_id, submitted_at: at });

  test('review fails closed with no reviewer configured, and reads the candidate with no work tree', () => {
    assert.ok(!existsSync(join(trusted, 'src/auth')));
    const out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: '' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no reviewer is configured/);
  });
  test('the stub blocks while its marker is in the diff, and passes without it', () => {
    let out = job('review', { 'src/math.js': `${MUL}// GATE-STUB-FINDING off by one\n` }, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /stub-1: .*GATE-STUB-FINDING off by one/);
    out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 0, out.out);
  });
  test('the reviewer runs only on a head whose verify passed, and fails closed while verify has not', () => {
    verify('failure');
    let out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /verify is failure on [0-9a-f]{8}, so the reviewer does not run/);
    verify('in_progress');
    out = again('review', out.head, { GATE_REVIEWER: 'stub', GATE_WAIT: '0' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /verify did not finish on [0-9a-f]{8} in time/);
    verify('success');
    out = again('review', out.head, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 0, out.out);
  });
  test('a job judging a commit other than the pull request\'s head fails', () => {
    const out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'stub', GATE_HEAD: '0'.repeat(40) });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /the pull request's head is 0{40}/);
  });
  test('a No-red line needs the reviewer\'s explicit acceptance, which the stub never gives', () => {
    write(r.dir, { 'body.txt': 'Summary\nNo-red: renames a local variable, nothing to fail\n' });
    const out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'stub', GATE_BODY_FILE: join(r.dir, 'body.txt') });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /No-red .* not accepted \(unjudged\)/);
  });
  test('a reviewer result that is malformed, unbound to the head, or silent on a No-red claim fails', () => {
    const check = (result, args = []) =>
      spawnSync('node', [join(factory, 'kit/.gate/bin/lib/result.mjs'), '--job', 'review', '--base', 'b'.repeat(40), '--head', 'h'.repeat(40), ...args], { input: result, encoding: 'utf8' });
    const good = { reviewer: 'x', job: 'review', base: 'b'.repeat(40), head: 'h'.repeat(40), blocking: [], noRed: 'unjudged' };
    assert.equal(check(JSON.stringify(good)).status, 0);
    assert.equal(check('not json').status, 2);
    assert.equal(check('').status, 2);
    assert.equal(check(JSON.stringify({ ...good, head: 'a'.repeat(40) })).status, 2);
    assert.equal(check(JSON.stringify({ ...good, job: 'verdict' })).status, 2);
    assert.equal(check(JSON.stringify({ ...good, blocking: [{ id: 'f1' }] })).status, 2);
    assert.equal(check(JSON.stringify({ ...good, blocking: [{ id: 'f1', claim: 'off by one' }] })).status, 1);
    assert.equal(check(JSON.stringify(good), ['--no-red']).status, 1);
    assert.equal(check(JSON.stringify({ ...good, noRed: 'accepted' }), ['--no-red']).status, 0);
  });
  test('the verdict passes at once on tier 1 and is required on tier 2', () => {
    labels();
    let out = job('verdict', { 'src/math.js': MUL }, { GATE_REVIEWER: '', ...pr });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /tier 1: not required/);
    out = job('verdict', { 'src/auth/t.js': 'export const t = 1;\n' }, { GATE_REVIEWER: '', ...pr });
    assert.equal(out.code, 1, out.out);
  });
  test('a tier label removed from the pull request still counts: the tier is the highest it ever had', () => {
    labels('bug', 'tier-2');
    const out = job('verdict', { 'src/math.js': MUL }, { GATE_REVIEWER: '', ...pr });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^tier 2\n {2}label tier-2/);
  });
  test('the tier fails closed when the pull request\'s labels cannot be read', () => {
    write(fake, { 'labels.json': '{"data":{"repository":{"pullRequest":{"timelineItems":{"pageInfo":{"hasNextPage":true},"nodes":[]}}}}}' });
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /fails closed/);
    assert.match(out.out, /more than one page/);
  });
  test('the labels pass with no label node and no next page', () => {
    // Seen on factory-pack-scratch#3: a pull request with no label. totalCount said 3 there and no longer matters.
    write(fake, { 'labels.json': '{"data":{"repository":{"pullRequest":{"timelineItems":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}}' });
    const out = job('tier', { 'src/auth/t.js': 'export const t = 1;\n' }, pr);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^tier 2\n {2}src\/auth\/t\.js \(load-bearing/);
    assert.doesNotMatch(out.out, /label /);
  });
  test('the labels fail closed without pageInfo, for nothing then says the history fits one page', () => {
    write(fake, { 'labels.json': '{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[]}}}}}' });
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /fails closed/);
  });
  test('tier labels the pull request, and passes tier 1 and 2 without the Human', () => {
    labels();
    const out = job('tier', { 'src/auth/t.js': 'export const t = 1;\n' }, pr);
    assert.equal(out.code, 0, out.out);
    assert.match(out.edits, /pr edit 7 --repo o\/app --add-label tier-2/);
  });
  test('tier waits for the review of its own run, and fails closed when it does not end or cannot be found', () => {
    labels();
    reviewJob('in_progress');
    let out = job('tier', { 'src/math.js': MUL }, { ...pr, GATE_WAIT: '0' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier: review did not finish in time/);
    write(fake, { 'jobs.json': JSON.stringify({ jobs: [{ id: 502, name: 'tier', run_attempt: 1, status: 'completed', conclusion: 'success' }], total_count: 1 }) });
    out = again('tier', out.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /run 99 has no review job/);
    out = again('tier', out.head, { ...pr, GITHUB_RUN_ID: '' });
    assert.match(out.out, /GITHUB_RUN_ID is unset/);
    reviewJob('success');
    assert.equal(again('tier', out.head, pr).code, 0);
  });
  test('a raise from a review that passed makes tier 3: tier labels raised and tier-3 and waits for the Human', () => {
    labels();
    reviews([]);
    reviewJob('success');
    annotations('deletes a sign-in var in wrangler.jsonc');
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^tier 3\n {2}raised by the reviewer: deletes a sign-in var in wrangler\.jsonc\n/);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    assert.match(out.edits, /pr edit 7 --repo o\/app --add-label raised --add-label tier-3\n/);
  });
  test('after the Human approves, tier re-run alone as attempt 2 finds attempt 1\'s review and runs no reviewer', () => {
    labels('tier-3', 'raised');
    reviewJob('success', { id: 502, name: 'tier', run_attempt: 1, status: 'completed', conclusion: 'failure' }, { id: 503, name: 'tier', run_attempt: 2, status: 'in_progress', conclusion: null });
    annotations('deletes a sign-in var in wrangler.jsonc');
    reviews([]);
    const first = job('tier', { 'src/math.js': MUL }, { ...pr, GITHUB_RUN_ATTEMPT: '2' });
    assert.equal(first.code, 1, first.out);
    reviews([review('tuannd9288', 'APPROVED', first.head)]);
    const out = again('tier', first.head, { ...pr, GITHUB_RUN_ATTEMPT: '2', GATE_REVIEWER: '' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /tuannd9288 approved/);
    assert.doesNotMatch(out.out, /reviewer is configured/);
    // The labels already give tier 3: nothing the review said could add to that, so its jobs were not even listed.
    assert.equal(out.calls, '');
    assert.doesNotMatch(out.edits, /raised/);
  });
  test('the review of the latest attempt is the one read', () => {
    labels();
    reviews([]);
    write(fake, {
      'jobs.json': JSON.stringify({
        jobs: [
          { id: 777, name: 'review', run_attempt: 1, check_run_url: CHECK_RUN(777), status: 'completed', conclusion: 'failure' },
          { id: 501, name: 'review', run_attempt: 2, check_run_url: CHECK_RUN(501), status: 'completed', conclusion: 'success' },
        ],
        total_count: 2,
      }),
    });
    annotations('why');
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.match(out.out, /raised by the reviewer: why/, out.out);
  });
  test('when paths and labels already give tier 3, tier does not wait for the review', () => {
    labels();
    reviews([]);
    reviewJob('in_progress');
    const out = job('tier', { 'AGENTS.md': '# app\n' }, { ...pr, GATE_WAIT: '0' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    assert.equal(out.calls, '');
  });
  test('a missing label raised fails tier closed and names the fix', () => {
    labels();
    reviewJob('success');
    reviews([]);
    annotations('why');
    write(fake, { nolabel: '' });
    const out = job('tier', { 'src/math.js': MUL }, pr);
    write(fake, { nolabel: null });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /gh label create raised --repo o\/app/);
    assert.equal(out.edits, '');
  });
  test('the review annotations fail closed when they may hold more than one page', () => {
    labels();
    reviewJob('success');
    write(fake, { 'annotations.json': JSON.stringify(Array.from({ length: 100 }, () => ({ title: 'x', message: 'y', annotation_level: 'notice' }))) });
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /more than one page/);
    annotations();
  });
  test('no line of the log starts with a workflow command, whatever the reviewer wrote as its reason', () => {
    labels();
    reviewJob('success');
    reviews([]);
    for (const why of ['::error::x', '%0A::warning::y', ' \n::add-mask::z']) {
      annotations(why);
      const out = job('tier', { 'src/math.js': MUL }, pr);
      assert.match(out.out, /^tier 3\n {2}raised by the reviewer: /, out.out);
      for (const line of out.out.split('\n')) assert.doesNotMatch(line, /^\s*(::|%0A)/, `a line starts with a command: ${line}`);
    }
  });
  test('the stub raises on its marker; a raise leaves review green, and rounds, which runs only after a red job, has nothing to count', () => {
    let out = job('review', { 'src/math.js': `${MUL}// GATE-STUB-RAISE deletes a sign-in var\n` }, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^::notice title=review-result::raise: deletes a sign-in var\nreview \(stub\): raises to tier 3: deletes a sign-in var\nreview \(stub\): passes/);
    out = job('review', { 'src/math.js': `${MUL}// GATE-STUB-RAISE ::error::x\n// GATE-STUB-FINDING off by one\n` }, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 1, out.out);
  });
  test('a raise that lowers a tier, names another tier than 3, or comes from the verdict is malformed', () => {
    const check = (result, job = 'review') =>
      spawnSync('node', [join(factory, 'kit/.gate/bin/lib/result.mjs'), '--job', job, '--base', 'b'.repeat(40), '--head', 'h'.repeat(40)], { input: JSON.stringify(result), encoding: 'utf8' });
    const good = { reviewer: 'x', job: 'review', base: 'b'.repeat(40), head: 'h'.repeat(40), blocking: [], noRed: 'unjudged' };
    const ok = check({ ...good, raise: { tier: 3, why: 'a sign-in var' } });
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /^::notice title=review-result::raise: a sign-in var\nreview \(x\): raises to tier 3: a sign-in var\n/);
    for (const raise of [{ tier: 1, why: 'w' }, { tier: 2, why: 'w' }, { tier: 4, why: 'w' }, { tier: '3', why: 'w' }, { tier: 3 }, { tier: 3, why: ' ' }, { tier: 3, why: 'w'.repeat(501) }, { tier: 3, why: 'w', lower: 1 }, null, 3, []])
      assert.equal(check({ ...good, raise }).status, 2, JSON.stringify(raise));
    assert.equal(check({ ...good, job: 'verdict', raise: { tier: 3, why: 'w' } }, 'verdict').status, 2);
  });
  test('the reason is one line and a command can only be the single notice result.mjs prints', () => {
    for (const why of ['::error::x', '%0A::warning::y', 'a\n::add-mask::z']) {
      const r = spawnSync('node', [join(factory, 'kit/.gate/bin/lib/result.mjs'), '--job', 'review', '--base', 'b'.repeat(40), '--head', 'h'.repeat(40)], {
        input: JSON.stringify({ reviewer: 'x', job: 'review', base: 'b'.repeat(40), head: 'h'.repeat(40), blocking: [], noRed: 'unjudged', raise: { tier: 3, why } }),
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stdout);
      const commands = r.stdout.split('\n').filter((l) => l.startsWith('::'));
      assert.equal(commands.length, 1, r.stdout);
      assert.match(commands[0], /^::notice title=review-result::raise: [^\n]*$/);
      assert.ok(!commands[0].includes('%0A'), 'a literal %0A in the reason must be escaped, or the runner turns it into a newline');
    }
  });
  test('tier follows a review that ended red or cancelled: it fails, so a re-run of failed jobs re-runs it too', () => {
    labels();
    reviews([]);
    annotations();
    for (const state of ['failure', 'cancelled']) {
      reviewJob(state);
      const out = job('tier', { 'src/math.js': MUL }, pr);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /tier: review is red; tier follows it/);
      assert.doesNotMatch(out.edits, /--add-label tier-1/);
    }
    reviewJob('success');
  });
  test('a raise on a review that also blocks still labels the pull request, and tier fails', () => {
    labels();
    reviews([]);
    reviewJob('failure');
    annotations('deletes a sign-in var in wrangler.jsonc');
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.edits, /pr edit 7 --repo o\/app --add-label raised --add-label tier-3\n/);
    assert.match(out.out, /raised by the reviewer: deletes a sign-in var in wrangler\.jsonc[\s\S]*review is red; tier follows it/);
    reviewJob('success');
    annotations();
  });
  test('a review that ended and left no result annotation fails tier closed after a bounded number of reads', () => {
    labels();
    reviews([]);
    for (const state of ['success']) {
      reviewJob(state);
      write(fake, { 'annotations.json': '[]' });
      const out = job('tier', { 'src/math.js': MUL }, { ...pr, GATE_RESULT_TRIES: '3' });
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /left no result annotation after 3 reads/);
      assert.equal(out.calls.split('\n').filter((l) => l === 'annotations').length, 3);
    }
    reviewJob('success');
    annotations();
  });
  test('only the annotation titled review-result at level notice counts, whatever else the job printed', () => {
    labels();
    reviews([]);
    write(fake, {
      'annotations.json': JSON.stringify([
        { title: 'raise', message: 'x', annotation_level: 'notice' },
        { title: 'review-result', message: 'raise: x', annotation_level: 'warning' },
        { title: 'other', message: 'none', annotation_level: 'notice' },
      ]),
    });
    let out = job('tier', { 'src/math.js': MUL }, { ...pr, GATE_RESULT_TRIES: '1' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /left no result annotation/);
    assert.equal(out.edits, '');
    write(fake, { 'annotations.json': JSON.stringify([result('none'), result('none')]) });
    out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /more than one result annotation/);
    write(fake, { 'annotations.json': JSON.stringify([result('maybe')]) });
    out = job('tier', { 'src/math.js': MUL }, pr);
    assert.match(out.out, /neither none nor raise/);
    annotations();
  });
  test('a raise found in a cancelled earlier run on this head is labelled although this run\'s review found none', () => {
    labels();
    reviews([]);
    write(fake, {
      'runs.json': JSON.stringify({ total_count: 2, workflow_runs: [{ id: 99 }, { id: 98 }] }),
      'jobs98.json': JSON.stringify({ total_count: 1, jobs: [{ id: 601, name: 'review', run_attempt: 1, check_run_url: CHECK_RUN(601), status: 'completed', conclusion: 'cancelled' }] }),
      'ann601.json': JSON.stringify([result('raise: deletes a sign-in var')]),
    });
    reviewJob('success');
    annotations();
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^tier 3\n {2}raised by the reviewer: deletes a sign-in var\n/);
    assert.match(out.edits, /--add-label raised --add-label tier-3\n/);
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99 }] }) });
  });
  test('tier re-run below tier 3 reads the listing, then the annotations, of attempt 1\'s review', () => {
    labels();
    reviews([]);
    reviewJob('success', { id: 502, name: 'tier', run_attempt: 1, check_run_url: CHECK_RUN(502), status: 'completed', conclusion: 'failure' }, { id: 503, name: 'tier', run_attempt: 2, check_run_url: CHECK_RUN(503), status: 'in_progress', conclusion: null });
    annotations('a reason');
    const out = job('tier', { 'src/math.js': MUL }, { ...pr, GITHUB_RUN_ATTEMPT: '2' });
    assert.match(out.out, /raised by the reviewer: a reason/, out.out);
    assert.match(out.calls, /^jobs\nannotations\n/);
  });
  test('the listings fail closed when they may hold more than one page, or are not lists', () => {
    labels();
    reviews([]);
    write(fake, { 'jobs.json': JSON.stringify({ total_count: 2, jobs: [{ id: 501, name: 'review', run_attempt: 1, check_run_url: CHECK_RUN(501), status: 'completed', conclusion: 'success' }] }) });
    let out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /jobs of run 99 are more than one page/);
    write(fake, { 'jobs.json': JSON.stringify({ total_count: 0 }) });
    out = again('tier', out.head, pr);
    assert.match(out.out, /jobs of run 99 are more than one page, or unreadable/);
    reviewJob('success');
    write(fake, { 'runs.json': JSON.stringify({ total_count: 3, workflow_runs: [{ id: 99 }] }) });
    out = again('tier', out.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /runs on this head are more than one page/);
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99 }] }) });
  });
  test('the review job is taken from check_run_url, and a listing without it or without run_attempt fails closed', () => {
    labels();
    reviews([]);
    annotations('why');
    write(fake, { 'jobs.json': JSON.stringify({ total_count: 1, jobs: [{ id: 999, name: 'review', run_attempt: 1, check_run_url: CHECK_RUN(501), status: 'completed', conclusion: 'success' }] }) });
    let out = job('tier', { 'src/math.js': MUL }, pr);
    assert.match(out.out, /raised by the reviewer: why/, out.out);
    write(fake, { 'jobs.json': JSON.stringify({ total_count: 1, jobs: [{ id: 501, name: 'review', run_attempt: 1, status: 'completed', conclusion: 'success' }] }) });
    out = again('tier', out.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /lacks its check_run_url or run_attempt/);
    write(fake, { 'jobs.json': JSON.stringify({ total_count: 1, jobs: [{ id: 501, name: 'review', check_run_url: CHECK_RUN(501), status: 'completed', conclusion: 'success' }] }) });
    out = again('tier', out.head, pr);
    assert.match(out.out, /lacks its check_run_url or run_attempt/);
    reviewJob('success');
    annotations();
  });
  test('a raised pull request needs an approval given after the raise', () => {
    const at = (name, createdAt) => ({ label: { name }, createdAt, actor: { login: 'github-actions' } });
    const labelsAt = (...nodes) =>
      write(fake, { 'labels2.json': null, 'labels.n': null, 'labels.json': JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes } } } } }) });
    labelsAt(at('tier-3', '2026-10-21T12:00:00Z'), at('raised', '2026-10-21T12:00:00Z'));
    reviews([]);
    const first = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(first.code, 1, first.out);
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T11:00:00Z')]);
    let out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T13:00:00Z')]);
    out = again('tier', first.head, pr);
    assert.equal(out.code, 0, out.out);
    // Raised in this very run: an approval of the head given earlier does not stand for it either.
    labels();
    annotations('why');
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T13:00:00Z')]);
    out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    annotations();
  });
  test('the labels are read again after the wait: one added meanwhile counts', () => {
    labels();
    write(fake, { 'labels2.json': JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ label: { name: 'needs-human' } }] } } } } }) });
    reviews([]);
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^tier 3\n {2}label needs-human/);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
  });
  test('the review wait is GATE_REVIEW_WAIT, which GATE_WAIT for verify does not shorten', () => {
    labels();
    reviewJob('in_progress');
    const start = Date.now();
    const out = job('tier', { 'src/math.js': MUL }, { ...pr, GATE_WAIT: '0', GATE_REVIEW_WAIT: '2', GATE_POLL: '1' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /review did not finish in time/);
    // bash's SECONDS ticks on whole seconds, so a 2-second wait lasts between 1 and 2 seconds; GATE_WAIT=0 would end it at once.
    assert.ok(Date.now() - start >= 1000, 'tier gave up before GATE_REVIEW_WAIT');
    reviewJob('success');
  });
  test('whatever the reviewer writes, the runner finds one command: the result annotation, which comes first', () => {
    // The runner reads `##[name]` anywhere in a line, `::name::` at the start of one, and ends a line at \r too.
    const commandsOf = (stdout) =>
      stdout.split(/\r\n|\r|\n/).flatMap((line) => [...(line.trimStart().startsWith('::') ? [line.trim()] : []), ...(line.includes('##[') ? [line] : [])]);
    const send = (result) =>
      spawnSync('node', [join(factory, 'kit/.gate/bin/lib/result.mjs'), '--job', 'review', '--base', 'b'.repeat(40), '--head', 'h'.repeat(40)], { input: JSON.stringify(result), encoding: 'utf8' });
    const good = { reviewer: 'x', job: 'review', base: 'b'.repeat(40), head: 'h'.repeat(40), blocking: [], noRed: 'unjudged' };
    for (const why of ['##[stop-commands]x', '##[error]x', 'a\r::add-mask::z', 'sets a var ("A": false, // ##[stop-commands]zq7x)']) {
      const r = send({ ...good, raise: { tier: 3, why } });
      assert.equal(r.status, 0, r.stdout);
      assert.equal(commandsOf(r.stdout).length, 1, r.stdout);
      assert.match(r.stdout.split(/\r\n|\r|\n/)[0], /^::notice title=review-result::raise: /);
    }
    const r = send({ ...good, reviewer: 'r\n::stop-commands::q', blocking: [{ id: 'f\r::warning::1', claim: 'one\n::stop-commands::t\n##[stop-commands]u' }], raise: { tier: 3, why: 'w' } });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(commandsOf(r.stdout).length, 1, r.stdout);
    assert.match(r.stdout.split('\n')[0], /^::notice title=review-result::raise: w$/);
    const none = send(good);
    assert.equal(none.stdout.split('\n')[0], '::notice title=review-result::none');
    assert.equal(send({ ...good, job: 'verdict', raise: { tier: 3, why: 'w' } }).stdout.includes('::notice'), false);
  });
  test('tier prints the reviewer\'s reason on one line with ##[ broken', () => {
    labels();
    reviews([]);
    annotations('##[stop-commands]x then ##[error]y');
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.match(out.out, /^tier 3\n {2}raised by the reviewer: ## \[stop-commands\]x then ## \[error\]y\n/);
    assert.ok(!out.out.includes('##['), out.out);
    annotations();
  });
  test('history.mjs raise with no pr, head or run exits 2 and says which are needed', () => {
    const out = run(factory, 'node', [join(factory, 'kit/.gate/bin/lib/history.mjs'), 'raise']);
    assert.equal(out.code, 2);
    assert.match(out.out, /--pr, --head or --run are needed/);
  });
  test('a red review with no result annotation fails tier at once, with one read; only a green one is read again', () => {
    reviewJob('failure');
    write(fake, { 'annotations.json': '[]' });
    const out = job('tier', { 'src/math.js': MUL }, { ...pr, GATE_RESULT_TRIES: '3' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier: review is red; tier follows it/);
    assert.doesNotMatch(out.out, /left no result annotation/);
    assert.equal(out.calls.split('\n').filter((l) => l === 'annotations').length, 1);
  });
  test('a raise on an earlier attempt of this run\'s own review is read after "Re-run all jobs"', () => {
    write(fake, {
      'jobs.json': JSON.stringify({
        total_count: 2,
        jobs: [
          { id: 501, name: 'review', run_attempt: 1, check_run_url: CHECK_RUN(501), status: 'completed', conclusion: 'success' },
          { id: 601, name: 'review', run_attempt: 2, check_run_url: CHECK_RUN(601), status: 'completed', conclusion: 'success' },
        ],
      }),
      'ann601.json': JSON.stringify([result('none')]),
    });
    annotations('deletes a sign-in var');
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^tier 3\n {2}raised by the reviewer: deletes a sign-in var\n/);
    assert.match(out.edits, /--add-label raised --add-label tier-3\n/);
  });
  test('the runs listed for the head must hold this run, or the union fails closed and says so', () => {
    write(fake, { 'runs.json': JSON.stringify({ total_count: 0, workflow_runs: [] }) });
    const out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /do not include run 99, so the union of raises cannot be trusted/);
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99 }] }) });
    const wrong = run(trusted, 'node', [join(trusted, '.gate/bin/lib/history.mjs'), 'raise', '--repo', 'o/app', '--run', '99', '--head', 'f'.repeat(40)], { PATH: `${join(fake, 'bin')}:${process.env.PATH}`, FAKE: fake });
    assert.equal(wrong.code, 2, wrong.out);
    assert.match(wrong.out, /do not include run 99/);
  });
  test('only a raised label the Actions bot added sets the time an approval must follow; the earliest of them', () => {
    const ev = (name, createdAt, login) => ({ label: { name }, createdAt, actor: { login } });
    const set = (...nodes) =>
      write(fake, { 'labels2.json': null, 'labels.n': null, 'labels.json': JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes } } } } }) });
    set(ev('raised', '2026-10-21T08:00:00Z', 'tuan9288-agent'), ev('tier-3', '2026-10-21T12:00:00Z', 'github-actions'), ev('raised', '2026-10-21T12:00:00Z', 'github-actions'));
    const first = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(first.code, 1, first.out);
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T10:00:00Z')]);
    let out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    set(ev('raised', '2026-10-21T09:00:00Z', 'github-actions'), ev('raised', '2026-10-21T12:00:00Z', 'github-actions'), ev('tier-3', '2026-10-21T09:00:00Z', 'github-actions'));
    out = again('tier', first.head, pr);
    assert.equal(out.code, 0, out.out);
    set({ label: { name: 'raised' }, actor: { login: 'github-actions' } }, ev('tier-3', '2026-10-21T09:00:00Z', 'github-actions'));
    out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /when the pull request was raised could not be read \(history: a raised label event has no createdAt\)/);
  });
  test('when the label events cannot be read for the approval time, tier fails closed', () => {
    labels('tier-3');
    write(fake, { 'labels2.json': '{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[]}}}}}' });
    const first = job('tier', { 'src/math.js': MUL }, pr);
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T10:00:00Z')]);
    write(fake, { 'labels.n': null });
    const out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /when the pull request was raised could not be read/);
    assert.doesNotMatch(out.out, /approved/);
  });
  test('a raise removes raised before it adds it, so the bot\'s own event holds an earlier approval back, now and on a re-run', () => {
    const ev = (name, createdAt, login) => ({ label: { name }, createdAt, actor: { login } });
    const timeline = (...nodes) => JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes } } } } });
    // What GitHub lists: another account added raised at 08:00, the bot removed it and added it again at 12:00.
    const events = timeline(ev('raised', '2026-10-21T08:00:00Z', 'tuan9288-agent'), ev('raised', '2026-10-21T12:00:00Z', 'github-actions'), ev('tier-3', '2026-10-21T12:00:00Z', 'github-actions'));
    write(fake, { 'labels.json': timeline(), 'labels2.json': events, 'labels.n': null });
    annotations('why');
    const first = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(first.code, 1, first.out);
    assert.match(first.edits, /--remove-label raised\n(?:.*\n)*pr edit 7 --repo o\/app --add-label raised --add-label tier-3\n/);
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T10:00:00Z')]);
    write(fake, { 'labels.n': null });
    let out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    // A later re-run: the labels give tier 3, no wait, and the bot's event still holds the approval back.
    write(fake, { 'labels.json': events, 'labels2.json': null, 'labels.n': null });
    out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T13:00:00Z')]);
    assert.equal(again('tier', first.head, pr).code, 0);
  });
  test('a raised event with no actor is not the bot\'s: it does not set the time an approval must follow', () => {
    const ev = (name, createdAt, actor) => ({ label: { name }, createdAt, actor });
    write(fake, {
      'labels.json': JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: [ev('raised', '2026-10-21T11:00:00Z', null), ev('raised', '2026-10-21T12:00:00Z', { login: 'github-actions' }), ev('tier-3', '2026-10-21T12:00:00Z', { login: 'github-actions' })] } } } } }),
      'labels2.json': null,
      'labels.n': null,
    });
    const first = job('tier', { 'src/math.js': MUL }, pr);
    reviews([review('tuannd9288', 'APPROVED', first.head, '2026-10-21T11:30:00Z')]);
    const out = again('tier', first.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
  });
  test('tier fails closed when it cannot remove a raised label that is on the pull request, and goes on when none is', () => {
    beforeNoRemove();
    const timeline = (...names) =>
      JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: names.map((name) => ({ label: { name }, createdAt: '2026-10-21T08:00:00Z', actor: { login: 'tuan9288-agent' } })) } } } } });
    annotations('why');
    write(fake, { 'labels.json': timeline(), 'labels2.json': timeline('raised'), 'labels.n': null, noremove: '' });
    let out = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /raised is on the pull request and could not be removed/);
    assert.doesNotMatch(out.edits, /--add-label/);
    write(fake, { 'labels2.json': timeline('bug'), 'labels.n': null });
    out = again('tier', out.head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.edits, /--add-label raised --add-label tier-3\n/);
    write(fake, { noremove: null });
  });
  test('tier 3 waits for a code owner other than the author to approve the head commit', () => {
    labels();
    reviews([]);
    let out = job('tier', { 'AGENTS.md': '# app\n' }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    reviews([review('tuannd9288', 'APPROVED', '0'.repeat(40))]);
    assert.equal(job('tier', { 'AGENTS.md': '# app\n' }, pr).code, 1);
    out = job('tier', { 'AGENTS.md': '# app\n' }, pr);
    reviews([review('tuannd9288', 'APPROVED', out.head), review('tuannd9288', 'CHANGES_REQUESTED', out.head, '2026-10-21T11:00:00Z')]);
    assert.equal(again('tier', out.head, pr).code, 1);
    reviews([review('someone', 'APPROVED', out.head)]);
    assert.equal(again('tier', out.head, pr).code, 1);
    out = again('tier', out.head, { ...pr, GATE_PR_AUTHOR: 'tuannd9288' });
    assert.match(out.out, /agents need their own GitHub account/);
  });
  test('tier 3 passes once the code owner approved the head commit; needs-human is tier 3 too', () => {
    labels('needs-human');
    reviews([]);
    const first = job('tier', { 'src/math.js': MUL }, pr);
    assert.equal(first.code, 1, first.out);
    reviews([review('TuanND9288', 'APPROVED', first.head)]);
    const out = again('tier', first.head, pr);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /tier 3\n {2}label needs-human[\s\S]*tuannd9288 approved/);
  });
  test('rounds labels the pull request needs-human at its third head commit judged red', () => {
    const red = (oid, name = 'verify', conclusion = 'FAILURE') => ({ commit: { oid, checkSuites: { nodes: [{ app: { slug: 'github-actions' }, checkRuns: { nodes: [{ name, conclusion }] } }] } } });
    const rounds = (...nodes) => write(fake, { 'rounds.json': JSON.stringify({ data: { repository: { pullRequest: { commits: { pageInfo: { hasPreviousPage: false }, nodes } } } } }) });
    rounds(red('a'), red('b', 'review'), red('c', 'verify', 'SUCCESS'), red('d', 'tier'));
    let out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /2 head commits judged red/);
    assert.equal(out.edits, '');
    rounds(red('a'), red('b', 'review'), red('c', 'verdict', 'TIMED_OUT'));
    out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.match(out.edits, /--add-label needs-human/);
  });
  test('rounds counts the nodes it got when no earlier page exists, and fails when one does', () => {
    const red = (oid) => ({ commit: { oid, checkSuites: { nodes: [{ app: { slug: 'github-actions' }, checkRuns: { nodes: [{ name: 'verify', conclusion: 'FAILURE' }] } }] } } });
    const rounds = (hasPreviousPage) =>
      write(fake, { 'rounds.json': JSON.stringify({ data: { repository: { pullRequest: { commits: { pageInfo: { hasPreviousPage }, nodes: [red('a')] } } } } }) });
    rounds(false);
    let out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /1 head commits judged red/);
    rounds(true);
    out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /rounds: the pull request's rounds could not be read: history: .*more than one page/);
    write(fake, { 'rounds.json': '{"data":{"repository":{"pullRequest":{"commits":{"nodes":[]}}}}}' });
    out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 1, out.out);
  });
  test('a tier-3 approval holds on a head that only took main in, and not once the patch changes', () => {
    labels();
    reviews([]);
    const first = job('tier', { 'AGENTS.md': '# app\n' }, pr);
    assert.equal(first.code, 1, first.out);
    reviews([review('tuannd9288', 'APPROVED', first.head)]);
    git(r.repo, 'switch', '-q', 'main');
    commit(r.repo, { 'README.md': '# app, moved on\n' }, 'main moves');
    git(r.repo, 'push', '-q', 'origin', 'main');
    git(trusted, 'fetch', '-q', 'origin');
    git(r.repo, 'switch', '-q', 'rv');
    git(r.repo, 'merge', '-q', '--no-edit', 'main');
    git(trusted, 'fetch', '-q', r.repo, 'rv');
    let out = again('tier', git(r.repo, 'rev-parse', 'HEAD'), pr);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, new RegExp(`tuannd9288 approved ${first.head.slice(0, 8)}, whose patch the head carries unchanged`));
    const changed = commit(r.repo, { 'AGENTS.md': '# app\nOne more rule.\n' }, 'rv');
    git(trusted, 'fetch', '-q', r.repo, 'rv');
    out = again('tier', changed, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
  });

  // The Claude Code reviewer through scripts/review, and verdict reading review's result: one reviewer call per pull request.
  const FAKE_CLAUDE = (f) => `#!/usr/bin/env node
const fs = require('fs');
const conf = JSON.parse(fs.readFileSync(${JSON.stringify(join(f, 'claude.json'))}, 'utf8'));
if (process.argv[2] === '--version') { console.log('2.1.308 (Claude Code)'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(f, 'brief'))}, fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(f, 'claude-calls'))}, 'call\\n');
const e = (x) => console.log(JSON.stringify(x));
e({ type: 'system', subtype: 'init', tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], mcp_servers: [], plugins: [], skills: [], slash_commands: [] });
if (conf.mode === 'crash') process.exit(7);
if (conf.mode === 'quota') { e({ type: 'result', is_error: true, api_error_status: 429, result: 'Claude AI usage limit reached|1761300000' }); process.exit(1); }
e({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(conf.output), structured_output: conf.output });
`;
  const claude = (conf) => {
    write(fake, { 'bin/claude': FAKE_CLAUDE(fake), 'claude.json': JSON.stringify(conf), 'claude-calls': '' });
    run(fake, 'chmod', ['+x', 'bin/claude']);
  };
  const reviewEnv = { GATE_REVIEWER: 'claude', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ...pr };
  const NOTE = (title, message) => ({ title, message, annotation_level: 'notice' });
  /** Commits a tier 2 candidate (a load-bearing path) and fetches it; returns its head and the base the jobs get. */
  const candidate = (files = { 'src/auth/t.js': 'export const t = 1;\n' }) => {
    git(r.repo, 'switch', '-q', '-C', 'rv', 'origin/main');
    const head = commit(r.repo, files, 'rv');
    git(trusted, 'fetch', '-q', r.repo, 'rv');
    return { head, base: git(trusted, 'rev-parse', 'origin/main') };
  };

  test('review with the Claude reviewer prints the result, then which head and base it judged, and its verdict', () => {
    claude({ output: { blocking: [], noRed: 'unjudged' } });
    let out = job('review', { 'src/math.js': MUL }, reviewEnv);
    const base = git(trusted, 'rev-parse', 'origin/main');
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^::notice title=review-result::none\n/);
    assert.ok(out.out.includes(`::notice title=review-verdict::head=${out.head} base=${base} nored=none acc=none reviewer=claude pass\n`), out.out);
    claude({ output: { blocking: [{ id: 'f1', claim: 'off by one in add' }], noRed: 'unjudged' } });
    out = job('review', { 'src/math.js': MUL }, reviewEnv);
    assert.equal(out.code, 1, out.out);
    assert.ok(out.out.includes(`::notice title=review-verdict::head=${out.head} base=${base} nored=none acc=none reviewer=claude block\n`), out.out);
    assert.match(out.out, /f1: off by one in add/);
  });
  test('a quota failure of the Claude reviewer reads as unavailable: it fails the check, and leaves no verdict annotation', () => {
    claude({ mode: 'quota' });
    const out = job('review', { 'src/math.js': MUL }, reviewEnv);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^::notice title=review-result::unavailable: quota\nreview: reviewer unavailable \(quota\)/);
    assert.doesNotMatch(out.out, /review-verdict/);
  });
  test('an unknown reviewer name still fails closed', () => {
    const out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'gpt', ...pr });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /unknown reviewer 'gpt'/);
  });
  // #96: the issues the pull request closes, read by scripts/review with gh porcelain before the reviewer runs.
  const REF = (number, owner = 'o', name = 'app') => ({ id: `I_${number}`, number, repository: { id: 'R_x', name, owner: { id: 'U_x', login: owner } }, url: `https://github.com/${owner}/${name}/issues/${number}` });
  const ISSUE = (number, extra = {}) => ({ body: '## Acceptance\n\n- Refuse an empty name.\n', labels: [{ id: 'LA_1', name: 'task', description: '', color: 'ffffff' }], number, title: 'Initials', ...extra });
  const closing = (...refs) => write(fake, { 'closing.json': JSON.stringify({ closingIssuesReferences: refs }), ghlog: '' });
  const briefSeen = () => readFileSync(join(fake, 'brief'), 'utf8');
  const ghLog = () => readFileSync(join(fake, 'ghlog'), 'utf8').split('\n').filter(Boolean);
  const claudeCalls = () => readFileSync(join(fake, 'claude-calls'), 'utf8').split('\n').filter(Boolean).length;
  const accOf = (text) => /::notice title=review-verdict::head=\S+ base=\S+ nored=\S+ acc=(\S+) reviewer=/.exec(text)?.[1];

  test('review reads the closing issues of this repository before the reviewer runs, hands them over, and names their hash in the verdict', () => {
    claude({ output: { blocking: [], noRed: 'unjudged' } });
    closing(REF(5), REF(9, 'someone', 'else'));
    write(fake, { 'issue-5.json': JSON.stringify(ISSUE(5)), 'issue-9.json': JSON.stringify(ISSUE(9)) });
    const out = job('review', { 'src/math.js': MUL }, reviewEnv);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(ghLog(), ['pr view', 'issue view 5']);
    assert.match(briefSeen(), /### Issue #5: Initials\nLabels: task\n## Acceptance\n\n- Refuse an empty name\./);
    assert.match(briefSeen(), /not read, because they are in another repository: someone\/else#9/);
    assert.match(accOf(out.out), /^[0-9a-f]{16}$/);
  });

  test('review with no closing issue names acc=none and says so in the brief', () => {
    claude({ output: { blocking: [], noRed: 'unjudged' } });
    closing();
    const out = job('review', { 'src/math.js': MUL }, reviewEnv);
    assert.equal(out.code, 0, out.out);
    assert.equal(accOf(out.out), 'none');
    assert.match(briefSeen(), /closes no issue of this repository, so its acceptance is what the body states/);
  });

  test('closing issues that cannot be read make the review unavailable (acceptance), with no reviewer call and no verdict', () => {
    claude({ output: { blocking: [], noRed: 'unjudged' } });
    closing(REF(5));
    write(fake, { 'issue-5.json': JSON.stringify(ISSUE(5)), ghfails: '' });
    let out = job('review', { 'src/math.js': MUL }, reviewEnv);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^::notice title=review-result::unavailable: acceptance\nreview: reviewer unavailable \(acceptance\); /);
    assert.doesNotMatch(out.out, /review-verdict/);
    assert.equal(claudeCalls(), 0);
    // gh printing what is not the recorded shape is the same, and so is a pull request number the job was not given.
    write(fake, { ghfails: null, 'issue-5.json': JSON.stringify({ number: 5, title: 'Initials' }) });
    out = again('review', out.head, reviewEnv);
    assert.match(out.out, /unavailable: acceptance/);
    assert.equal(claudeCalls(), 0);
    out = again('review', out.head, { ...reviewEnv, GATE_PR: '' });
    assert.match(out.out, /unavailable: acceptance/);
    assert.equal(claudeCalls(), 0);
  });

  test('the stub reviewer reads no acceptance', () => {
    closing(REF(5));
    const out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'stub', ...pr });
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(ghLog(), []);
  });

  test('review reuses an earlier review only while the closing issues are as they were: a changed issue is a new question', () => {
    claude({ output: { blocking: [], noRed: 'accepted' } });
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99, event: 'pull_request_target' }] }) });
    closing(REF(5));
    write(fake, { 'issue-5.json': JSON.stringify(ISSUE(5)) });
    const { head, base } = candidate();
    let out = again('review', head, reviewEnv);
    assert.equal(out.code, 0, out.out);
    const acc = accOf(out.out);
    assert.match(acc, /^[0-9a-f]{16}$/);
    const earlier = (a) => write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), NOTE('review-verdict', `head=${head} base=${base} nored=none acc=${a} reviewer=claude pass`)]), 'claude-calls': '' });
    earlier(acc);
    out = again('review', head, reviewEnv);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /reused the review of run 99/);
    assert.equal(claudeCalls(), 0, 'a call was made');
    assert.equal(accOf(out.out), acc);
    write(fake, { 'issue-5.json': JSON.stringify(ISSUE(5, { body: 'Acceptance: refuse an empty name and a blank one.\n' })) });
    out = again('review', head, reviewEnv);
    assert.doesNotMatch(out.out, /reused/);
    assert.equal(claudeCalls(), 1, 'a changed issue was not asked again');
    assert.notEqual(accOf(out.out), acc);
    // The same head with no closing issue at all is another question too.
    closing();
    earlier(acc);
    out = again('review', head, reviewEnv);
    assert.doesNotMatch(out.out, /reused/);
    assert.equal(claudeCalls(), 1);
    annotations();
  });

  test('verdict passes on an annotation with acc, and says the reviewer was unavailable (acceptance) when that was the result', () => {
    const { head, base } = candidate();
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), NOTE('review-verdict', `head=${head} base=${base} nored=none acc=0123456789abcdef reviewer=claude pass`)]) });
    let out = again('verdict', head, { GATE_REVIEWER: '', ...pr });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /verdict: review passed/);
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'unavailable: acceptance')]) });
    out = again('verdict', head, { GATE_REVIEWER: '', ...pr });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /verdict: reviewer unavailable \(acceptance\); this is not a finding on the change/);
    annotations();
  });

  test('verdict waits for review of its run and passes with it, naming the same head and base, with no reviewer call', () => {
    claude({ output: { blocking: [], noRed: 'unjudged' } });
    const { head, base } = candidate();
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), NOTE('review-verdict', `head=${head} base=${base} pass`)]) });
    const out = again('verdict', head, { GATE_REVIEWER: '', ...pr });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /verdict: review passed/);
    assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8'), '');
    annotations();
  });
  test('verdict fails closed on a result for another head or base, a blocking one, an absent one, and one still running', () => {
    const { head, base } = candidate();
    const with_ = (verdict) => write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), ...(verdict ? [NOTE('review-verdict', verdict)] : [])]) });
    with_(`head=${'a'.repeat(40)} base=${base} pass`);
    let out = again('verdict', head, { ...pr, GATE_RESULT_TRIES: '1' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /names another head or base/);
    with_(`head=${head} base=${'b'.repeat(40)} pass`);
    assert.match(again('verdict', head, pr).out, /names another head or base/);
    with_(`head=${head} base=${base} block`);
    out = again('verdict', head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /verdict: review blocks/);
    with_(null);
    out = again('verdict', head, { ...pr, GATE_RESULT_TRIES: '2' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /left no verdict annotation after 2 reads/);
    reviewJob('failure');
    out = again('verdict', head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /review ended without a result/);
    reviewJob('in_progress');
    out = again('verdict', head, { ...pr, GATE_REVIEW_WAIT: '0' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /review did not finish in time/);
    reviewJob('success');
    annotations();
  });
  test('verdict and tier say the reviewer was unavailable, not that review is red', () => {
    const { head } = candidate();
    reviewJob('failure');
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'unavailable: quota')]) });
    let out = again('verdict', head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^::notice title=review-result::unavailable: quota\n/);
    assert.match(out.out, /verdict: reviewer unavailable \(quota\); this is not a finding on the change/);
    out = again('tier', head, pr);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier: reviewer unavailable \(quota\)/);
    assert.doesNotMatch(out.out, /review is red; tier follows it/);
    reviewJob('success');
    annotations();
  });
  test('rounds does not count a head whose review or verdict was only unavailable, read by REST for red runs only', () => {
    const node = (oid, name, conclusion, databaseId) => ({
      commit: { oid, checkSuites: { nodes: [{ app: { slug: 'github-actions' }, checkRuns: { nodes: [{ name, conclusion, databaseId }] } }] } },
    });
    const rounds = (...nodes) => write(fake, { 'rounds.json': JSON.stringify({ data: { repository: { pullRequest: { commits: { pageInfo: { hasPreviousPage: false }, nodes } } } } }) });
    const unavailable = JSON.stringify([NOTE('review-result', 'unavailable: quota')]);
    write(fake, { 'ann601.json': unavailable, 'ann777.json': unavailable });
    // 601 and 777 were unavailable; 501 is a review that judged (its annotations read none); verify's are never read.
    rounds(node('a', 'review', 'FAILURE', 601), node('b', 'verdict', 'FAILURE', 777), node('c', 'review', 'FAILURE', 501), node('d', 'verify', 'FAILURE', 900), node('e', 'review', 'SUCCESS', 902));
    const out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.match(out.out, /2 head commits judged red/);
    assert.equal(out.edits, '');
  });
  test('an unset or unknown reviewer, a refused result and a crashed reviewer are unavailable, not red rounds; a leak stays red', () => {
    claude({ output: { blocking: [], noRed: 'unjudged' } });
    let out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: '', ...pr });
    assert.match(out.out, /^::notice title=review-result::unavailable: no-reviewer\n/);
    assert.match(out.out, /^review: reviewer unavailable \(no-reviewer\)/m, 'probes/score.mjs stops on this line');
    out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'gpt', ...pr });
    assert.match(out.out, /^::notice title=review-result::unavailable: no-reviewer\n/);
    assert.match(out.out, /^review: reviewer unavailable \(no-reviewer\)/m);
    claude({ output: { blocking: [{ id: 'f1', claim: '' }], noRed: 'unjudged' } });
    out = job('review', { 'src/math.js': MUL }, reviewEnv);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^::notice title=review-result::unavailable: malformed\n/);
    assert.match(out.out, /^review: reviewer unavailable \(malformed\)/m);
    claude({ mode: 'crash' });
    out = job('review', { 'src/math.js': MUL }, reviewEnv);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /^::notice title=review-result::unavailable: (crash|no-result)\n/);
    assert.match(out.out, /^review: reviewer unavailable \((crash|no-result)\)/m);
    claude({ output: { blocking: [{ id: 'f1', claim: 'see tok-secret-12345' }], noRed: 'unjudged' } });
    out = job('review', { 'src/math.js': MUL }, { ...reviewEnv, CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret-12345' });
    assert.equal(out.code, 1, out.out);
    assert.doesNotMatch(out.out, /unavailable/);
    assert.ok(!out.out.includes('tok-secret-12345'));
  });
  test('an earlier review that was unavailable (unclean-context) and left no verdict is a new call, not a reuse', () => {
    claude({ output: { blocking: [], noRed: 'accepted' } });
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99, event: 'pull_request_target' }] }) });
    const { head } = candidate();
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'unavailable: unclean-context')]), 'claude-calls': '' });
    const out = again('review', head, reviewEnv);
    assert.equal(out.code, 0, out.out);
    assert.doesNotMatch(out.out, /reused/);
    assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8').split('\n').filter(Boolean).length, 1);
    annotations();
  });
  test('review reuses nothing from a run that is not of pull_request_target, or names no event: a branch can write its own pull_request workflow', () => {
    claude({ output: { blocking: [], noRed: 'accepted' } });
    const { head, base } = candidate();
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), NOTE('review-verdict', `head=${head} base=${base} nored=none acc=none reviewer=claude pass`)]) });
    for (const run of [{ id: 99, event: 'pull_request' }, { id: 99 }, { id: 99, event: 'push' }]) {
      write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [run] }), 'claude-calls': '' });
      const out = again('review', head, reviewEnv);
      assert.doesNotMatch(out.out, /reused/, JSON.stringify(run));
      assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8').split('\n').filter(Boolean).length, 1, `a ${JSON.stringify(run)} run was reused`);
    }
    annotations();
  });
  test('the reuse key names the reviewer: a stub verdict, or one naming none, is not reused as the Claude review', () => {
    claude({ output: { blocking: [], noRed: 'accepted' } });
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99, event: 'pull_request_target' }] }) });
    const { head, base } = candidate();
    const same = `head=${head} base=${base} nored=none acc=none`;
    for (const [what, verdict, calls] of [['a stub verdict', `${same} reviewer=stub pass`, 1], ['one naming no reviewer', `${same} pass`, 1], ['a claude verdict', `${same} reviewer=claude pass`, 0]]) {
      write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), NOTE('review-verdict', verdict)]), 'claude-calls': '' });
      const out = again('review', head, reviewEnv);
      assert.equal(out.code, 0, out.out);
      assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8').split('\n').filter(Boolean).length, calls, `${what}: ${out.out}`);
    }
    annotations();
  });
  test('review reuses the result of an earlier run for the same head, base, No-red line and closing issues: one call per head', () => {
    claude({ output: { blocking: [], noRed: 'accepted' } });
    write(fake, { 'runs.json': JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99, event: 'pull_request_target' }] }) });
    const { head, base } = candidate();
    const earlier = (nored, verdict = 'pass') => write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), NOTE('review-verdict', `head=${head} base=${base} nored=${nored} acc=none reviewer=claude ${verdict}`)]) });
    earlier('none');
    let out = again('review', head, reviewEnv);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^::notice title=review-result::none\n/);
    assert.match(out.out, /review: reused the review of run 99 for this head, base, No-red line and closing issues; no call made/);
    assert.ok(out.out.includes(`::notice title=review-verdict::head=${head} base=${base} nored=none acc=none reviewer=claude pass\n`), out.out);
    assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8'), '', 'a call was made');
    earlier('none', 'block');
    out = again('review', head, reviewEnv);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /review blocks .*reused/);
    assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8'), '');
    // A changed No-red line, another base or head, and an unavailable earlier run are each a new call.
    earlier('none');
    write(r.dir, { 'body.txt': 'Summary\nNo-red: renames a local variable, nothing to fail\n' });
    out = again('review', head, { ...reviewEnv, GATE_BODY_FILE: join(r.dir, 'body.txt') });
    assert.equal(out.code, 0, out.out);
    assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8').split('\n').filter(Boolean).length, 1, 'a changed No-red line was not judged');
    write(fake, { 'claude-calls': '' });
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'none'), NOTE('review-verdict', `head=${'a'.repeat(40)} base=${base} nored=none acc=none reviewer=claude pass`)]) });
    again('review', head, reviewEnv);
    assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8').split('\n').filter(Boolean).length, 1, 'another head was reused');
    write(fake, { 'claude-calls': '' });
    write(fake, { 'annotations.json': JSON.stringify([NOTE('review-result', 'unavailable: quota')]) });
    again('review', head, reviewEnv);
    assert.equal(readFileSync(join(fake, 'claude-calls'), 'utf8').split('\n').filter(Boolean).length, 1, 'an unavailable run was reused');
    annotations();
  });
});

describe('gate-trusted.yml permissions', () => {
  // What each job's scripts call, and the scope GitHub asks for it (docs.github.com, "Permissions required for GitHub
  // Apps": checks for check runs and suites, pull requests for reviews, labels on a pull request and its timeline).
  const NEEDS = {
    review: { actions: 'read', checks: 'read', issues: 'read', 'pull-requests': 'read' },
    verdict: { actions: 'read', checks: 'read', 'pull-requests': 'read' },
    tier: { actions: 'read', checks: 'read', 'pull-requests': 'write' },
    rounds: { checks: 'read', 'pull-requests': 'write' },
  };
  const jobs = readFileSync(join(factory, 'kit/.github/workflows/gate-trusted.yml'), 'utf8').split(/^ {2}(?=\w+:\n {4}name:)/m).slice(1);
  test('review holds no write scope and tier has 75 minutes for its wait', () => {
    const block = (n) => jobs.find((j) => j.startsWith(`${n}:`));
    assert.doesNotMatch(block('review'), /: write$/m);
    assert.match(block('tier'), /timeout-minutes: 75\n/);
  });
  for (const [name, scopes] of Object.entries(NEEDS)) {
    test(`the ${name} job holds the scopes its scripts call`, () => {
      const block = jobs.find((j) => j.startsWith(`${name}:`));
      assert.ok(block, `no job ${name}`);
      const held = Object.fromEntries([...block.matchAll(/^ {6}([a-z-]+): (read|write)$/gm)].map((m) => [m[1], m[2]]));
      for (const [scope, level] of Object.entries(scopes)) {
        assert.ok(held[scope] === level || (level === 'read' && held[scope] === 'write'), `${name} needs ${scope}: ${level}, holds ${held[scope]}`);
      }
    });
  }
});

describe('hooks', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());
  const hooked = (args) => run(r.repo, 'git', args, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' });

  test('commit-msg refuses an empty, long or placeholder subject', () => {
    write(r.repo, { 'README.md': '# app\n\nx\n' });
    git(r.repo, 'add', '-A');
    assert.equal(hooked(['commit', '-qm', 'x'.repeat(73)]).code, 1);
    assert.equal(hooked(['commit', '-qm', 'WIP']).code, 1);
    assert.equal(hooked(['commit', '-qm', 'Explain the app in the README']).code, 0);
  });
  test('pre-commit refuses a staged focused test', () => {
    write(r.repo, { 'test/focus.test.js': "import { test } from 'node:test';\ntest.only('x', () => {});\n" });
    git(r.repo, 'add', '-A');
    const out = hooked(['commit', '-qm', 'Focus a test']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /test-focused/);
    git(r.repo, 'reset', '-q', '--hard');
  });
});

describe('onboard', () => {
  /** Claude Code's worktrees live under .claude/worktrees/, inside the tier-3 path .claude/: a `git add -A` in the
   * main checkout must not stage one. */
  const assertWorktreesIgnored = (repo) => {
    assert.match(readFileSync(join(repo, '.git/info/exclude'), 'utf8'), /^\.claude\/worktrees\/$/m);
    write(repo, { '.claude/worktrees/t/a.txt': 'a\n' });
    assert.equal(git(repo, 'status', '--porcelain', '--', '.claude/worktrees'), '');
  };
  test('clones, makes the Claude profile keyed by owner and repository, writes .envrc, and keeps files the repository had', () => {
    const r = repoWithKit({ '.github/pull_request_template.md': '## Our own\n' });
    try {
      const owner = basename(r.dir);
      assert.ok(existsSync(join(r.dir, 'profiles', owner, 'app/claude')));
      assert.ok(!existsSync(join(r.dir, 'profiles', owner, 'app/codex')));
      assert.ok(!existsSync(join(r.dir, 'profiles/app')));
      assert.match(readFileSync(join(r.repo, '.envrc'), 'utf8'), new RegExp(`^export CLAUDE_CONFIG_DIR=".*profiles/${owner}/app/claude"\n$`));
      assert.match(readFileSync(join(r.repo, '.git/info/exclude'), 'utf8'), /^\.envrc$/m);
      assertWorktreesIgnored(r.repo);
      assert.equal(readFileSync(join(r.repo, '.github/pull_request_template.md'), 'utf8'), '## Our own\n');
      assert.match(r.onboard, /1 kept as they were/);
      assert.match(readFileSync(join(r.repo, '.github/CODEOWNERS'), 'utf8'), /^\/scripts\/ +@tuannd9288$/m);
      assert.equal(git(r.repo, 'config', '--local', 'core.hooksPath'), '.gate/hooks');
    } finally {
      r.cleanup();
    }
  });
  test('keeps an .envrc the repository has, and says what to add to it', () => {
    const r = repoWithKit({ '.envrc': 'export FOO=1\n' });
    try {
      assert.equal(readFileSync(join(r.repo, '.envrc'), 'utf8'), 'export FOO=1\n');
      assert.match(r.onboard, /\.envrc exists and is kept; add to it: export CLAUDE_CONFIG_DIR=/);
      assertWorktreesIgnored(r.repo);
    } finally {
      r.cleanup();
    }
  });
  test('commits the kit only after the full verify passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-onboard-'));
    try {
      const seed = join(dir, 'seed');
      git(dir, 'init', '-q', '-b', 'main', seed);
      commit(seed, { 'test/broken.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n" }, 'start');
      git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
      const out = run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr'], {
        FACTORY_ROOT: join(dir, 'root'),
        AGENT_PROFILES: join(dir, 'profiles'),
        XDG_DATA_HOME: join(dir, 'xdg'),
        XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      });
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /verify: failed: tests[\s\S]*the kit is staged on factory\/kit, not committed/);
      const repo = join(dir, 'root/app');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
      assert.match(git(repo, 'status', '--porcelain'), /^A {2}\.gate\/bin\/verify$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  /** A seed repository with `files` (null-valued entries skipped) and, beside it, what onboard needs; `link` makes
   * CLAUDE.md a symlink to AGENTS.md, as some repositories keep it. */
  const seeded = (files, { link = false } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-own-'));
    const seed = join(dir, 'seed');
    git(dir, 'init', '-q', '-b', 'main', seed);
    write(seed, { ...APP, ...files });
    for (const hook of Object.keys(files).filter((p) => p.startsWith('.githooks/'))) chmodSync(join(seed, hook), 0o755);
    if (link) symlinkSync('AGENTS.md', join(seed, 'CLAUDE.md'));
    commit(seed, {}, 'start');
    git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
    const onboard = (...args) =>
      run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr', ...args], {
        ...quiet,
        FACTORY_ROOT: join(dir, 'root'),
        AGENT_PROFILES: join(dir, 'profiles'),
        XDG_DATA_HOME: join(dir, 'xdg'),
        XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      });
    const own = (text) => {
      writeFileSync(join(dir, 'own.md'), text);
      return join(dir, 'own.md');
    };
    return { dir, repo: join(dir, 'root/app'), onboard, own, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };
  const OWN = '## Layout\n\n`src/` holds the app; `test/` its tests.\n\n## Facts the code cannot tell\n\n- 2026-10-01, the Human: the app ships on Fridays.\n';
  // The AGENTS.md a repository gets by default: the kit's with the pstack pack's section, before its own parts.
  const composedAgents = () => run(factory, 'node', [join(factory, 'bin/lib/pack.mjs'), 'agents', factory, 'pstack']).out;
  const kitLines = () => composedAgents().split('\n').length - 1;

  test("replaces the repository's own AGENTS.md, CLAUDE.md and hooks with the kit's, its approved parts in Layout and Facts", () => {
    const s = seeded({ 'AGENTS.md': '# Our map\n\nOur rules.\n', '.githooks/pre-commit': '#!/bin/sh\nexit 0\n', '.githooks/commit-msg': '#!/bin/sh\nexit 0\n' }, { link: true });
    try {
      const out = s.onboard('--own', s.own(OWN));
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /0 kept as they were, 4 replaced by the kit's/);
      const agents = readFileSync(join(s.repo, 'AGENTS.md'), 'utf8');
      const kit = composedAgents().replace('<repo>', 'app');
      assert.equal(agents, `${kit.slice(0, kit.indexOf('## Layout'))}${OWN}`);
      assert.ok(!lstatSync(join(s.repo, 'CLAUDE.md')).isSymbolicLink(), 'CLAUDE.md is still a link');
      assert.equal(readFileSync(join(s.repo, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
      for (const hook of ['pre-commit', 'commit-msg']) assert.equal(readFileSync(join(s.repo, '.githooks', hook), 'utf8'), readFileSync(join(factory, 'kit/.githooks', hook), 'utf8'));
      assert.match(git(s.repo, 'log', '-1', '--format=%B'), /Kept as the repository had them: 0\. Replaced by the kit's: 4 \(\.githooks\/commit-msg, \.githooks\/pre-commit, AGENTS\.md, CLAUDE\.md\)\./);
    } finally {
      s.cleanup();
    }
  });
  test("refuses a repository with its own AGENTS.md or CLAUDE.md and no --own, and leaves no clone or profile behind", () => {
    for (const files of [{ 'AGENTS.md': '# Our map\n' }, { 'CLAUDE.md': '@AGENTS.md\n\nOur rules.\n' }]) {
      const s = seeded(files);
      try {
        const out = s.onboard();
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, /has its own (AGENTS|CLAUDE)\.md[\s\S]*--own <file>/);
        assert.ok(!existsSync(s.repo), 'the clone is left behind');
        assert.ok(!existsSync(join(s.dir, 'profiles')), 'a profile was made');
      } finally {
        s.cleanup();
      }
    }
    const s = seeded({ 'CLAUDE.md': '@AGENTS.md\n' });
    try {
      assert.equal(s.onboard().code, 0);
    } finally {
      s.cleanup();
    }
  });
  test('refuses an --own file over the line budget, with a heading of its own, or without both sections, before cloning', () => {
    const s = seeded({ 'AGENTS.md': '# Our map\n' });
    try {
      const budget = 150 - (kitLines() - 2);
      const long = `## Layout\n\n${'- a line\n'.repeat(budget)}\n## Facts the code cannot tell\n\n- one more\n`;
      let out = s.onboard('--own', s.own(long));
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, new RegExp(`its two bodies are ${budget + 1} lines; the kit's AGENTS\\.md leaves room for ${budget} \\(at most 150 lines\\)`));
      assert.ok(!existsSync(s.repo), 'cloned before refusing');
      out = s.onboard('--own', s.own(OWN.replace('its tests.', 'its tests.\n# Our rules win')));
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /line 2 of Layout is a heading \(# Our rules win\)/);
      out = s.onboard('--own', s.own('## Layout\n\n`src/` holds the app.\n'));
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /no section "## Facts the code cannot tell"/);
      assert.ok(!existsSync(s.repo), 'cloned before refusing');
    } finally {
      s.cleanup();
    }
  });
  test('refuses a folder that exists', () => {
    const r = repoWithKit();
    try {
      const out = run(r.dir, join(factory, 'bin/onboard'), [join(r.dir, 'app.git'), '--no-pr'], { FACTORY_ROOT: join(r.dir, 'root'), AGENT_PROFILES: join(r.dir, 'profiles') });
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /exists; nothing done/);
    } finally {
      r.cleanup();
    }
  });
  // #30: the profile's settings.json is the one place that turns off what the logged-in claude.ai account loads.
  // #24: and the stable update channel, and the SessionStart hook that tells the Human about every *.failed file.
  const SETTINGS = {
    disableClaudeAiConnectors: true,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    autoUpdatesChannel: 'stable',
    hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: join(factory, 'bin/factory-alerts'), timeout: 10 }] }] },
  };
  test("writes the profile it creates a settings.json that keeps claude.ai's connectors, skills and plugins out, stays on the stable channel and runs factory-alerts at session start", () => {
    const r = repoWithKit();
    try {
      const profile = join(r.dir, 'profiles', basename(r.dir), 'app/claude');
      assert.deepEqual(readdirSync(profile), ['settings.json']);
      assert.deepEqual(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')), SETTINGS);
    } finally {
      r.cleanup();
    }
  });
  test('writes nothing into a profile that exists, and prints every key for the Human to add', () => {
    for (const before of [{}, { 'settings.json': '{ "theme": "dark" }\n' }]) {
      const s = seeded({});
      try {
        const profile = join(s.dir, 'profiles', basename(s.dir), 'app/claude');
        mkdirSync(profile, { recursive: true });
        write(profile, before);
        const out = s.onboard();
        assert.equal(out.code, 0, out.out);
        assert.deepEqual(readdirSync(profile), Object.keys(before));
        for (const [name, text] of Object.entries(before)) assert.equal(readFileSync(join(profile, name), 'utf8'), text);
        assert.match(out.out, /^onboard: profile \S+\/app\/claude exists and is kept; only the Human edits it, and its settings\.json needs these keys:$/m);
        assert.ok(out.out.includes(`${JSON.stringify(SETTINGS, null, 2)}\n`), out.out);
      } finally {
        s.cleanup();
      }
    }
  });
});

describe('workflows and ruleset', () => {
  const yaml = (file) => JSON.parse(spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', join(factory, 'kit', file)], { encoding: 'utf8' }).stdout);
  const ruleset = JSON.parse(readFileSync(join(factory, 'kit/.gate/ruleset.json'), 'utf8'));
  const required = ruleset.rules.flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
  const workflows = readdirSync(join(factory, 'kit/.github/workflows'))
    .filter((f) => f.endsWith('.yml'))
    .map((file) => ({ file, ...yaml(`.github/workflows/${file}`) }));
  // YAML 1.1 reads the key `on` as true.
  const events = (wf) => Object.keys(wf.on ?? wf.true ?? {});
  /** Whether a job checks out the pull request's head as a work tree, and so runs the candidate's code. */
  const runsCandidate = (j) => j.steps.some((s) => String(s.uses).startsWith('actions/checkout') && /head\.(sha|ref)|head_ref|refs\/pull/.test(String(s.with?.ref ?? '')));

  test('every required check is a pull request job, and one skipped by needs leans only on a required one', () => {
    const jobs = workflows.filter((wf) => events(wf).some((e) => e.startsWith('pull_request'))).flatMap((wf) => Object.entries(wf.jobs).map(([id, j]) => ({ id, wf, j })));
    for (const check of required) assert.ok(jobs.some(({ j }) => j.name === check), `${check} is no pull request job`);
    for (const { id, wf, j } of jobs) {
      if (!required.includes(j.name)) continue;
      assert.equal(j.if, undefined, `${id} is skipped by a condition`);
      for (const need of [j.needs ?? []].flat()) assert.ok(required.includes(wf.jobs[need].name), `${id} needs ${need}, which is not required`);
    }
  });
  test('the candidate\'s code runs only on pull_request, on a GitHub-hosted runner, with no secret, environment, cache or kept token', () => {
    let candidate = 0;
    for (const wf of workflows) {
      for (const [id, j] of Object.entries(wf.jobs)) {
        for (const step of j.steps) {
          if (String(step.uses).startsWith('actions/checkout')) assert.equal(step.with?.['persist-credentials'], false, `${wf.file} ${id} keeps its token`);
          assert.ok(!/actions\/cache/.test(String(step.uses ?? '')) && !step.with?.cache, `${wf.file} ${id} uses a cache`);
        }
        if (!runsCandidate(j)) continue;
        candidate += 1;
        assert.deepEqual(events(wf), ['pull_request'], `${wf.file} ${id} runs the candidate's code on ${events(wf).join(', ')}`);
        assert.match(String(j['runs-on']), /^ubuntu-[\w.]+$/, `${wf.file} ${id} runs the candidate's code on ${j['runs-on']}`);
        assert.equal(j.environment, undefined, `${wf.file} ${id} runs the candidate's code in an environment`);
        assert.doesNotMatch(JSON.stringify(j), /secrets\./, `${wf.file} ${id} hands the candidate's code a secret`);
        assert.deepEqual(j.permissions ?? wf.permissions, { contents: 'read' }, `${wf.file} ${id} gives the candidate's code more than read`);
        // On pull_request a checkout with no ref is the merge ref, the candidate's code: main's scripts come from the base.
        for (const step of j.steps.filter((x) => String(x.uses).startsWith('actions/checkout') && !runsCandidate({ steps: [x] })))
          assert.equal(step.with?.ref, '${{ github.event.pull_request.base.sha }}', `${wf.file} ${id} takes its scripts from ${step.with?.ref ?? 'the merge ref'}`);
      }
    }
    assert.ok(candidate > 0, 'no job runs the candidate\'s code');
  });
  test('rounds runs only after a red review or verdict', () => {
    const { rounds } = yaml('.github/workflows/gate-trusted.yml').jobs;
    assert.deepEqual(rounds.needs, ['review', 'verdict']);
    assert.equal(rounds.if, 'failure()');
  });
  test('the ruleset keeps an approval through a push, for the tier check binds it to the patch', () => {
    const rule = ruleset.rules.find((r) => r.type === 'pull_request');
    assert.equal(rule.parameters.dismiss_stale_reviews_on_push, false);
    assert.equal(rule.parameters.require_last_push_approval, false);
  });
});

describe('deny rules', () => {
  const deny = JSON.parse(readFileSync(join(factory, 'kit/.claude/settings.json'), 'utf8')).permissions.deny;
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  /** Whether a deny rule refuses a Bash command, as Claude Code's permissions docs describe the matching: `*` stands
   * for any text, `:*` is a trailing ` *`, a trailing ` *` that is the rule's only wildcard also matches the bare
   * command, and a deny rule applies to each subcommand, past a leading assignment. This models the docs, not Claude
   * Code itself: probe 17 of probes/plan.md tries the same forms in a session. */
  const refused = (command) =>
    command
      .split(/&&|\|\||[;|\n]/)
      .map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, ''))
      .some((sub) =>
        deny.some((rule) => {
          const pattern = /^Bash\((.*)\)$/.exec(rule)?.[1]?.replace(/:\*$/, ' *');
          if (pattern === undefined) return false;
          const bare = pattern.endsWith(' *') && pattern.indexOf('*') === pattern.length - 1 && sub === pattern.slice(0, -2);
          return bare || new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 's').test(sub);
        }),
      );

  test('refuse a force-push in every form, wherever its flag stands: a rewrite drops the red heads rounds counts and the commit the Human approved', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    for (const command of [
      'git push --force origin br',
      'git push -f origin br',
      'git push --force-with-lease origin br',
      'git push --force-with-lease=br origin br',
      `git push --force-with-lease=br:${sha} origin br`,
      `git push --force-with-lease=br:${sha} --force-if-includes origin br`,
      'git push origin br --force-with-lease',
      `git push origin br --force-with-lease=br:${sha}`,
      'git push origin br --force',
      'git push -u origin br -f',
      'git push origin +br',
      'git push origin +HEAD:br',
      'git push --mirror origin',
      `git -C . push --force-with-lease=br:${sha} origin br`,
      'git -c push.default=current push -f',
      'cd app && git push --force-with-lease origin br',
      'GIT_TRACE=1 git push --force-with-lease origin br',
    ])
      assert.ok(refused(command), `not refused: ${command}`);
    for (const command of [
      'git push',
      'git push -u origin factory/kit',
      'git push origin feature-fix',
      'git push --set-upstream origin br',
      'git push --follow-tags origin br',
      'git push origin HEAD:refs/heads/br',
      'git -C app push -u origin br',
      'git pull --no-rebase origin main',
      'git fetch && git reset --hard origin/br',
      'git stash push -m "parser split"',
    ])
      assert.ok(!refused(command), `refused: ${command}`);
  });

  /** Whether a Read deny rule anchored at the home directory refuses a path, in the gitignore syntax the docs give:
   * `*` within one path segment, `**` across segments. */
  const unreadable = (path) =>
    deny.some((rule) => {
      const pattern = /^Read\(~\/(.*)\)$/.exec(rule)?.[1];
      const glob = (part) => part.split('*').map(escape).join('[^/]*');
      return pattern !== undefined && new RegExp(`^~/${pattern.split('**').map(glob).join('.*')}$`).test(path);
    });

  test('refuse a read of the Human\'s own Claude Code and Cursor profiles, where an adapted transcript reader would look', () => {
    for (const path of [
      '~/.claude/projects/-Users-h-app/1.jsonl',
      '~/.claude/settings.json',
      '~/.claude-acc2/projects/-Users-h-app/2.jsonl',
      '~/.claude-profiles/active',
      '~/.claude.json',
      '~/.claude.json.bak',
      '~/.cursor/projects/Users-h-app/agent-transcripts/a/a.jsonl',
    ])
      assert.ok(unreadable(path), `readable: ${path}`);
    for (const path of ['~/.agent-profiles/o/app/claude/projects/-x/1.jsonl', '~/Desktop/workspaces/app/src/a.js'])
      assert.ok(!unreadable(path), `unreadable: ${path}`);
  });

  test('refuse a read of the live verifier\'s Codex profile, which holds its login, and leave the agent its own', () => {
    for (const path of ['~/.agent-profiles/verifier/codex/auth.json', '~/.agent-profiles/verifier/codex/sessions/a.jsonl'])
      assert.ok(unreadable(path), `readable: ${path}`);
    // A deny covers Edit and Write too: one over all of ~/.agent-profiles/ would stop the agent's own auto memory.
    assert.ok(!unreadable('~/.agent-profiles/o/app/claude/projects/-x/memory/MEMORY.md'));
  });
});
