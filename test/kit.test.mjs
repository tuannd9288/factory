// The kit's checks, each shown failing on a bad input and passing on a good one.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, repoWithKit, run, script, write } from './helpers.mjs';

const RED_AT_BASE =
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/math.js';\n\ntest('multiplies', () => {\n  assert.equal(m.mul(2, 3), 6);\n});\n";
const MUL = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n';

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
    return run(dir, 'node', [join(factory, 'kit/scripts/lib/junit.mjs'), join(dir, 'r.xml')]).out.trim();
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
    assert.equal(run(dir, 'node', [join(factory, 'kit/scripts/lib/junit.mjs'), join(dir, 'none.xml')]).out.trim(), 'tests=0 failures=0 errors=1 skipped=0');
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
    assert.match(out.out.trim(), /^verify: 5 passed in \d+s$/);
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
    write(r.repo, { 'scripts/rules': '#!/usr/bin/env bash\nexit 0\n' });
    const out = script(r.repo, 'prove-check', ['rules']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /rules PASSED its fixture/);
    git(r.repo, 'checkout', '-q', '--', 'scripts/rules');
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
  const candidate = (files) => {
    git(r.repo, 'switch', '-q', '-C', 'c', 'origin/main');
    commit(r.repo, files, 'candidate');
    return run(trusted, join(trusted, 'scripts/verify-trusted'), [r.repo, git(r.repo, 'rev-parse', 'origin/main')]);
  };

  test('passes a good candidate that changes no protected path', () => {
    const out = candidate({ 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /main's verify and red-check pass on the candidate/);
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
    const out = candidate({ 'scripts/verify': '#!/usr/bin/env bash\nexit 0\n' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no longer fail on main's fixtures/);
  });
  test('fails a rules check switched off inside verify', () => {
    const verify = readFileSync(join(r.repo, 'scripts/verify'), 'utf8').replace('scripts/rules ${GATE_BASE:+--base "$GATE_BASE"}', 'true');
    const out = candidate({ 'scripts/verify': verify });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /rules PASSED its fixture/);
  });
  test('fails a candidate that switches its own red-check off and changes code with no test', () => {
    const out = candidate({ '.github/workflows/gate.yml': '# every job passes\n', 'src/math.js': MUL });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /main's red-check fails on the candidate's code/);
  });
  test('fails a candidate whose code main\'s verify rejects', () => {
    const out = candidate({ 'scripts/rules': '#!/usr/bin/env bash\nexit 0\n', 'test/focus.test.js': "import { test } from 'node:test';\ntest.only('x', () => {});\n" });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /main's verify fails on the candidate's code/);
  });
});

