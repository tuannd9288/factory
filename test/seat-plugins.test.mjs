// bin/seat (#185): before each session it installs the work folder's enabled plugins into the seat's own root, and gives the
// session that root as its plugin cache, whatever the caller had set. And (FAC-108) it runs origin/main's gate_prepare in the
// worktree, outside the sandbox, at the worktree's first start unless origin/main's .gate/driver.json says every start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PSTACK_SETTINGS, until, world } from './seat-world.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const commitTo = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main moves');
};
/** A local origin whose main holds files, cloned into the world's work folder, as a Lead's worktree from origin/main. */
const mainWith = (w, files) => {
  git(w.root, 'init', '-q', '--bare', '-b', 'main', join(w.root, 'origin.git'));
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), join(w.root, 'seed'));
  commitTo(join(w.root, 'seed'), files);
  git(join(w.root, 'seed'), 'push', '-q', 'origin', 'HEAD:main');
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), w.work);
};
/** main moves on origin, and the worktree fetches it: origin/main is ahead of the worktree's HEAD. */
const advance = (w, files) => {
  commitTo(join(w.root, 'seed'), files);
  git(join(w.root, 'seed'), 'push', '-q', 'origin', 'HEAD:main');
  git(w.work, 'fetch', '-q', 'origin');
};
const prepare = (body) => ({ '.gate/config.sh': `gate_prepare() {\n  ${body}\n}\n` });
const prepared = (w) => (existsSync(join(w.root, 'prep.out')) ? readFileSync(join(w.root, 'prep.out'), 'utf8') : '');

