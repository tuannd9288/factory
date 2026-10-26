// A blame fact names its file from the runs folder, like every other path in a key (#92).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

test('a blame fact whose file starts with the repository\'s folder is read inside the repository', async () => {
  const { verifyTask } = await import('../probes/research-eval/keys.mjs');
  const root = mkdtempSync(join(tmpdir(), 'reval-blame-path-'));
  try {
    const repo = join(root, 'issue-9/w9');
    mkdirSync(join(repo, 'test'), { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'test/t.txt'), 'x\ny\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'one');
    const sha = git(repo, 'rev-parse', '--short=7', 'HEAD');
    const fact = (file, counts) => ({ facts: [{ id: 'F1', source: { blame: 'issue-9/w9', rev: 'HEAD', file, ranges: [[1, 2]], counts } }] });
    assert.deepEqual(verifyTask(fact('issue-9/w9/test/t.txt', { [sha]: 2 }), root), []);
    assert.deepEqual(verifyTask(fact('test/t.txt', { [sha]: 2 }), root), []);
    assert.equal(verifyTask(fact('issue-9/w9/test/t.txt', { [sha]: 1 }), root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
