// bin/research-git (#181): the researcher's only way to run git. Bash rules match command text, so `Bash(git -C:*)` also
// admitted `-c` with an alias, and `--output`, after it; a probe on a seat ran both (2026-10-30). The script runs git only
// on clones it made under FACTORY_RESEARCH_CLONES, named by a plain name, with the clone's .git and work tree given to git;
// it refuses each option that makes git run another program or read or write a file the caller names, and runs git with no
// configuration but the clone's own. Its first form let git find the repository from a path, and two review rounds of PR
// #184 each made git read a configuration the session chose that way (a bare-looking folder, a clone into a .git, a
// symlink, an empty .git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run } from './helpers.mjs';

const RG = join(factory, 'bin/research-git');
const BASE = ['--no-pager', '-c', 'safe.bareRepository=explicit', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never'];

// A fake git first on PATH records what it was given. The script hands git only the environment it builds, so the record
// goes under that environment's HOME. clones is FACTORY_RESEARCH_CLONES, and `r` there is a clone (it has a .git folder).
function world(body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'research-git-')));
  const w = { root, bin: join(root, 'bin'), home: join(root, 'home'), clones: join(root, 'clones') };
  for (const d of [w.bin, w.home, join(w.clones, 'r/.git')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(w.bin, 'git'), `#!${process.execPath}
require('fs').writeFileSync(require('path').join(process.env.HOME, 'called.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`);
  chmodSync(join(w.bin, 'git'), 0o755);
  w.rg = (args, env = {}) => run(root, RG, args, { PATH: `${w.bin}:${process.env.PATH}`, HOME: w.home, FACTORY_RESEARCH_CLONES: w.clones, ...env });
  w.called = () => (existsSync(join(w.home, 'called.json')) ? JSON.parse(readFileSync(join(w.home, 'called.json'), 'utf8')) : null);
  // A control: these arguments run git, so a refusal that follows is for what the test adds.
  w.ok = (args) => {
    const r = w.rg(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
    rmSync(join(w.home, 'called.json'));
  };
  try {
    return body(w);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const refused = (w, args, env = {}) => {
  const r = w.rg(args, env);
  assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
  assert.match(r.out, /^research-git: refused/m, args.join(' '));
  assert.equal(w.called(), null, `${args.join(' ')}: git ran`);
};

test('a read names a clone by a plain name; a path, -C, an unknown clone or subcommand, or no FACTORY_RESEARCH_CLONES is refused, and git never runs', () => world((w) => {
  mkdirSync(join(w.clones, 'plain'));
  for (const args of [[], ['-C', w.clones, 'log'], [join(w.clones, 'r'), 'log'], ['r/.', 'log'], ['../r', 'log'], ['.', 'log'], ['..', 'log'],
    ['.git', 'log'], ['.GIT', 'log'], ['-r', 'log'], ['nope', 'log'], ['plain', 'log'], ['r'], ['r', 'diff', 'a', 'b'], ['r', 'grep', 'x'],
    ['r', 'config', 'a.b'], ['r', 'push'], ['r', '-c', 'alias.x=!sh', 'x'], ['r', '--git-dir=/x', 'log']]) refused(w, args);
  refused(w, ['r', 'log'], { FACTORY_RESEARCH_CLONES: '' });
  refused(w, ['r', 'log'], { FACTORY_RESEARCH_CLONES: 'clones' });
}));

test('a symlink in the clones folder is not a clone, even one that points at a clone', () => world((w) => {
  symlinkSync(join(w.clones, 'r'), join(w.clones, 'link'));
  w.ok(['r', 'log']);
  refused(w, ['link', 'log']);
}));

test('an option that writes a file, reads a file the caller names or runs another program is refused, and git never runs', () => world((w) => {
  w.ok(['r', 'log', '-p']);
  for (const args of [['log', '--output=/tmp/x'], ['log', '--output', '/tmp/x'], ['show', '--output=/tmp/x', 'HEAD'], ['diff-tree', '--no-index', '/a', '/b'],
    ['log', '-p', '--ext-diff'], ['log', '-p', '--textconv'], ['show', '--textconv', 'HEAD'], ['diff-tree', '-O/tmp/order', 'HEAD~1', 'HEAD'],
    ['diff-tree', '-pO/tmp/order', 'HEAD~1', 'HEAD'], ['log', '-p', '-O', '/tmp/order'], ['ls-files', '-X', '/tmp/x'], ['ls-files', '-tX', '/tmp/x'],
    ['ls-files', '--exclude-from=/tmp/x'], ['rev-parse', '--resolve-git-dir', '/tmp/x'], ['blame', '--contents', '/tmp/x', 'f.txt'],
    ['blame', '-S', '/tmp/x', 'f.txt'], ['blame', '-sS', '/tmp/x', 'f.txt'], ['blame', '--ignore-revs-file=/tmp/x', 'f.txt'], ['blame', '--textconv', 'f.txt'],
    ['ls-files', '--exclude-per-directory=../x'], ['rev-list', '-O/tmp/order', 'HEAD'], ['blame', '-O/tmp/order', 'f.txt']]) {
    refused(w, ['r', ...args]);
  }
}));

// blame and ls-files take any unambiguous prefix of their own long options, so a prefix of a refused option is refused too.
test('a prefix of a refused option is refused, as blame and ls-files take a prefix for the whole option', () => world((w) => {
  w.ok(['r', 'blame', 'f.txt']);
  for (const args of [['blame', '--conten=/tmp/x', 'f.txt'], ['blame', '--ignore-revs-f=/tmp/x', 'f.txt'], ['blame', '--text', 'f.txt'],
    ['ls-files', '-o', '--exclude-fr=/tmp/x'], ['ls-files', '--exclude-p=../x'], ['log', '--outp=/tmp/x'], ['log', '--ext', '-p']]) {
    refused(w, ['r', ...args]);
  }
}));

test('a read runs git on the clone\'s own .git and work tree, every switch off, and textconv and external diffs off for diffs and blame', () => world((w) => {
  const dir = join(w.clones, 'r');
  for (const [args, extra] of [[['log', '--oneline', '-n', '3', '--', '--output=notes.md'], true], [['blame', '-s', 'f.txt'], true],
    [['diff-tree', '-p', 'HEAD~1', 'HEAD'], true], [['show', 'HEAD:f.txt'], true], [['ls-files'], false], [['rev-list', '--count', 'HEAD'], false],
    [['rev-parse', 'HEAD'], false], [['ls-files', '-o', '--exclude=*.o'], false], [['log', '-S', 'two'], true]]) {
    const r = w.rg(['r', ...args]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(w.called().argv, [...BASE, `--git-dir=${join(dir, '.git')}`, `--work-tree=${dir}`, args[0], ...(extra ? ['--no-textconv', '--no-ext-diff'] : []), ...args.slice(1)]);
  }
}));

test('clone takes one https URL and a new plain name, and only depth, branch, filter, single-branch, no-checkout and quiet', () => world((w) => {
  for (const args of [['clone'], ['clone', 'https://h/r'], ['clone', 'file:///tmp/r', 'a'], ['clone', 'http://h/r', 'a'], ['clone', '/tmp/r', 'a'], ['clone', 'ext::sh -c touch% /tmp/x', 'a'],
    ['clone', 'git@github.com:a/b.git', 'a'], ['clone', '--upload-pack=touch /tmp/x', 'https://h/r', 'a'], ['clone', '-u', 'touch /tmp/x', 'https://h/r', 'a'],
    ['clone', '--template=/tmp/t', 'https://h/r', 'a'], ['clone', '-c', 'core.fsmonitor=x', 'https://h/r', 'a'], ['clone', '--config', 'a=b', 'https://h/r', 'a'],
    ['clone', '--recurse-submodules', 'https://h/r', 'a'], ['clone', '--reference', '/r', 'https://h/r', 'a'], ['clone', 'https://h/r', 'a', 'extra'],
    ['clone', 'https://h/r', 'src/a'], ['clone', 'https://h/r', '../a'], ['clone', 'https://h/r', '/tmp/a'], ['clone', 'https://h/r', '.git'],
    ['clone', 'https://h/r', '.Git'], ['clone', 'https://h/r', 'clone'], ['clone', 'https://h/r', 'r'], ['clone', '--depth'], ['-C', '/tmp', 'clone', 'https://h/r', 'a']]) {
    refused(w, args);
  }
  assert.equal(existsSync(join(w.clones, 'a')), false, 'a refused clone makes no folder');
}));

test('clone makes the clone\'s folder itself, as a new real folder, and hands git that path with templates and submodules off', () => world((w) => {
  const r = w.rg(['clone', '--depth', '1', '--branch', 'main', '--filter=blob:none', '--single-branch', '-q', 'https://example.com/r.git', 'src']);
  assert.equal(r.code, 0, r.out);
  const dir = join(w.clones, 'src');
  assert.deepEqual(w.called().argv, [...BASE, 'clone', '--template=', '--no-recurse-submodules', '--depth', '1', '--branch', 'main', '--filter=blob:none',
    '--single-branch', '-q', '--', 'https://example.com/r.git', dir]);
  assert.ok(lstatSync(dir).isDirectory(), 'the folder exists before git runs, and is not a symlink');
}));

test('a name that is taken, by a folder, a file or a symlink, is refused for a clone', () => world((w) => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'research-git-outside-')));
  try {
    writeFileSync(join(w.clones, 'file'), 'x\n');
    symlinkSync(outside, join(w.clones, 'link'));
    for (const name of ['r', 'file', 'link']) refused(w, ['clone', 'https://h/r', name]);
    assert.equal(existsSync(join(outside, '.git')), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('git gets none of the caller\'s environment but PATH and HOME, and global, system and caller-set configuration are off', () => world((w) => {
  w.rg(['r', 'rev-parse', 'HEAD'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'x', GIT_DIR: '/x', GIT_EXTERNAL_DIFF: 'x', CALLER_MARK: '1' });
  const { env } = w.called();
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('GIT_')).sort(), ['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);
  assert.deepEqual([env.GIT_ALLOW_PROTOCOL, env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_NOSYSTEM, env.GIT_TERMINAL_PROMPT], ['https', '/dev/null', '1', '0']);
  assert.equal('CALLER_MARK' in env, false);
  assert.equal('FACTORY_RESEARCH_CLONES' in env, false);
}));

// The real git, on a clone made in the test (the network is not used): what the clone holds is read, the caller's and the
// global configuration are not, and a textconv that the clone's own configuration names never runs.
function realClone(body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'research-git-real-')));
  try {
    const clones = join(root, 'clones');
    const dir = join(clones, 'c');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, { 'f.txt': 'one\n' }, 'first');
    commit(dir, { 'f.txt': 'one\ntwo\n' }, 'second');
    const rg = (args, env = {}) => run(root, RG, args, { FACTORY_RESEARCH_CLONES: clones, ...env });
    return body({ root, dir, rg });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('with the real git, a clone is read by name: log, show, diff-tree, ls-files, rev-parse, rev-list and blame', () => realClone(({ rg }) => {
  for (const [args, out] of [[['log', '-1', '--format=%s'], /^second$/m], [['show', 'HEAD~1:f.txt'], /^one$/m], [['diff-tree', '-p', 'HEAD~1', 'HEAD'], /^\+two$/m],
    [['ls-files'], /^f\.txt$/m], [['rev-parse', '--abbrev-ref', 'HEAD'], /^main$/m], [['rev-list', '--count', 'HEAD'], /^2$/m], [['blame', '-s', 'f.txt'], /two$/m]]) {
    const r = rg(['c', ...args]);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, out, args.join(' '));
  }
}));

test('with the real git, a global file or the caller\'s environment that changes the output of log has no effect', () => realClone(({ root, dir, rg }) => {
  writeFileSync(join(root, 'gitconfig'), '[format]\n\tpretty = tformat:GLOBAL %s\n');
  for (const env of [{ GIT_CONFIG_GLOBAL: join(root, 'gitconfig') }, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'format.pretty', GIT_CONFIG_VALUE_0: 'tformat:ENV %s' }]) {
    assert.match(run(dir, 'git', ['log', '-1'], env).out, /^(GLOBAL|ENV) second$/m, 'the setting changes plain git\'s output');
    const r = rg(['c', 'log', '-1'], env);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /GLOBAL|ENV/);
    assert.match(r.out, /^ {4}second$/m);
  }
}));

