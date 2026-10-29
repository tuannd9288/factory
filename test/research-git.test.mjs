// bin/research-git (#181): the researcher's only way to run git. Bash rules match command text, so `Bash(git -C:*)` also
// admitted `-c` with an alias, and `--output`, after it; a probe on a seat ran both (2026-10-30). The script takes clone over
// https and a few subcommands that only read, refuses each option that makes git run a program or read or write a file it
// names, and runs git with no configuration but the repository's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run } from './helpers.mjs';

const RG = join(factory, 'bin/research-git');

// A fake git first on PATH records what it was given. The script hands git only the environment it builds, so the record
// goes under that environment's HOME.
function world(body) {
  const root = mkdtempSync(join(tmpdir(), 'research-git-'));
  const w = { root, bin: join(root, 'bin'), home: join(root, 'home') };
  for (const d of [w.bin, w.home]) mkdirSync(d);
  writeFileSync(join(w.bin, 'git'), `#!${process.execPath}
require('fs').writeFileSync(require('path').join(process.env.HOME, 'called.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`);
  chmodSync(join(w.bin, 'git'), 0o755);
  w.rg = (args, env = {}) => run(root, RG, args, { PATH: `${w.bin}:${process.env.PATH}`, HOME: w.home, ...env });
  w.called = () => (existsSync(join(w.home, 'called.json')) ? JSON.parse(readFileSync(join(w.home, 'called.json'), 'utf8')) : null);
  try {
    return body(w);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const refused = (w, args) => {
  const r = w.rg(args);
  assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
  assert.match(r.out, /^research-git: refused/m, args.join(' '));
  assert.equal(w.called(), null, `${args.join(' ')}: git ran`);
};

test('a subcommand other than clone, log, show, diff-tree, ls-files and rev-parse is refused, and git never runs', () => world((w) => {
  // diff is out: outside a repository, or with a path outside it, git diff compares any two files as --no-index does.
  for (const args of [[], ['diff', '/a', '/b'], ['grep', 'x'], ['config', 'a.b'], ['push'], ['-c', 'alias.x=!sh', 'x'],
    ['--git-dir=/x', 'log'], ['--exec-path=/x', 'log'], ['-C'], ['-C', '/r', '-c', 'a=b', 'log']]) refused(w, args);
}));

test('an option that writes a file, reads a file outside the repository or runs another program is refused, and git never runs', () => world((w) => {
  for (const args of [['log', '--output=/tmp/x'], ['log', '--output', '/tmp/x'], ['show', '--output=/tmp/x', 'HEAD'],
    ['diff-tree', '--no-index', '/a', '/b'], ['diff-tree', '-p', '--ext-diff', 'HEAD~1', 'HEAD'], ['diff-tree', '-O/tmp/order', 'HEAD~1', 'HEAD'],
    ['diff-tree', '-pO/tmp/order', 'HEAD~1', 'HEAD'], ['log', '-p', '-O', '/tmp/order']]) refused(w, args);
}));

test('clone takes one https URL, a folder under the current one, and only depth, branch, filter, single-branch, no-checkout and quiet', () => world((w) => {
  for (const args of [['clone'], ['clone', 'file:///tmp/r'], ['clone', '/tmp/r'], ['clone', 'ext::sh -c touch% /tmp/x'],
    ['clone', 'git@github.com:a/b.git'], ['clone', '--upload-pack=touch /tmp/x', 'https://h/r'], ['clone', '-u', 'touch /tmp/x', 'https://h/r'],
    ['clone', '--template=/tmp/t', 'https://h/r'], ['clone', '-c', 'core.fsmonitor=x', 'https://h/r'], ['clone', '--config', 'a=b', 'https://h/r'],
    ['clone', '--recurse-submodules', 'https://h/r'], ['clone', '--reference', '/r', 'https://h/r'], ['clone', 'https://h/r', 'd', 'extra'],
    ['clone', 'https://h/r', '/tmp/d'], ['clone', 'https://h/r', '../d'], ['clone', 'https://h/r', 'a/../../d'], ['-C', '/tmp', 'clone', 'https://h/r']]) refused(w, args);
  const r = w.rg(['clone', '--depth', '1', '--branch', 'main', '--filter=blob:none', '--single-branch', '-q', 'https://example.com/r.git', 'src/r']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.called().argv.slice(5), ['clone', '--depth', '1', '--branch', 'main', '--filter=blob:none', '--single-branch', '-q', 'https://example.com/r.git', 'src/r']);
}));

test('a read runs git with the pager, fsmonitor and hooks off, in the -C folder if given; past -- every word is a path', () => world((w) => {
  const r = w.rg(['-C', '/r/clone', 'log', '--oneline', '-n', '3', '--', '--output=notes.md']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.called().argv, ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', '/r/clone', 'log', '--oneline', '-n', '3', '--', '--output=notes.md']);
}));

test('git gets none of the caller\'s environment but PATH and HOME, and global, system and caller-set configuration are off', () => world((w) => {
  w.rg(['rev-parse', 'HEAD'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'x', GIT_DIR: '/x', GIT_EXTERNAL_DIFF: 'x', CALLER_MARK: '1' });
  const { env } = w.called();
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('GIT_')).sort(), ['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);
  assert.deepEqual([env.GIT_ALLOW_PROTOCOL, env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_NOSYSTEM, env.GIT_TERMINAL_PROMPT], ['https', '/dev/null', '1', '0']);
  assert.equal('CALLER_MARK' in env, false);
  assert.equal(env.HOME, w.home);
}));

test('with the real git, a global file or the caller\'s environment that changes the output of log has no effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-git-real-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    commit(repo, { 'f.txt': 'x\n' }, 'first');
    writeFileSync(join(root, 'gitconfig'), '[format]\n\tpretty = tformat:GLOBAL %s\n');
    for (const env of [{ GIT_CONFIG_GLOBAL: join(root, 'gitconfig') }, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'format.pretty', GIT_CONFIG_VALUE_0: 'tformat:ENV %s' }]) {
      const plain = run(repo, 'git', ['log', '-1'], env);
      assert.match(plain.out, /^(GLOBAL|ENV) first$/m, 'the setting changes plain git\'s output');
      const r = run(repo, RG, ['log', '-1'], env);
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /GLOBAL|ENV/);
      assert.match(r.out, /^ {4}first$/m);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
