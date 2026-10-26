// The research eval's keys (#92, review of the build, B1 and the task source): a session reads only the folders its task needs,
// the brief names those and no others, and a key can say how `git blame` splits a range of lines between commits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keys = () => import('../probes/research-eval/keys.mjs');

const under = (path, folder) => path === folder || path.startsWith(`${folder}/`);
const sourcePath = (s) => s.file ?? s.git ?? s.dir ?? s.blame;

test('every task names the folders a session may read: inside its sources, and holding the place of every fact', async () => {
  const { loadTasks } = await keys();
  const tasks = loadTasks();
  assert.ok(tasks.length > 0, 'no tasks');
  for (const t of tasks) {
    assert.ok(Array.isArray(t.readable) && t.readable.length > 0, `${t.id}: readable`);
    for (const r of t.readable) {
      assert.ok(t.sources.some((s) => under(r, s)), `${t.id}: ${r} is outside its sources`);
      assert.ok(!r.endsWith('/') && !r.includes('..'), `${t.id}: ${r}`);
    }
    for (const f of t.facts) assert.ok(t.readable.some((r) => under(sourcePath(f.source), r)), `${t.id} ${f.id}: ${sourcePath(f.source)} is in no readable folder`);
  }
});

test('the folders are narrower than the run folders: no task may read a whole run folder', async () => {
  const { loadTasks } = await keys();
  for (const t of loadTasks()) for (const r of t.readable ?? ['issue-0']) assert.ok(!/^issue-\d+$/.test(r), `${t.id}: ${r} is a whole run folder`);
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

function blameWorld(body) {
  const root = mkdtempSync(join(tmpdir(), 'reval-blame-'));
  try {
    const repo = join(root, 'issue-9');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    const commit = (text, msg) => {
      writeFileSync(join(repo, 'f.txt'), text);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', msg);
      return git(repo, 'rev-parse', '--short=7', 'HEAD');
    };
    const a = commit('a1\na2\na3\n', 'one');
    const b = commit('a1\na2\na3\nb4\nb5\nb6\n', 'two');
    const c = commit('a1\nc2\na3\nb4\nb5\nb6\n', 'three');
    return body(root, { a, b, c, head: git(repo, 'rev-parse', 'HEAD') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a blame fact counts the lines of some ranges by the commit that wrote them', async () => {
  const { verifyTask } = await keys();
  blameWorld((root, { a, b, c, head }) => {
    const task = (counts) => ({ facts: [{ id: 'F1', source: { blame: 'issue-9', rev: head, file: 'f.txt', ranges: [[1, 2], [4, 6]], counts } }] });
    assert.deepEqual(verifyTask(task({ [a]: 1, [c]: 1, [b]: 3 }), root), []);
    const wrong = verifyTask(task({ [a]: 2, [b]: 3 }), root);
    assert.equal(wrong.length, 1);
    assert.match(wrong[0].why, /blame/);
    assert.match(wrong[0].why, new RegExp(c));
  });
});

test('a blame fact may name its file from the runs folder, as every other path in a key does', async () => {
  const { verifyTask } = await keys();
  blameWorld((root, { a, b, c, head }) => {
    const task = (file, counts) => ({ facts: [{ id: 'F1', source: { blame: 'issue-9', rev: head, file, ranges: [[1, 2], [4, 6]], counts } }] });
    assert.deepEqual(verifyTask(task('issue-9/f.txt', { [a]: 1, [c]: 1, [b]: 3 }), root), []);
    assert.equal(verifyTask(task('issue-9/f.txt', { [a]: 2, [b]: 3 }), root).length, 1);
  });
});

test('a blame fact stays under the runs folder', async () => {
  const { verifyTask } = await keys();
  blameWorld((root, { head }) => {
    const bad = verifyTask({ facts: [{ id: 'F1', source: { blame: '../x', rev: head, file: 'f.txt', ranges: [[1, 1]], counts: {} } }] }, root);
    assert.match(bad[0].why, /outside/);
  });
});
