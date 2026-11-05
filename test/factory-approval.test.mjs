import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run } from './helpers.mjs';

test('the factory keeps approval across a stack parent landing, but a changed patch needs approval (#456)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-approval-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, { 'base.txt': 'base\n' });
    git(dir, 'switch', '-qc', 'parent');
    const parent = commit(dir, { 'parent.txt': 'parent\n' });
    git(dir, 'switch', '-qc', 'child');
    const approved = commit(dir, { 'child.txt': 'child\n' });
    writeFileSync(join(dir, 'owners'), '* @reviewer\n');
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify([{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: approved, submitted_at: '2026-11-05T00:00:00Z' }]));
    const judge = (head, base) => run(dir, 'sh', ['-c', 'node "$1" --owners owners --author writer --head "$2" --base "$3" < reviews.json', 'sh',
      join(factory, 'kit/.gate/bin/lib/approval.mjs'), head, base]);
    git(dir, 'switch', '-q', 'main');
    git(dir, 'merge', '--no-ff', parent, '-m', 'land parent');
    const base = git(dir, 'rev-parse', 'HEAD');
    assert.equal(judge(approved, base).code, 0);
    git(dir, 'switch', '-q', 'child');
    git(dir, 'merge', '--no-ff', 'main', '-m', 'update child');
    const carried = judge(git(dir, 'rev-parse', 'HEAD'), base);
    assert.equal(carried.code, 0, carried.out);
    assert.match(carried.out, /whose patch the head carries unchanged/);
    const changed = commit(dir, { 'child.txt': 'changed\n' });
    assert.equal(judge(changed, base).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
