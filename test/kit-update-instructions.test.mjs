// bin/kit-update and the instruction files (#132): it replaces the Gate block and nothing else of AGENTS.md, keeps the
// repository's CLAUDE.md as it is (an addendum, a symlink and its mode), and writes .gate/kit-commit. What it makes is
// what verify-trusted accepts as a genuine update: the objects check passes it against a local bare factory, and fails
// the same update with one byte of the tail changed. No test uses the network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, quiet, run } from './helpers.mjs';
import { world } from './world.mjs';
import { FIVE, rulebook } from './instruction-fixtures.mjs';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const exact = (w, rev, path) => run(w.repo, 'git', ['show', `${rev}:${path}`], quiet).out;
const modeOf = (w, rev, path) => git(w.repo, 'ls-tree', rev, '--', path).split(' ')[0];
const sectionNow = (w) => readFileSync(join(w.fac, 'kit/.gate/gate-section.md'), 'utf8');
const next = (text) => text.replace('gate-section-v1', 'gate-section-v2');

/** A world whose repository, seeded with `seedFiles` (and a CLAUDE.md link when `link` is given), is onboarded and merged. */
function made({ seedFiles = {}, link = null } = {}) {
  const w = world({ onboardArgs: null, seedFiles });
  if (link) {
    const clone = join(w.dir, 'seed-clone');
    git(w.dir, 'clone', '-q', w.url, clone);
    symlinkSync(link, join(clone, 'CLAUDE.md'));
    commit(clone, {}, 'link CLAUDE.md');
    git(clone, 'push', '-q', 'origin', 'main');
  }
  const first = w.onboard();
  assert.equal(first.code, 0, first.out);
  git(w.repo, 'switch', '-q', 'main');
  git(w.repo, 'merge', '-q', '--ff-only', 'factory/kit');
  git(w.repo, 'push', '-q', 'origin', 'main');
  return w;
}
/** The factory as a bare repository, for GATE_FACTORY_URL, at its present commits. */
const bareOf = (w) => {
  const bare = join(w.dir, 'factory.git');
  git(w.dir, 'clone', '-q', '--bare', w.fac, bare);
  return bare;
};
const objects = (w, base, bare) =>
  run(w.repo, process.execPath, [join(w.fac, 'kit/.gate/bin/lib/instructions.mjs'), 'objects', '--repo', w.repo, '--base', base, '--head', 'HEAD'], { GATE_FACTORY_URL: bare });

