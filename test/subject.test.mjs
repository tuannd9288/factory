// The commit subject rules: one source (kit/.gate/bin/lib/subject.mjs) read by the commit-msg hook and by verify's
// `subjects` check, which also runs on the factory's own pull requests.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, repoWithKit, run, script, write } from './helpers.mjs';

// The real subject of bb8ff7b on PR #11, which the hook would have refused and nothing checked.
const BB8FF7B = "Correct \"pstack runs only when typed\": its agents have no guard, and ship the installer's key order";
const BAD = [
  ['', /empty/],
  ['x'.repeat(73), /73 characters; at most 72/],
  [BB8FF7B, /99 characters; at most 72/],
  ['WIP', /not 'WIP'/],
  ['wip: later', /not 'wip: later'/],
  ['fix', /not 'fix'/],
  ['update', /not 'update'/],
  ['changes', /not 'changes'/],
  ['.', /not '\.'/],
  ['fixup! Add the queue', /never squashed/],
  ['squash! Add the queue', /never squashed/],
];
const GOOD = ['x'.repeat(72), 'Fix the queue', 'Update the ledger', 'Changes the digest to Vietnamese', 'fixup the queue'];

describe('the subject rules', () => {
  test('one list says which subjects break a rule, and which rule', async () => {
    const { subjectProblem } = await import(join(factory, 'kit/.gate/bin/lib/subject.mjs'));
    for (const [subject, rule] of BAD) assert.match(subjectProblem(subject) ?? '', rule, JSON.stringify(subject));
    for (const subject of GOOD) assert.equal(subjectProblem(subject), null, subject);
  });
});

describe('the hook and verify on a repository with the kit', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());
  const hooked = (args) => run(r.repo, 'git', args, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' });
  const subjects = () => script(r.repo, 'verify', ['--only', 'subjects'], { GATE_BASE: 'origin/main' });

  test('the hook still refuses what it refused, and now a fixup! or squash! subject', () => {
    write(r.repo, { 'README.md': '# app\n\nx\n' });
    git(r.repo, 'add', '-A');
    for (const subject of ['x'.repeat(73), 'WIP', 'wip', 'fix', 'update', 'changes', '.', BB8FF7B, 'fixup! Explain the app', 'squash! Explain the app'])
      assert.equal(hooked(['commit', '-qm', subject]).code, 1, subject);
    assert.equal(hooked(['commit', '-q', '--allow-empty-message', '-m', '']).code, 1, 'empty');
    assert.equal(hooked(['commit', '-qm', 'Explain the app in the README']).code, 0);
    git(r.repo, 'reset', '-q', '--hard', 'origin/main');
  });
  test('verify fails a commit whose subject breaks a rule, naming the commit and the rule', () => {
    const sha = commit(r.repo, { 'a.txt': 'a\n' }, BB8FF7B);
    commit(r.repo, { 'b.txt': 'b\n' }, 'fixup! Add b');
    commit(r.repo, { 'c.txt': 'c\n' }, 'Add c');
    const out = subjects();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, new RegExp(`${sha.slice(0, 7)}\\w*: the subject has 99 characters; at most 72`));
    assert.match(out.out, /fixup! Add b/);
    assert.match(out.out, /never squashed/);
    assert.doesNotMatch(out.out, /Add c/);
    git(r.repo, 'reset', '-q', '--hard', 'origin/main');
  });
  test('verify skips a merge commit, whatever its subject, and passes a clean change', () => {
    commit(r.repo, { 'a.txt': 'a\n' }, 'Add a');
    git(r.repo, 'switch', '-q', '-c', 'side', 'origin/main');
    commit(r.repo, { 'b.txt': 'b\n' }, 'Add b');
    git(r.repo, 'switch', '-q', 'work');
    git(r.repo, 'merge', '-q', '--no-ff', '-m', 'WIP', 'side');
    const out = subjects();
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /verify: 1 passed/);
    git(r.repo, 'reset', '-q', '--hard', 'origin/main');
    git(r.repo, 'branch', '-q', '-D', 'side');
  });
  test('prove-check shows the subjects check failing on its fixture, the 99-character subject of bb8ff7b', () => {
    const out = script(r.repo, 'prove-check', ['subjects']);
    assert.equal(out.code, 0, out.out);
    assert.match(readFileSync(join(r.repo, '.gate/proofs/subjects.sh'), 'utf8'), /Correct "pstack runs only when typed"/);
  });
});

