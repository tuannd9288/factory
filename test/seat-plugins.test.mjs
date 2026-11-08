// bin/seat (#185): before each session it installs the work folder's enabled plugins into the seat's own root, and gives the
// session that root as its plugin cache, whatever the caller had set. And (FAC-108) it runs main's gate_prepare, at the commit the
// Lead names with --main, in the worktree, outside the sandbox, at the worktree's first start unless main's .gate/driver.json says every.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { prepareWork } from '../bin/lib/prepare.mjs';
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
/** A local origin whose main holds files, cloned into the world's work folder, as a Lead's worktree made at main's commit; that commit. */
const mainWith = (w, files) => {
  git(w.root, 'init', '-q', '--bare', '-b', 'main', join(w.root, 'origin.git'));
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), join(w.root, 'seed'));
  commitTo(join(w.root, 'seed'), files);
  git(join(w.root, 'seed'), 'push', '-q', 'origin', 'HEAD:main');
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), w.work);
  return git(join(w.root, 'seed'), 'rev-parse', 'HEAD');
};
/** main moves on origin, and the worktree fetches it; main's new commit. */
const advance = (w, files) => {
  commitTo(join(w.root, 'seed'), files);
  git(join(w.root, 'seed'), 'push', '-q', 'origin', 'HEAD:main');
  git(w.work, 'fetch', '-q', 'origin');
  return git(join(w.root, 'seed'), 'rev-parse', 'HEAD');
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
/** prepareWork as bin/seat calls it, for what a seat does between two starts (Colly's probe of #550). */
const prepareAt = (w, tag, main, work = w.work) => prepareWork({ work, run: w.run, tag, state: w.state, env: { ...withGit(w), HOME: w.home }, main });

test('main\'s gate_prepare at the commit --main names, not the worktree\'s copy, runs in the worktree before the session, with no credential in its environment', () => world(async (w) => {
  const main = mainWith(w, { ...prepare('echo "main $1 ${GH_TOKEN:-none} ${ANTHROPIC_BASE_URL:-none} ${FACTORY_SANDBOX:-none}" >> "$PREP_OUT"'), '.gate/driver.json': '{"prepare":"every"}' });
  writeFileSync(join(w.work, '.gate/config.sh'), 'gate_prepare() {\n  echo worktree >> "$PREP_OUT"\n}\n');
  const r = w.start('worker', ['--main', main], withGit(w, { GH_TOKEN: 'gh-not-a-token', ANTHROPIC_BASE_URL: 'https://example.invalid' }));
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const line = `main ${w.work} none none none\n`;
  assert.equal(prepared(w), line);
  assert.equal(w.saw().env.prepOut, line, 'the install had run when the session started');
  assert.equal(readFileSync(join(w.run, 'run-worker.prepare.log'), 'utf8'), '');
}));

test('a failed gate_prepare refuses the start before any session: its output is in the run folder, and no pid, claim or seat file is left', () => world(async (w) => {
  const main = mainWith(w, prepare('echo boom >&2; return 3'));
  const r = w.start('worker', ['--main', main], withGit(w));
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /bin\/seat: prepare: main's gate_prepare failed \(exit 3\): boom/);
  assert.match(readFileSync(join(w.run, 'run-worker.prepare.log'), 'utf8'), /boom/);
  assert.deepEqual(readdirSync(w.run).filter((n) => /\.(pid|seat|account|name|claim)/.test(n)), []);
  assert.ok(!existsSync(w.out()), 'no session started');
  assert.deepEqual(w.records(), []);
}));

test('the install runs at the worktree\'s first start only, whatever the seat removes, and not again in a worktree made at the same path; prepare every in main\'s driver.json runs it at each start', () => world(async (w) => {
  const main = mainWith(w, prepare('echo run >> "$PREP_OUT"'));
  assert.equal(w.start('worker', ['--main', main], withGit(w)).code, 0);
  await until(() => w.records().length === 1, 'the first record');
  // A seat writes its worktree and its run folder; the stamp is in neither, so removing what it left there brings no install back.
  rmSync(join(w.run, 'run-worker.prepare.log'));
  assert.equal(w.start('worker', ['--tag', 'fix1'], withGit(w)).code, 0);
  await until(() => w.records().length === 2, 'the fix round\'s record');
  assert.equal(prepared(w), 'run\n');
  // A worktree made again at the same path is the same worktree: no install, whatever main's next commit says.
  const next = advance(w, { '.gate/driver.json': JSON.stringify({ prepare: 'every' }) });
  rmSync(w.work, { recursive: true, force: true });
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), w.work);
  assert.equal(w.start('worker', ['--tag', 'fix2', '--main', next], withGit(w)).code, 0);
  await until(() => w.records().length === 3, 'fix2\'s record');
  assert.equal(prepared(w), 'run\n');
  // A worktree at a new path, made at that commit, which says every: each of its starts installs.
  const fresh = join(w.root, 'work2');
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), fresh);
  for (const [n, tag] of [[4, 'fix3'], [5, 'fix4']]) {
    assert.equal(w.seat(['worker', join(w.run, 'BRIEF.md'), '--run', w.run, '--work', fresh, '--tag', tag, '--main', next], withGit(w)).code, 0);
    await until(() => w.records().length === n, `${tag}'s record`);
  }
  assert.equal(prepared(w), 'run\nrun\nrun\n');
}));