describe('bin/kit-update replaces only the Gate block', () => {
  for (const [name, options, carrier] of [
    ['an addendum', { seedFiles: { 'AGENTS.md': rulebook(FIVE.B), 'CLAUDE.md': '@AGENTS.md\n\n## For Claude Code only\n\nUse plan mode.\n' } }, 'addendum'],
    ['a symlink', { seedFiles: { 'AGENTS.md': rulebook(FIVE.E) }, link: 'AGENTS.md' }, 'symlink'],
  ]) {
    test(`with ${name} as the carrier: the tail and the carrier stay byte for byte, and the update passes the objects check`, async () => {
      const { replaceGate } = await lib();
      const w = made(options);
      try {
        const base = git(w.repo, 'rev-parse', 'HEAD');
        const baseAgents = exact(w, base, 'AGENTS.md');
        const S2 = next(sectionNow(w));
        w.facCommit({ 'kit/.gate/gate-section.md': S2 });
        const out = w.update(['app', '--no-pr']);
        assert.equal(out.code, 0, out.out);
        assert.match(out.out, /^kit-evidence: PASS$/m);
        const branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
        assert.equal(exact(w, branch, 'AGENTS.md'), replaceGate(baseAgents, S2));
        assert.equal(exact(w, branch, '.gate/gate-section.md'), S2);
        assert.equal(exact(w, branch, '.gate/kit-commit'), `${git(w.fac, 'rev-parse', 'HEAD')}\n`);
        assert.equal(modeOf(w, branch, 'CLAUDE.md'), modeOf(w, base, 'CLAUDE.md'));
        assert.equal(modeOf(w, branch, 'CLAUDE.md'), carrier === 'symlink' ? '120000' : '100644');
        assert.equal(exact(w, branch, 'CLAUDE.md'), exact(w, base, 'CLAUDE.md'));
        assert.deepEqual(git(w.repo, 'diff', '--name-only', base, branch).split('\n'), ['.gate/gate-section.md', '.gate/kit-commit', 'AGENTS.md']);
        // What it made is a genuine update to verify-trusted: the factory's main holds the commit and the block.
        const bare = bareOf(w);
        const good = objects(w, base, bare);
        assert.equal(good.code, 0, good.out);
        // The same update with one byte of the tail changed is not.
        commit(w.repo, { 'AGENTS.md': `${exact(w, branch, 'AGENTS.md')}x` }, 'one more byte');
        const bad = objects(w, base, bare);
        assert.equal(bad.code, 1, bad.out);
        assert.match(bad.out, /tail/);
      } finally {
        w.cleanup();
      }
    });
  }

  test('an update that leaves the block as it is still records the new factory commit, and does nothing twice', () => {
    const w = made({ seedFiles: { 'AGENTS.md': rulebook(FIVE.E) } });
    try {
      const base = git(w.repo, 'rev-parse', 'HEAD');
      w.facCommit({ 'kit/.gate/old-new.txt': 'a kit file\n' });
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      const branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(exact(w, branch, 'AGENTS.md'), exact(w, base, 'AGENTS.md'));
      assert.equal(exact(w, branch, '.gate/kit-commit'), `${git(w.fac, 'rev-parse', 'HEAD')}\n`);
      const good = objects(w, base, bareOf(w));
      assert.equal(good.code, 0, good.out);
      git(w.repo, 'switch', '-q', 'main');
      git(w.repo, 'merge', '-q', '--ff-only', branch);
      git(w.repo, 'push', '-q', 'origin', 'main');
      git(w.repo, 'branch', '-q', '-D', branch);
      const again = w.update(['app', '--no-pr']);
      assert.equal(again.code, 0, again.out);
      assert.match(again.out, /already holds the kit/);
    } finally {
      w.cleanup();
    }
  });

  test('refuses, changing nothing, when the new block would push the file over 150 lines', async () => {
    const { countLines, insertGate } = await lib();
    const w = world({ onboardArgs: null });
    const S1 = sectionNow(w);
    const fill = 1 + (150 - countLines(insertGate('# app\nx\n', S1)));
    w.cleanup();
    const v = made({ seedFiles: { 'AGENTS.md': `# app\n${'x\n'.repeat(fill)}` } });
    try {
      assert.equal(countLines(exact(v, 'HEAD', 'AGENTS.md')), 150);
      const before = v.state();
      v.facCommit({ 'kit/.gate/gate-section.md': sectionNow(v).replace('<!-- factory:gate:end -->', 'one line more\n<!-- factory:gate:end -->') });
      const out = v.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /AGENTS\.md has 151 lines \(at most 150\)/);
      assert.deepEqual(v.state(), before);
    } finally {
      v.cleanup();
    }
  });

  test('refuses malformed markers, an AGENTS.md with no markers that is not the old kit\'s, and a CLAUDE.md that does not reach it', () => {
    const w = made({ seedFiles: { 'AGENTS.md': rulebook(FIVE.E) } });
    try {
      const good = exact(w, 'HEAD', 'AGENTS.md');
      w.facCommit({ 'kit/.gate/gate-section.md': next(sectionNow(w)) });
      for (const [files, why] of [
        [{ 'AGENTS.md': good.replace('<!-- factory:gate:end -->\n', '') }, /AGENTS\.md/],
        [{ 'AGENTS.md': '# app\n\nhand merged, no markers\n' }, /AGENTS\.md/],
        [{ 'CLAUDE.md': 'AGENTS.md\n' }, /CLAUDE\.md/],
      ]) {
        w.repoCommit(files);
        const before = w.state();
        const out = w.update(['app', '--no-pr']);
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, why);
        assert.deepEqual(w.state(), before);
        w.repoCommit({ 'AGENTS.md': good, 'CLAUDE.md': '@AGENTS.md\n' });
      }
    } finally {
      w.cleanup();
    }
  });
});
