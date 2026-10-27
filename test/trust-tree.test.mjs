// A tree with two entries of one name (#132, REVIEW-3 N2): ls-tree lists both, a checkout writes the last, and the objects
// check read the first. The check refuses it, whatever the entries hold, so it and a checkout can never read two files.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { git } from './helpers.mjs';
import { trustWorld } from './trust-world.mjs';

describe('a candidate whose tree has two AGENTS.md entries', () => {
  let t;
  before(() => {
    t = trustWorld();
  });
  after(() => t.cleanup());

  /** A commit on the base whose tree lists `path` twice: the base's own blob, then `second`. */
  const duplicated = (path, second) => {
    git(t.r.repo, 'reset', '-q', '--hard');
    git(t.r.repo, 'switch', '-q', '-C', 'dup', t.baseSha);
    const secondBlob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: t.r.repo, input: second, encoding: 'utf8' }).stdout.trim();
    const lines = git(t.r.repo, 'ls-tree', t.baseSha).split('\n');
    const at = lines.findIndex((l) => l.endsWith(`\t${path}`));
    lines.splice(at + 1, 0, `100644 blob ${secondBlob}\t${path}`);
    const mk = spawnSync('git', ['mktree'], { cwd: t.r.repo, input: `${lines.join('\n')}\n`, encoding: 'utf8' });
    assert.equal(mk.status, 0, `git mktree: ${mk.stderr}`);
    const commitSha = git(t.r.repo, 'commit-tree', mk.stdout.trim(), '-p', t.baseSha, '-m', 'a tree with two entries');
    git(t.r.repo, 'reset', '-q', '--hard', commitSha);
    return commitSha;
  };

  test('is red when the second entry has no block, though the first is the base\'s good file', () => {
    duplicated('AGENTS.md', '# app\nno block, forged\n');
    const out = t.objects();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /more than one entry/);
  });

  test('is red for CLAUDE.md and .gate/gate-section.md too', () => {
    for (const path of ['CLAUDE.md', '.gate/gate-section.md']) {
      git(t.r.repo, 'reset', '-q', '--hard');
      duplicated(path, 'something else\n');
      const out = t.objects();
      assert.equal(out.code === 1 || out.code === 2, true, `${path}: ${out.out}`);
      assert.notEqual(out.code, 0, `${path}: ${out.out}`);
    }
  });
});