test('with the real git, a textconv the clone\'s own configuration names does not run on show, log -p, diff-tree -p or blame', () => realClone(({ root, dir, rg }) => {
  const marker = join(root, 'RAN');
  mkdirSync(join(dir, '.git/info'), { recursive: true });
  writeFileSync(join(dir, '.git/info/attributes'), '* diff=x\n');
  git(dir, 'config', 'diff.x.textconv', `touch ${marker}`);
  run(dir, 'git', ['show', 'HEAD']);
  assert.ok(existsSync(marker), 'plain git runs the textconv');
  rmSync(marker);
  for (const args of [['show', 'HEAD'], ['log', '-p', '-1'], ['diff-tree', '-p', 'HEAD~1', 'HEAD'], ['blame', 'f.txt']]) {
    const r = rg(['c', ...args]);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
    assert.equal(existsSync(marker), false, `${args.join(' ')}: the textconv ran`);
  }
}));

test('with the real git, blame reads the file an abbreviated --ignore-revs-file names; research-git refuses it', () => realClone(({ root, dir, rg }) => {
  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'SECRET-LINE\n');
  assert.match(run(dir, 'git', ['blame', `--ignore-revs-f=${secret}`, 'f.txt']).out, /SECRET-LINE/, 'plain git reads the file');
  assert.equal(rg(['c', 'blame', 'f.txt']).code, 0, 'research-git runs blame');
  for (const args of [['blame', `--ignore-revs-f=${secret}`, 'f.txt'], ['blame', `--conten=${secret}`, 'f.txt']]) {
    const r = rg(['c', ...args]);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.doesNotMatch(r.out, /SECRET-LINE/);
  }
}));

