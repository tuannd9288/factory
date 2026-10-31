// #279: a task's worktree goes once its work has landed, and a worktree with work still in it stays and is named.
// Fixtures only: a bare origin, a clone, worktrees on branches, and a faked merged-pull-request list and live count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepWorktrees } from '../bin/lib/worktrees.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

/** A clone whose origin/main holds one commit, with a worktree <runs>/<name>/w on branch <name> for each name. A name in
 * `commit` has one commit of its own, pushed into origin/main (landed); a name in `ahead` has one that is not. */
function fixture(names, { commit = [], ahead = [] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktrees-'))); // git names a worktree by its real path
  git(dir, 'init', '-q', '--bare', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'clone');
  const clone = join(dir, 'clone');
  git(clone, 'config', 'user.email', 'a@b.c');
  git(clone, 'config', 'user.name', 'a');
  git(clone, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(clone, 'f'), '1\n');
  git(clone, 'add', 'f');
  git(clone, 'commit', '-q', '-m', 'one');
  git(clone, 'push', '-q', 'origin', 'main');
  const runs = join(dir, 'runs');
  for (const name of names) {
    mkdirSync(join(runs, name), { recursive: true });
    writeFileSync(join(runs, name, 'log.jsonl'), 'a log\n');
    const path = join(runs, name, 'w');
    git(clone, 'worktree', 'add', '-q', '-b', name, path, 'main');
    if (commit.includes(name) || ahead.includes(name)) {
      writeFileSync(join(path, `${name}.txt`), 'x\n');
      git(path, 'add', '.');
      git(path, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', name);
    }
  }
  for (const name of commit) {
    git(clone, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, name);
  }
  git(clone, 'push', '-q', 'origin', 'main');
  const state = join(dir, 'state');
  mkdirSync(state);
  const sweep = (merged, live = () => 0) =>
    sweepWorktrees({ clones: [{ repo: 'o/app', dir: clone }], state, live, merged: () => new Set(merged) });
  const listed = () => git(clone, 'worktree', 'list', '--porcelain');
  return { dir, runs, clone, state, sweep, listed, report: join(state, 'queue-worktrees.failed') };
}

const withFixture = (names, opts, body) => {
  const f = fixture(names, opts);
  try {
    body(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
};

test('a merged, clean worktree is removed and unregistered, and its run folder keeps its files', () => {
  withFixture(['done'], { commit: ['done'] }, (f) => {
    const r = f.sweep(['done']);
    assert.equal(r.removed, 1);
    assert.ok(!existsSync(join(f.runs, 'done/w')));
    assert.ok(!f.listed().includes(join(f.runs, 'done/w')));
    assert.equal(readFileSync(join(f.runs, 'done/log.jsonl'), 'utf8'), 'a log\n');
    assert.ok(git(f.clone, 'branch', '--list', 'done').includes('done'), 'the branch stays');
    assert.ok(!existsSync(f.report));
  });
});

test('a merged worktree with a modified file is kept and named', () => {
  withFixture(['dirty'], { commit: ['dirty'] }, (f) => {
    writeFileSync(join(f.runs, 'dirty/w/f'), 'changed\n');
    const r = f.sweep(['dirty']);
    assert.equal(r.removed, 0);
    assert.ok(existsSync(join(f.runs, 'dirty/w')));
    assert.match(readFileSync(f.report, 'utf8'), new RegExp(`\n${join(f.runs, 'dirty/w')}\n`));
  });
});

test('a worktree with no merged pull request is kept without a report, one with no commit yet included', () => {
  withFixture(['fresh', 'open'], { ahead: ['open'] }, (f) => {
    const r = f.sweep([]);
    assert.equal(r.removed, 0);
    assert.ok(existsSync(join(f.runs, 'fresh/w')));
    assert.ok(existsSync(join(f.runs, 'open/w')));
    assert.ok(!existsSync(f.report));
  });
});

test('a worktree with a commit after its pull request merged is kept and named', () => {
  withFixture(['late'], { commit: ['late'] }, (f) => {
    const path = join(f.runs, 'late/w');
    writeFileSync(join(path, 'more.txt'), 'y\n');
    git(path, 'add', '.');
    git(path, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'more');
    const r = f.sweep(['late']);
    assert.equal(r.removed, 0);
    assert.ok(existsSync(path));
    assert.match(readFileSync(f.report, 'utf8'), new RegExp(`\n${path}\n`));
  });
});

test('a merged, clean worktree held by a live run is kept', () => {
  withFixture(['busy', 'idle'], { commit: ['busy', 'idle'] }, (f) => {
    const r = f.sweep(['busy', 'idle'], (path) => (path.startsWith(join(f.runs, 'busy')) ? 1 : 0));
    assert.equal(r.removed, 1);
    assert.ok(existsSync(join(f.runs, 'busy/w')));
    assert.ok(!existsSync(join(f.runs, 'idle/w')));
  });
});

test('a failing merged-pull-request read keeps the worktrees and says so', () => {
  withFixture(['done'], { commit: ['done'] }, (f) => {
    const r = sweepWorktrees({ clones: [{ repo: 'o/app', dir: f.clone }], state: f.state, live: () => 0, merged: () => { throw new Error('gh down'); } });
    assert.equal(r.removed, 0);
    assert.ok(existsSync(join(f.runs, 'done/w')));
    assert.match(readFileSync(f.report, 'utf8'), /o\/app: gh down/);
  });
});
