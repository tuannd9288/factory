// A task's worktree goes when its work has landed (#279). The queue's sweep calls sweepWorktrees after the checkout follows main: for
// each clone it reads `git worktree list --porcelain` (never a guessed path) and removes, with `git worktree remove` and never
// --force, each linked worktree that is on a branch with a merged pull request, whose HEAD is in origin/main, that is clean and that
// no live run holds. The branch and the run folder, its logs and transcripts stay. A worktree of merged work that is not clean or
// not in origin/main is kept and named in queue-worktrees.failed, so the Human sees it in the alerts.
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const first = (r) => String(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().split('\n')[0].slice(0, 200);

/** The linked worktrees of a clone (its own first one left out): {path, branch, head, locked, prunable}. */
function linked(git) {
  const list = git('worktree', 'list', '--porcelain');
  if (list.status !== 0) throw new Error(first(list));
  return list.stdout.split('\n\n').filter(Boolean).slice(1).map((block) => {
    const lines = block.split('\n');
    const has = (key) => lines.some((l) => l === key || l.startsWith(`${key} `));
    const value = (key) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
    return { path: value('worktree'), branch: value('branch')?.replace('refs/heads/', ''), locked: has('locked'), prunable: has('prunable') };
  });
}

/** clones: [{repo, dir}]. live(path) is how many runs hold that path (Infinity when unknown). merged(repo) is the set of head
 * branches of its merged pull requests; one that throws skips that clone this sweep. Returns {removed, kept}, kept being the
 * lines written to queue-worktrees.failed (removed when none). */
export function sweepWorktrees({ clones, state, live, merged, now = Date.now() }) {
  const report = join(state, 'queue-worktrees.failed');
  let removed = 0;
  const kept = [];
  for (const { repo, dir } of clones) {
    const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
    try {
      const open = linked(git).filter((w) => w.branch && !w.locked && !w.prunable && live(w.path) === 0);
      const landed = open.length ? merged(repo) : new Set();
      for (const w of open.filter((x) => landed.has(x.branch))) {
        const clean = spawnSync('git', ['-C', w.path, 'status', '--porcelain'], { encoding: 'utf8', timeout: 60_000 });
        // The branch is checked out there, so its tip is the worktree's HEAD.
        const inMain = git('merge-base', '--is-ancestor', `refs/heads/${w.branch}`, 'origin/main');
        if (clean.status !== 0 || clean.stdout.trim() || inMain.status !== 0) kept.push(w.path);
        else {
          const gone = git('worktree', 'remove', w.path);
          if (gone.status === 0) removed += 1;
          else kept.push(`${w.path}: ${first(gone)}`);
        }
      }
    } catch (error) {
      kept.push(`${repo}: ${String(error.stderr || error.message).trim().split('\n')[0].slice(0, 200)}`);
    }
    git('worktree', 'prune');
  }
  if (kept.length) writeFileSync(report, `${new Date(now).toISOString()} ${kept.length} worktrees of merged work kept or unchecked:\n${kept.join('\n')}\n`);
  else rmSync(report, { force: true });
  return { removed, kept };
}