test('a first start in a worktree holding a commit main lacks installs nothing, writes no stamp, says why in its log and starts as before', () => world(async (w) => {
  const main = mainWith(w, prepare('echo run >> "$PREP_OUT"'));
  commitTo(w.work, { 'pnpm-lock.yaml': 'a lockfile the branch changed\n' });
  const r = w.start('worker', ['--main', main], withGit(w));
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(prepared(w), '', 'only a tree main had is installed outside the sandbox');
  assert.deepEqual(readdirSync(join(w.state, 'prepared')).filter((n) => !n.includes('.')), [], 'no stamp beside the record and the session mark');
  assert.match(readFileSync(join(w.run, 'run-worker.prepare.log'), 'utf8'), /^prepare: not run: the worktree differs from main's commit [0-9a-f]{7} at pnpm-lock\.yaml/);
}));

test('a main with no .gate/config.sh starts as before, even when the worktree has one of its own; so does a start with no --main', () => world(async (w) => {
  const main = mainWith(w, { 'README.md': 'x\n' });
  mkdirSync(join(w.work, '.gate'));
  writeFileSync(join(w.work, '.gate/config.sh'), 'gate_prepare() {\n  echo worktree >> "$PREP_OUT"\n}\n');
  const r = w.start('worker', ['--main', main], withGit(w));
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(prepared(w), '');
  assert.ok(!existsSync(join(w.run, 'run-worker.prepare.log')));
  // A worktree started with no --main, as by a Lead from before this: nothing installs, the log says why, and the session starts.
  const other = join(w.root, 'other');
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), other);
  const r2 = w.seat(['worker', join(w.run, 'BRIEF.md'), '--run', w.run, '--work', other, '--tag', 'other'], withGit(w));
  assert.equal(r2.code, 0, r2.out + r2.err);
  await until(() => w.records().length === 2, 'the second record');
  assert.match(readFileSync(join(w.run, 'run-other.prepare.log'), 'utf8'), /^prepare: not run: bin\/seat was given no --main/);
}));

test('a command gate_prepare runs that is not on bin/seat\'s PATH refuses the start, naming the PATH', () => world(async (w) => {
  const main = mainWith(w, prepare('pnpm-not-on-this-path install --frozen-lockfile'));
  const env = withGit(w);
  const r = w.start('worker', ['--main', main], env);
  assert.equal(r.code, 2, r.out + r.err);
  assert.ok(r.err.includes(`not on bin/seat's PATH (${env.PATH})`), r.err);
  assert.ok(!existsSync(w.out()));
}));

// What a seat can write is the clone's shared git dir (refs, config, objects, the index): none of it decides what runs (Colly, #550).
test('a seat that commits its own gate_prepare and driver.json and moves origin/main has neither run at the next start', () => world(async (w) => {
  const main = mainWith(w, prepare('echo main >> "$PREP_OUT"'));
  prepareAt(w, 't1', main);
  commitTo(w.work, { ...prepare('echo seat >> "$PREP_OUT"'), '.gate/driver.json': '{"prepare":"every"}' });
  git(w.work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  prepareAt(w, 't2', main);
  assert.equal(prepared(w), 'main\n');
}));

test('a replace ref on main\'s config.sh blob does not change what runs', () => world(async (w) => {
  const main = mainWith(w, prepare('echo main >> "$PREP_OUT"'));
  writeFileSync(join(w.root, 'seat.sh'), 'gate_prepare() {\n  echo seat >> "$PREP_OUT"\n}\n');
  git(w.work, 'replace', git(w.work, 'rev-parse', `${main}:.gate/config.sh`), git(w.work, 'hash-object', '-w', join(w.root, 'seat.sh')));
  prepareAt(w, 't1', main);
  assert.equal(prepared(w), 'main\n');
}));

test('a forged loose object of main\'s config.sh is not read as main\'s: the first start installs nothing', () => world(async (w) => {
  const main = mainWith(w, prepare('echo main >> "$PREP_OUT"'));
  // A clone whose objects are loose: a fetch of fewer objects than fetch.unpackLimit (100) keeps no pack.
  const loose = join(w.root, 'loose');
  git(w.root, 'init', '-q', '-b', 'work', loose);
  git(loose, 'remote', 'add', 'origin', join(w.root, 'origin.git'));
  git(loose, 'fetch', '-q', 'origin');
  git(loose, 'reset', '-q', '--hard', 'origin/main');
  const blob = git(loose, 'rev-parse', `${main}:.gate/config.sh`);
  const file = join(loose, '.git/objects', blob.slice(0, 2), blob.slice(2));
  const forged = Buffer.from('gate_prepare() {\n  echo seat >> "$PREP_OUT"\n}\n');
  chmodSync(file, 0o644);
  writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged])));
  prepareAt(w, 't1', main, loose);
  assert.equal(prepared(w), '');
  assert.match(readFileSync(join(w.run, 'run-t1.prepare.log'), 'utf8'), /not whole in this clone/);
}));

