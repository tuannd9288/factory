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
    const judge = (head, base, ...more) => run(dir, 'sh', ['-c', 'js=$1 head=$2 base=$3; shift 3; node "$js" --owners owners --author writer --head "$head" --base "$base" "$@" < reviews.json', 'sh',
      join(factory, 'kit/.gate/bin/lib/approval.mjs'), head, base, ...more]);
    // FAC-41: the child moved onto main before its parent landed (as #490 was by hand, 2026-11-06) carries the parent's change, which the
    // approval of the child on its parent's branch never showed; one given after the move saw that diff and counts.
    const early = git(dir, 'rev-parse', 'main');
    const refused = judge(approved, early, '--moved-at', '2026-11-05T01:00:00Z', '--parent-head', 'none');
    assert.equal(refused.code, 1, refused.out);
    assert.equal(judge(approved, early, '--moved-at', '2026-11-04T23:00:00Z', '--parent-head', 'none').code, 0);
    git(dir, 'switch', '-q', 'main');
    git(dir, 'merge', '--no-ff', parent, '-m', 'land parent');
    const base = git(dir, 'rev-parse', 'HEAD');
    assert.equal(judge(approved, base).code, 0);
    git(dir, 'switch', '-q', 'child');
    git(dir, 'merge', '--no-ff', 'main', '-m', 'update child');
    const carried = judge(git(dir, 'rev-parse', 'HEAD'), base);
    assert.equal(carried.code, 0, carried.out);
    assert.match(carried.out, /whose patch the head carries unchanged/);
    // Moved onto main once its parent's pull request had merged there: the approval carries, on the moved head and on the updated one.
    for (const head of [approved, git(dir, 'rev-parse', 'HEAD')]) {
      const moved = judge(head, base, '--moved-at', '2026-11-05T01:00:00Z', '--parent-head', parent);
      assert.equal(moved.code, 0, moved.out);
    }
    const changed = commit(dir, { 'child.txt': 'changed\n' });
    assert.equal(judge(changed, base).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