// Review of #184, B1 and B5: a folder the session makes under the clones folder, from plain files, with the layout of a bare
// repository whose config names a textconv, beside no .git or an empty one. A session's file tools cannot write under a .git.
test('with the real git, a folder made to look like a clone runs nothing: a bare layout beside no .git, or an empty one', () => realClone(({ root, dir, rg }) => {
  const marker = join(root, 'RAN');
  const evil = join(root, 'clones/evil');
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const d of ['refs/heads', 'objects/info', 'info']) mkdirSync(join(evil, d), { recursive: true });
  writeFileSync(join(evil, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(evil, 'refs/heads/main'), `${head}\n`);
  writeFileSync(join(evil, 'objects/info/alternates'), `${join(dir, '.git/objects')}\n`);
  writeFileSync(join(evil, 'info/attributes'), '* diff=x\n');
  writeFileSync(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = true\n[diff "x"]\n\ttextconv = touch ${marker}\n`);
  run(evil, 'git', ['show', 'main']);
  assert.ok(existsSync(marker), 'plain git runs the folder\'s textconv');
  rmSync(marker);
  let r = rg(['evil', 'show', 'main']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^research-git: refused: evil: no clone of that name/m);
  mkdirSync(join(evil, '.git'));
  r = rg(['evil', 'show', 'main']);
  assert.equal(r.code, 128, r.out);
  assert.match(r.out, /not a git repository/);
  assert.equal(existsSync(marker), false, 'the textconv ran');
}));