test('the plugins install before the session, and the session gets the root as its cache', () => world(async (w) => {
  w.settings(PSTACK_SETTINGS);
  const r = w.start('worker', [], { CLAUDE_CODE_PLUGIN_CACHE_DIR: '/elsewhere' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const root = join(w.home, '.local/share/factory/plugins/seats/2/claude');
  assert.equal(w.pluginCalls().length, 2);
  for (const c of w.pluginCalls()) assert.equal(c.env.CLAUDE_CODE_PLUGIN_CACHE_DIR, root);
  const { env } = w.saw();
  assert.equal(env.pluginCache, root);
  assert.equal(env.config, join(w.profiles, 'seats/2/claude'));
  assert.ok(!existsSync(join(w.profiles, 'seats/2')), 'nothing was made under the profile');
}));

test('a work folder with no plugin skips the install, and the root is still the cache', () => world(async (w) => {
  const r = w.start('worker');
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.pluginCalls().length, 0);
  assert.equal(w.saw().env.pluginCache, join(w.home, '.local/share/factory/plugins/seats/2/claude'));
}));

test('a failed install refuses the start, with the reason, and leaves no run behind', () => world(async (w) => {
  w.settings(PSTACK_SETTINGS);
  w.pluginMode('fail');
  const r = w.start('worker');
  assert.equal(r.code, 2);
  assert.match(r.err, /bin\/seat: plugins: .*marketplace add exited 1: boom/);
  assert.deepEqual(readdirSync(w.run).filter((n) => /\.(pid|seat|claim)/.test(n)), []);
  assert.deepEqual(w.records(), []);
}));

// The launcher's PATH, with git on it: the world's own has the fake claude and node only.
const withGit = (w, extra = {}) => ({ PATH: `${w.env().PATH}:/usr/bin:/bin`, PREP_OUT: join(w.root, 'prep.out'), ...extra });

test('origin/main\'s gate_prepare, not the worktree\'s copy, runs in the worktree before the session, with no credential in its environment', () => world(async (w) => {
  mainWith(w, prepare('echo old >> "$PREP_OUT"'));
  advance(w, prepare('echo "main $1 ${GH_TOKEN:-none} ${ANTHROPIC_BASE_URL:-none} ${FACTORY_SANDBOX:-none}" >> "$PREP_OUT"'));
  const r = w.start('worker', [], withGit(w, { GH_TOKEN: 'gh-not-a-token', ANTHROPIC_BASE_URL: 'https://example.invalid' }));
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const line = `main ${w.work} none none none\n`;
  assert.equal(prepared(w), line);
  assert.equal(w.saw().env.prepOut, line, 'the install had run when the session started');
  assert.equal(readFileSync(join(w.run, 'run-worker.prepare.log'), 'utf8'), '');
}));

test('a failed gate_prepare refuses the start before any session: its output is in the run folder, and no pid, claim or seat file is left', () => world(async (w) => {
  mainWith(w, prepare('echo boom >&2; return 3'));
  const r = w.start('worker', [], withGit(w));
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /bin\/seat: prepare: origin\/main's gate_prepare failed \(exit 3\): boom/);
  assert.match(readFileSync(join(w.run, 'run-worker.prepare.log'), 'utf8'), /boom/);
  assert.deepEqual(readdirSync(w.run).filter((n) => /\.(pid|seat|account|name|claim)/.test(n)), []);
  assert.ok(!existsSync(w.out()), 'no session started');
  assert.deepEqual(w.records(), []);
}));

test('the install runs at the worktree\'s first start only, whatever the seat removes; prepare every in origin/main\'s driver.json runs it at each start', () => world(async (w) => {
  mainWith(w, prepare('echo run >> "$PREP_OUT"'));
  assert.equal(w.start('worker', [], withGit(w)).code, 0);
  await until(() => w.records().length === 1, 'the first record');
  // A seat writes its worktree and its run folder; the stamp is in neither, so removing what it left there brings no install back.
  rmSync(join(w.run, 'run-worker.prepare.log'));
  assert.equal(w.start('worker', ['--tag', 'fix1'], withGit(w)).code, 0);
  await until(() => w.records().length === 2, 'the fix round\'s record');
  assert.equal(prepared(w), 'run\n');
  advance(w, { '.gate/driver.json': JSON.stringify({ prepare: 'every' }) });
  assert.equal(w.start('worker', ['--tag', 'fix2'], withGit(w)).code, 0);
  await until(() => w.records().length === 3, 'the second fix round\'s record');
  assert.equal(prepared(w), 'run\nrun\n');
}));

test('a first start in a worktree holding a commit main lacks installs nothing, writes no stamp, says why in its log and starts as before', () => world(async (w) => {
  mainWith(w, prepare('echo run >> "$PREP_OUT"'));
  commitTo(w.work, { 'pnpm-lock.yaml': 'a lockfile the branch changed\n' });
  const r = w.start('worker', [], withGit(w));
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(prepared(w), '', 'only a tree main had is installed outside the sandbox');
  assert.ok(!existsSync(join(w.state, 'prepared')), 'no stamp');
  assert.match(readFileSync(join(w.run, 'run-worker.prepare.log'), 'utf8'), /^prepare: not run: the worktree .* holds 1 commit\(s\) main lacks/);
}));

test('a main with no .gate/config.sh starts as before, even when the worktree has one of its own', () => world(async (w) => {
  mainWith(w, { 'README.md': 'x\n' });
  mkdirSync(join(w.work, '.gate'));
  writeFileSync(join(w.work, '.gate/config.sh'), 'gate_prepare() {\n  echo worktree >> "$PREP_OUT"\n}\n');
  const r = w.start('worker', [], withGit(w));
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(prepared(w), '');
  assert.ok(!existsSync(join(w.run, 'run-worker.prepare.log')));
}));

test('a command gate_prepare runs that is not on bin/seat\'s PATH refuses the start, naming the PATH', () => world(async (w) => {
  mainWith(w, prepare('pnpm-not-on-this-path install --frozen-lockfile'));
  const env = withGit(w);
  const r = w.start('worker', [], env);
  assert.equal(r.code, 2, r.out + r.err);
  assert.ok(r.err.includes(`not on bin/seat's PATH (${env.PATH})`), r.err);
  assert.ok(!existsSync(w.out()));
}));
