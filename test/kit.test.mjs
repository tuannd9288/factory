// The kit's checks, each shown failing on a bad input and passing on a good one.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  const candidate = (files, env = {}) => {
    git(r.repo, 'switch', '-q', '-C', 'c', 'origin/main');
    commit(r.repo, files, 'candidate');
    return run(trusted, join(trusted, 'scripts/verify-trusted'), [r.repo, git(r.repo, 'rev-parse', 'origin/main')], env);
  };

  test('passes a good candidate that changes no protected path', () => {
    const out = candidate({ 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /main's verify and red-check pass on the candidate/);
  });
  test('hands the PR body to red-check, so a No-red line passes it there and review judges the reason', () => {
    assert.equal(candidate({ 'src/math.js': MUL }).code, 1);
    write(r.dir, { 'body.txt': 'Tóm tắt\nNo-red: adds a helper nothing calls yet\n' });
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
        'case "$*" in',
        '  *check-runs*) cat "$FAKE/verify.json" ;;',
        '  *LABELED_EVENT*) cat "$FAKE/labels.json" ;;',
        '  *checkSuites*) cat "$FAKE/rounds.json" ;;',
        '  *reviews*) cat "$FAKE/reviews.json" ;;',
        '  "pr edit"*) echo "$*" >>"$FAKE/edits" ;;',
        '  *) echo "fake gh: $*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
    });
    run(fake, 'chmod', ['+x', 'bin/gh']);
    verify('success');
  });
  after(() => r.cleanup());
  /** The verify check run gate.yml reports on every head: success, failure, or in_progress. */
  const verify = (state) =>
    write(fake, { 'verify.json': JSON.stringify({ check_runs: [{ name: 'verify', app: { slug: 'github-actions' }, started_at: '2026-10-21T10:00:00Z', status: state === 'in_progress' ? state : 'completed', conclusion: state === 'in_progress' ? null : state }] }) });
  const labels = (...names) =>
    write(fake, { 'labels.json': JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { totalCount: names.length, nodes: names.map((name) => ({ label: { name } })) } } } } }) });
  const reviews = (list) => write(fake, { 'reviews.json': JSON.stringify([list]) });
  /** Runs one job in the trusted checkout on a head already fetched there, as a re-run does. */
  const again = (kind, head, env = {}) => {
    write(fake, { edits: '' });
    const out = run(trusted, join(trusted, 'scripts/review'), [kind, '--base', git(trusted, 'rev-parse', 'origin/main'), '--head', head], {
      PATH: `${join(fake, 'bin')}:${process.env.PATH}`,
      FAKE: fake,
      GITHUB_REPOSITORY: 'o/app',
      GATE_HEAD: head,
      ...env,
    });
    return { ...out, head, edits: readFileSync(join(fake, 'edits'), 'utf8') };
  };
  /** Commits files on a candidate branch, fetches it into the trusted checkout, and runs one job there. */
  const job = (kind, files, env = {}) => {
    git(r.repo, 'switch', '-q', '-C', 'rv', 'origin/main');
    const head = commit(r.repo, files, 'rv');
    git(trusted, 'fetch', '-q', r.repo, 'rv');
    return again(kind, head, env);
  };
  const pr = { GATE_PR: '7', GATE_PR_AUTHOR: 'agent-bot' };
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
    write(r.dir, { 'body.txt': 'Tóm tắt\nNo-red: renames a local variable, nothing to fail\n' });
    const out = job('review', { 'src/math.js': MUL }, { GATE_REVIEWER: 'stub', GATE_BODY_FILE: join(r.dir, 'body.txt') });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /No-red .* not accepted \(unjudged\)/);
  });
  test('a reviewer result that is malformed, unbound to the head, or silent on a No-red claim fails', () => {
    const check = (result, args = []) =>
      spawnSync('node', [join(factory, 'kit/scripts/lib/result.mjs'), '--job', 'review', '--base', 'b'.repeat(40), '--head', 'h'.repeat(40), ...args], { input: result, encoding: 'utf8' });
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
    write(fake, { 'labels.json': '{"data":{"repository":{"pullRequest":{"timelineItems":{"totalCount":500,"nodes":[]}}}}}' });
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
    const rounds = (...nodes) => write(fake, { 'rounds.json': JSON.stringify({ data: { repository: { pullRequest: { commits: { totalCount: nodes.length, nodes } } } } }) });
    rounds(red('a'), red('b', 'review'), red('c', 'verify', 'SUCCESS'), red('d', 'tier'));
    let out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /2 head commits judged red/);
    assert.equal(out.edits, '');
    rounds(red('a'), red('b', 'review'), red('c', 'verdict', 'TIMED_OUT'));
    out = job('rounds', { 'src/math.js': MUL }, pr);
    assert.match(out.edits, /--add-label needs-human/);
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
  test('clones, makes the Claude profile keyed by owner and repository, writes .envrc, and keeps files the repository had', () => {
    const r = repoWithKit({ 'AGENTS.md': '# own rules\n' });
    try {
      const owner = basename(r.dir);
      assert.ok(existsSync(join(r.dir, 'profiles', owner, 'app/claude')));
      assert.ok(!existsSync(join(r.dir, 'profiles', owner, 'app/codex')));
      assert.ok(!existsSync(join(r.dir, 'profiles/app')));
      assert.match(readFileSync(join(r.repo, '.envrc'), 'utf8'), new RegExp(`^export CLAUDE_CONFIG_DIR=".*profiles/${owner}/app/claude"\n$`));
      assert.match(readFileSync(join(r.repo, '.git/info/exclude'), 'utf8'), /^\.envrc$/m);
      assert.equal(readFileSync(join(r.repo, 'AGENTS.md'), 'utf8'), '# own rules\n');
      assert.match(r.onboard, /1 kept as they were/);
      assert.match(readFileSync(join(r.repo, '.github/CODEOWNERS'), 'utf8'), /^\/scripts\/ +@tuannd9288$/m);
      assert.equal(git(r.repo, 'config', '--local', 'core.hooksPath'), '.githooks');
    } finally {
      r.cleanup();
    }
  });
  test('keeps an .envrc the repository has, and says what to add to it', () => {
    const r = repoWithKit({ '.envrc': 'export FOO=1\n' });
    try {
      assert.equal(readFileSync(join(r.repo, '.envrc'), 'utf8'), 'export FOO=1\n');
      assert.match(r.onboard, /\.envrc exists and is kept; add to it: export CLAUDE_CONFIG_DIR=/);
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
      const out = run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr'], { FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles') });
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /verify: failed: tests[\s\S]*the kit is staged on factory\/kit, not committed/);
      const repo = join(dir, 'root/app');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
      assert.match(git(repo, 'status', '--porcelain'), /^A {2}scripts\/verify$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
  test('the ruleset keeps an approval through a push, for the tier check binds it to the patch', () => {
    const rule = ruleset.rules.find((r) => r.type === 'pull_request');
    assert.equal(rule.parameters.dismiss_stale_reviews_on_push, false);
    assert.equal(rule.parameters.require_last_push_approval, false);
  });
});