describe("the factory's own pull requests", () => {
  test('the verify workflow fetches the full history and names the event base', () => {
    const workflow = readFileSync(join(factory, '.github/workflows/verify.yml'), 'utf8');
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /GATE_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  });
  test('the subject script run on a range names the commit that breaks a rule and skips a merge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subjects-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      const base = commit(dir, { a: '1\n' }, 'Start');
      git(dir, 'switch', '-q', '-c', 'side');
      commit(dir, { b: '1\n' }, 'Add b');
      git(dir, 'switch', '-q', 'main');
      const bad = commit(dir, { c: '1\n' }, 'update');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'WIP', 'side');
      const out = run(dir, 'node', [join(factory, 'kit/.gate/bin/lib/subject.mjs'), '--base', base]);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, new RegExp(`${bad.slice(0, 7)}\\w*: say what the commit changes, not 'update'`));
      assert.doesNotMatch(out.out, /WIP|Add b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what the subject is, and when the script runs', () => {
  const msg = (dir, text) => {
    const file = join(dir, 'msg');
    writeFileSync(file, text);
    return file;
  };
  const hook = (file) => run(factory, join(factory, 'kit/.githooks/commit-msg'), [file]);

  test('the subject is git\'s: blank and comment lines skipped, the first paragraph joined by spaces', async () => {
    const { subjectOf } = await import(join(factory, 'kit/.gate/bin/lib/subject.mjs'));
    assert.equal(subjectOf('\n\nAdd g\n\nbody\n'), 'Add g');
    assert.equal(subjectOf('# a comment\nAdd g\n# another\nmore\n\nbody'), 'Add g more');
    assert.equal(subjectOf('First line of\nthe subject\n\nbody'), 'First line of the subject');
    assert.equal(subjectOf(''), '');
  });
  test('the hook passes a message that opens with a blank line, and fails a two-line subject that is too long joined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subject-msg-'));
    try {
      assert.equal(hook(msg(dir, '\nAdd g\n')).code, 0);
      const out = hook(msg(dir, `${'a'.repeat(40)}\n${'b'.repeat(40)}\n\nbody\n`));
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /81 characters; at most 72/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('run through a symlinked path the script still judges, rather than exiting 0 unrun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subject-link-'));
    try {
      symlinkSync(join(factory, 'kit/.gate/bin/lib'), join(dir, 'lib'));
      const out = run(factory, 'node', [join(dir, 'lib/subject.mjs'), msg(dir, 'WIP\n')]);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /not 'WIP'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('the length is in characters, not UTF-16 units: 71 x and an emoji is 72', async () => {
    const { subjectProblem } = await import(join(factory, 'kit/.gate/bin/lib/subject.mjs'));
    assert.equal(subjectProblem(`${'x'.repeat(71)}\u{1F600}`), null);
    assert.match(subjectProblem(`${'x'.repeat(72)}\u{1F600}`), /73 characters/);
  });
  test('a subject holding a control character is reported as it is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subject-ctl-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      const base = commit(dir, { a: '1\n' }, 'Start');
      git(dir, 'switch', '-q', '-c', 'work');
      const file = msg(dir, 'WIP \u0001 odd\n');
      writeFileSync(join(dir, 'b'), '1\n');
      git(dir, 'add', 'b');
      git(dir, 'commit', '-q', '-F', file);
      const sha = git(dir, 'rev-parse', '--short', 'HEAD');
      const out = run(dir, 'node', [join(factory, 'kit/.gate/bin/lib/subject.mjs'), '--base', base]);
      assert.equal(out.code, 1, out.out);
      assert.ok(out.out.startsWith(`${sha}: say what the commit changes, not 'WIP \u0001 odd'`), JSON.stringify(out.out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('the factory\'s verify fails at once when it runs on a pull request with no base, even with the guard missing it ends in seconds', () => {
    // A stub node first on PATH: without the guard, verify would run its whole test suite, which runs this test again.
    const dir = mkdtempSync(join(tmpdir(), 'subject-stub-'));
    try {
      writeFileSync(join(dir, 'node'), '#!/bin/sh\necho "stub node: not run" >&2\nexit 0\n', { mode: 0o755 });
      const out = run(factory, join(factory, 'scripts/verify'), [], { GITHUB_EVENT_NAME: 'pull_request', GATE_BASE: '', PATH: `${dir}:${process.env.PATH}` }, 20_000);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /pull request but GATE_BASE is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('leading spaces do not hide a rule: "  WIP" is refused by the hook and by verify alike', async () => {
    const { subjectProblem } = await import(join(factory, 'kit/.gate/bin/lib/subject.mjs'));
    for (const subject of ['  WIP', ' fix', '  fixup! Add a', '   ']) assert.ok(subjectProblem(subject), JSON.stringify(subject));
    assert.equal(subjectProblem('  Add a thing'), null);
    const dir = mkdtempSync(join(tmpdir(), 'subject-space-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      const base = commit(dir, { a: '1\n' }, 'Start');
      git(dir, 'switch', '-q', '-c', 'work');
      writeFileSync(join(dir, 'b'), '1\n');
      git(dir, 'add', 'b');
      writeFileSync(join(dir, 'msg'), '  WIP\n');
      git(dir, 'commit', '-q', '--cleanup=verbatim', '-F', join(dir, 'msg'));
      // (git 2.x already drops the leading spaces in %s; the trim is for any git that keeps them.)
      const out = run(dir, 'node', [join(factory, 'kit/.gate/bin/lib/subject.mjs'), '--base', base]);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /not '  WIP'|not 'WIP'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