describe('review', () => {
  let r;
  before(() => {
    r = repoWithKit();
    git(r.repo, 'switch', '-q', 'main');
    commit(r.repo, { '.gate/load-bearing': 'src/auth/\n' }, 'auth is load-bearing');
    git(r.repo, 'push', '-q', 'origin', 'main');
  });
  after(() => r.cleanup());
  const job = (kind, files, env) => {
    git(r.repo, 'switch', '-q', '-C', 'rv', 'origin/main');
    commit(r.repo, files, 'rv');
    return run(r.repo, join(r.repo, 'scripts/review'), [kind, r.repo, git(r.repo, 'rev-parse', 'origin/main')], env);
  };

  test('fails closed with no reviewer configured', () => {
    const out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: '' });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /no reviewer is configured/);
  });
  test('the stub fails while its marker is in the diff, and passes without it', () => {
    let out = job('review', { 'src/math.js': `${MUL}// GATE-STUB-FINDING off by one\n` }, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 1, out.out);
    out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'stub' });
    assert.equal(out.code, 0, out.out);
  });
  test('the verdict passes at once on tier 1 and is required on tier 2', () => {
    let out = job('verdict', { 'src/math.js': MUL }, { GATE_REVIEWER: '' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /tier 1: not required/);
    out = job('verdict', { 'src/auth/t.js': 'export const t = 1;\n' }, { GATE_REVIEWER: '' });
    assert.equal(out.code, 1, out.out);
    out = job('verdict', { 'src/math.js': MUL }, { GATE_REVIEWER: '', GATE_TIER_LABELS: 'tier-2' });
    assert.equal(out.code, 1, out.out);
  });
  test('the verdict on tier 3 waits for a code owner other than the author to approve the head commit', () => {
    const bin = join(r.dir, 'fake-bin');
    write(bin, { gh: '#!/bin/sh\ncat "$FAKE_REVIEWS"\n' });
    run(bin, 'chmod', ['+x', 'gh']);
    const reviews = join(r.dir, 'reviews.json');
    const verdict = (list, author = 'agent-bot') => {
      writeFileSync(reviews, JSON.stringify([list]));
      git(r.repo, 'switch', '-q', '-C', 'rv', 'origin/main');
      commit(r.repo, { 'AGENTS.md': '# app\n' }, 'rv');
      const head = git(r.repo, 'rev-parse', 'HEAD');
      const env = { GATE_REVIEWER: 'stub', PATH: `${bin}:${process.env.PATH}`, FAKE_REVIEWS: reviews, GATE_PR: '7', GATE_PR_AUTHOR: author, GATE_HEAD: head };
      return { head, out: run(r.repo, join(r.repo, 'scripts/review'), ['verdict', r.repo, git(r.repo, 'rev-parse', 'origin/main')], env) };
    };
    const review = (login, state, commit_id, at = '2026-10-21T10:00:00Z') => ({ user: { login }, state, commit_id, submitted_at: at });
    let { out } = verdict([]);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /tier 3 waits for @tuannd9288 to approve/);
    ({ out } = verdict([review('tuannd9288', 'APPROVED', '0'.repeat(40))]));
    assert.equal(out.code, 1, out.out);
    const { head } = verdict([]);
    ({ out } = verdict([review('tuannd9288', 'APPROVED', head), review('tuannd9288', 'CHANGES_REQUESTED', head, '2026-10-21T11:00:00Z')]));
    assert.equal(out.code, 1, out.out);
    ({ out } = verdict([review('someone', 'APPROVED', head)]));
    assert.equal(out.code, 1, out.out);
    ({ out } = verdict([], 'tuannd9288'));
    assert.match(out.out, /agents need their own GitHub account/);
  });
  test('the verdict on tier 3 passes once the code owner approved the head commit', () => {
    const bin = join(r.dir, 'fake-bin');
    const reviews = join(r.dir, 'reviews.json');
    git(r.repo, 'switch', '-q', '-C', 'rv', 'origin/main');
    commit(r.repo, { 'AGENTS.md': '# app\n' }, 'rv');
    const head = git(r.repo, 'rev-parse', 'HEAD');
    writeFileSync(reviews, JSON.stringify([[{ user: { login: 'TuanND9288' }, state: 'APPROVED', commit_id: head, submitted_at: '2026-10-21T10:00:00Z' }]]));
    const env = { GATE_REVIEWER: 'stub', PATH: `${bin}:${process.env.PATH}`, FAKE_REVIEWS: reviews, GATE_PR: '7', GATE_PR_AUTHOR: 'agent-bot', GATE_HEAD: head };
    const out = run(r.repo, join(r.repo, 'scripts/review'), ['verdict', r.repo, git(r.repo, 'rev-parse', 'origin/main')], env);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /tuannd9288 approved/);
  });
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
  test('clones, makes the profile, writes .envrc, and keeps files the repository had', () => {
    const r = repoWithKit({ 'AGENTS.md': '# own rules\n' });
    try {
      assert.ok(existsSync(join(r.dir, 'profiles/app/claude')));
      assert.ok(existsSync(join(r.dir, 'profiles/app/codex')));
      assert.match(readFileSync(join(r.repo, '.envrc'), 'utf8'), /CLAUDE_CONFIG_DIR=".*profiles\/app\/claude"/);
      assert.match(readFileSync(join(r.repo, '.git/info/exclude'), 'utf8'), /^\.envrc$/m);
      assert.equal(readFileSync(join(r.repo, 'AGENTS.md'), 'utf8'), '# own rules\n');
      assert.match(r.onboard, /1 kept as they were/);
      assert.match(readFileSync(join(r.repo, '.github/CODEOWNERS'), 'utf8'), /^\/scripts\/ +@tuannd9288$/m);
      assert.equal(git(r.repo, 'config', '--local', 'core.hooksPath'), '.githooks');
    } finally {
      r.cleanup();
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
});