test('a changed package.json hidden with assume-unchanged is not taken for main\'s: the first start installs nothing', () => world(async (w) => {
  const main = mainWith(w, { ...prepare('echo main >> "$PREP_OUT"'), 'package.json': '{}\n' });
  writeFileSync(join(w.work, 'package.json'), '{"scripts":{"preinstall":"echo seat"}}\n');
  git(w.work, 'update-index', '--assume-unchanged', 'package.json');
  prepareAt(w, 't1', main);
  assert.equal(prepared(w), '');
  assert.match(readFileSync(join(w.run, 'run-t1.prepare.log'), 'utf8'), /differs from main's commit [0-9a-f]{7} at package\.json/);
}));

test('a repo-local core.fsmonitor does not run during a first start\'s check', () => world(async (w) => {
  const main = mainWith(w, prepare('echo main >> "$PREP_OUT"'));
  commitTo(w.work, { 'extra.txt': 'not fresh\n' });
  writeFileSync(join(w.root, 'monitor.sh'), `#!/bin/sh\ntouch '${join(w.root, 'MONITOR-RAN')}'\n`);
  chmodSync(join(w.root, 'monitor.sh'), 0o755);
  git(w.work, 'config', 'core.fsmonitor', join(w.root, 'monitor.sh'));
  prepareAt(w, 't1', main);
  assert.ok(!existsSync(join(w.root, 'MONITOR-RAN')));
}));

test('a missing object in a clone whose config names a promisor remote, and allows its transport, is not fetched: its sshCommand does not run', () => world(async (w) => {
  const main = mainWith(w, prepare('echo main >> "$PREP_OUT"'));
  const loose = join(w.root, 'loose');
  git(w.root, 'init', '-q', '-b', 'work', loose);
  git(loose, 'remote', 'add', 'origin', join(w.root, 'origin.git'));
  git(loose, 'fetch', '-q', 'origin');
  git(loose, 'reset', '-q', '--hard', 'origin/main');
  const blob = git(loose, 'rev-parse', `${main}:.gate/config.sh`);
  rmSync(join(loose, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  writeFileSync(join(w.root, 'ssh.sh'), `#!/bin/sh\ntouch '${join(w.root, 'SSH-RAN')}'\nexit 1\n`);
  chmodSync(join(w.root, 'ssh.sh'), 0o755);
  for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', 'ssh://git@example.invalid/x.git'], ['remote.origin.promisor', 'true'], ['core.sshCommand', join(w.root, 'ssh.sh')], ['protocol.ssh.allow', 'always']]) git(loose, 'config', k, v);
  prepareAt(w, 't1', main, loose);
  assert.ok(!existsSync(join(w.root, 'SSH-RAN')), 'no transport ran');
  assert.equal(prepared(w), '');
}));

test('a seat that renames its worktree and makes it again gets no second install: the key is the worktree\'s path', () => world(async (w) => {
  const main = mainWith(w, prepare('echo run >> "$PREP_OUT"'));
  assert.equal(w.start('worker', ['--main', main], withGit(w)).code, 0);
  await until(() => w.records().length === 1, 'the first record');
  renameSync(w.work, `${w.work}.old`);
  git(w.root, 'clone', '-q', join(w.root, 'origin.git'), w.work);
  assert.equal(w.start('worker', ['--tag', 'fix1', '--main', main], withGit(w)).code, 0);
  await until(() => w.records().length === 2, 'the second record');
  assert.equal(prepared(w), 'run\n');
}));

test('a worktree whose first session ran without an install installs nothing at a later start, even once it matches main', () => world(async (w) => {
  const main = mainWith(w, prepare('echo run >> "$PREP_OUT"'));
  commitTo(w.work, { 'extra.txt': 'not fresh\n' });
  assert.equal(w.start('worker', ['--main', main], withGit(w)).code, 0);
  await until(() => w.records().length === 1, 'the first record');
  git(w.work, 'reset', '-q', '--hard', main);
  assert.equal(w.start('worker', ['--tag', 'review1'], withGit(w)).code, 0);
  await until(() => w.records().length === 2, 'the second record');
  assert.equal(prepared(w), '');
  assert.match(readFileSync(join(w.run, 'run-review1.prepare.log'), 'utf8'), /^prepare: not run: a session has already run in this worktree/);
}));
