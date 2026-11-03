// bin/kit-update and .gitattributes (#380): it replaces the kit's review-categories block and nothing else of the file, the
// repository's head and tail stay byte for byte, and what it cannot merge it stops on. No test uses the network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, quiet, run } from './helpers.mjs';
import { world } from './world.mjs';

const exact = (w, rev, path) => run(w.repo, 'git', ['show', `${rev}:${path}`], quiet).out;
const kitFile = (w) => readFileSync(join(w.fac, 'kit/.gate/review-categories'), 'utf8');
const more = (text) => text.replace(/^(# factory:review-categories:end)/m, 'review-extra.txt review-assets\n$1');
const own = '*.png binary\nsrc/** review-implementation\n';

describe('bin/kit-update replaces only the review-categories block', () => {
  test('keeps the repository\'s head and tail byte for byte, and the update passes the evidence', () => {
    const w = world({ seedFiles: { '.gitattributes': own } });
    try {
      // The repository's own: blank lines before the block (its head) and a line more after its own lines (its tail).
      const onboarded = exact(w, 'HEAD', '.gitattributes');
      assert.equal(onboarded, `${kitFile(w)}\n${own}`);
      w.repoCommit({ '.gitattributes': `\n${onboarded}*.jpg binary` });
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const S2 = more(kitFile(w));
      w.facCommit({ 'kit/.gate/review-categories': S2 });
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      const branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(exact(w, branch, '.gitattributes'), `\n${S2}\n${own}*.jpg binary`);
      assert.equal(exact(w, branch, '.gate/review-categories'), S2);
      assert.deepEqual(git(w.repo, 'diff', '--name-only', base, branch).split('\n'), ['.gate/kit-commit', '.gate/review-categories', '.gitattributes']);
    } finally {
      w.cleanup();
    }
  });

  test('leaves a .gitattributes with the kit\'s block as it is, and gives one with no block the block at its start', () => {
    const w = world({ seedFiles: { '.gitattributes': own } });
    try {
      w.facCommit({ 'kit/.gate/old-new.txt': 'a kit file\n' });
      let out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      let branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(exact(w, branch, '.gitattributes'), exact(w, 'main', '.gitattributes'));
      git(w.repo, 'switch', '-q', 'main');
      git(w.repo, 'branch', '-q', '-D', branch);
      // A repository onboarded before the block existed: its own lines, no block.
      w.repoCommit({ '.gitattributes': own });
      out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(exact(w, branch, '.gitattributes'), `${kitFile(w)}\n${own}`);
    } finally {
      w.cleanup();
    }
  });

  test('stops on malformed or duplicate markers, a block out of place and CRLF, with nothing done', () => {
    const w = world({ seedFiles: { '.gitattributes': own } });
    try {
      const good = exact(w, 'HEAD', '.gitattributes');
      w.facCommit({ 'kit/.gate/review-categories': more(kitFile(w)) });
      for (const text of [good.replace(/^# factory:review-categories:end.*\n/m, ''), `${good}\n${good}`, `${own}${good}`, '*.png binary\r\n', good.replace(/\n/g, '\r\n')]) {
        w.repoCommit({ '.gitattributes': text });
        const before = w.state();
        const out = w.update(['app', '--no-pr']);
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, /\.gitattributes/);
        assert.deepEqual(w.state(), before);
        w.repoCommit({ '.gitattributes': good });
      }
    } finally {
      w.cleanup();
    }
  });

  test('stops on a .gitattributes that is a link, with nothing done', () => {
    const w = world();
    try {
      rmSync(join(w.repo, '.gitattributes'));
      symlinkSync('AGENTS.md', join(w.repo, '.gitattributes'));
      git(w.repo, 'add', '-A');
      git(w.repo, 'commit', '-qm', 'link .gitattributes');
      git(w.repo, 'push', '-q', 'origin', 'main');
      w.facCommit({ 'kit/.gate/old-new.txt': 'a kit file\n' });
      const before = w.state();
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /\.gitattributes/);
      assert.deepEqual(w.state(), before);
    } finally {
      w.cleanup();
    }
  });

  test('never overwrites an untracked .gitattributes the clone holds, ignored or not', () => {
    for (const ignore of [true, false]) {
      const w = world();
      try {
        w.repoCommit({ ...(ignore ? { '.gitignore': '.gitattributes\n' } : {}), '.gitattributes': null });
        writeFileSync(join(w.repo, '.gitattributes'), '*.png binary\n');
        w.facCommit({ 'kit/.gate/old-new.txt': 'a kit file\n' });
        const before = w.state();
        const out = w.update(['app', '--no-pr']);
        assert.equal(out.code, 2, out.out);
        assert.deepEqual(w.state(), before);
        assert.equal(readFileSync(join(w.repo, '.gitattributes'), 'utf8'), '*.png binary\n');
      } finally {
        w.cleanup();
      }
    }
  });

  test('a .gitignore that ignores .gitattributes does not keep the file out of the update', () => {
    const w = world();
    try {
      // The repository has no .gitattributes and ignores the path; the kit's file must still land.
      w.repoCommit({ '.gitignore': '.gitattributes\n', '.gitattributes': null });
      w.facCommit({ 'kit/.gate/old-new.txt': 'a kit file\n' });
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      const branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(exact(w, branch, '.gitattributes'), kitFile(w));
    } finally {
      w.cleanup();
    }
  });
});
