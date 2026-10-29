// bin/research-git clone [options] <https URL> <name> | bin/research-git <name> <subcommand> [arguments] (#181): the
// researcher's only way to run git. Bash rules match command text, so a rule such as `Bash(git log:*)` also admits `-c`, an
// alias or `--output` after it. This script runs git only on clones it made itself, under the folder bin/seat names in
// FACTORY_RESEARCH_CLONES, each named by a plain name and never by a path, with the clone's own .git and work tree named to
// git explicitly. It refuses each option that makes git run another program or read or write a file the caller names, and
// runs git with no configuration but the clone's own. Exits 2 on a refusal, else with git's own code.
//
// Two review rounds of PR #184 each found a way to make git read a configuration the session chose while the script let
// git find the repository from a path. Here git is never given a path the caller chose. A clone's own configuration is what
// git clone wrote: Claude Code refuses a session's file tools, and its redirects, a write under .git (permissions.md,
// protected paths).
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No diff: outside a repository, or with a path outside it, git diff compares any two files as --no-index does.
// diff-tree compares commits only.
const READS = ['log', 'show', 'diff-tree', 'ls-files', 'rev-parse', 'rev-list', 'blame'];
// Options that write the file they name (--output), read one (--no-index; ls-files' --exclude-from and
// --exclude-per-directory; rev-parse's --resolve-git-dir; blame's --contents and --ignore-revs-file), or run another program
// (--textconv, --ext-diff; --show-signature runs gpg, which the factory machine has, as a format with %G does). blame and ls-files also take any unambiguous prefix of their own long options (git 2.54:
// `blame --ignore-revs-f=<file>` printed the file's first line), so a prefix of one of these is refused as well. --exclude
// is an option of its own, which git takes before a prefix.
const REFUSED_LONG = ['--output', '--no-index', '--textconv', '--ext-diff', '--show-signature', '--exclude-from', '--exclude-per-directory', '--resolve-git-dir', '--contents', '--ignore-revs-file'];
const NOT_A_PREFIX = ['--exclude'];
// Short options that read the file they name: -O (the order of a diff) for every subcommand, -X for ls-files and -S for blame
// (log's -S is the pickaxe), alone or in a cluster such as -pO<file>.
const REFUSED_SHORT = { 'ls-files': 'X', blame: 'S' };
// The diff subcommands, and blame, get textconv and external diffs turned off.
const NO_PROGRAMS = ['log', 'show', 'diff-tree', 'blame'];
// Clone's other options can run a program (--upload-pack, --template, -c, --recurse-submodules) or read another folder.
const CLONE_FLAGS = ['--single-branch', '--no-checkout', '-n', '--quiet', '-q'];
const CLONE_VALUES = ['--depth', '--branch', '-b', '--filter'];

// Every call: no pager, no hooks, no fsmonitor, no bare repository found by looking, no file transport.
const BASE = ['--no-pager', '-c', 'safe.bareRepository=explicit', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never'];

class Refused extends Error {}

function checkName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('-') || ['.', '..', '.git', 'clone'].includes(name.toLowerCase())) {
    throw new Refused(`${name ?? 'no name'}: a clone is named by letters, digits, ".", "_" and "-" only, never by a path`);
  }
}

function checkRead(sub, args) {
  for (const a of args) {
    if (a === '--') return;
    const name = a.split('=')[0];
    const long = a.startsWith('--') && !NOT_A_PREFIX.includes(name) && REFUSED_LONG.find((r) => r.startsWith(name));
    if (long) throw new Refused(`${name}: git takes it for ${long}, which writes a file, reads one the caller names or runs another program`);
    const letter = ['O', REFUSED_SHORT[sub]].find((l) => l && /^-[^-]/.test(a) && a.includes(l));
    if (letter) throw new Refused(`${a}: ${sub} -${letter} reads the file it names`);
    if (a.includes('%G')) throw new Refused(`${a}: a format with %G has git run gpg`);
  }
}

function cloneArgs(args) {
  const opts = [];
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.split('=')[0];
    if (CLONE_FLAGS.includes(a)) opts.push(a);
    else if (CLONE_VALUES.includes(name)) {
      opts.push(a);
      if (a === name) {
        if (i + 1 >= args.length) throw new Refused(`clone ${a} needs a value`);
        opts.push(args[++i]);
      }
    } else if (a.startsWith('-')) throw new Refused(`clone ${name}: clone takes ${[...CLONE_VALUES, ...CLONE_FLAGS].join(', ')}`);
    else words.push(a);
  }
  const [url, name, ...rest] = words;
  if (!url?.startsWith('https://') || rest.length) throw new Refused('clone takes one https:// URL and a name');
  checkName(name);
  return { opts, url, name };
}

/** The git arguments and environment for the script's own arguments, or a Refused error. A clone's folder is made here. */
export function plan(argv, env = process.env) {
  const root = env.FACTORY_RESEARCH_CLONES;
  if (!root || !isAbsolute(root)) throw new Refused('FACTORY_RESEARCH_CLONES names no folder: bin/seat sets it for a researcher');
  const gitEnv = { PATH: env.PATH ?? '', HOME: env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https' };
  const [first, ...rest] = argv;
  if (first === 'clone') {
    const { opts, url, name } = cloneArgs(rest);
    mkdirSync(root, { recursive: true });
    const dir = join(realpathSync(root), name);
    try {
      // Not recursive: it fails on any name that exists, a symlink included, so git always gets a new, real folder.
      mkdirSync(dir);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw new Refused(`clone ${name}: that name exists; pick another`);
    }
    if (realpathSync(dir) !== dir) throw new Refused(`clone ${name}: the folder is not where it was made`);
    return { args: [...BASE, 'clone', '--template=', '--no-recurse-submodules', ...opts, '--', url, dir], env: gitEnv };
  }
  checkName(first);
  const [sub, ...args] = rest;
  if (!READS.includes(sub)) throw new Refused(`${sub ?? 'no subcommand'}: the subcommands are clone, ${READS.join(', ')}`);
  checkRead(sub, args);
  const dir = join(root, first);
  let made = false;
  try {
    made = lstatSync(dir).isDirectory() && lstatSync(join(dir, '.git')).isDirectory();
  } catch {
    // no such clone
  }
  if (!made) throw new Refused(`${first}: no clone of that name; make one with clone`);
  return {
    args: [...BASE, `--git-dir=${join(dir, '.git')}`, `--work-tree=${dir}`, sub, ...(NO_PROGRAMS.includes(sub) ? ['--no-textconv', '--no-ext-diff'] : []), ...args],
    env: gitEnv,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let p;
  try {
    p = plan(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`research-git: refused: ${e.message}\n`);
    process.exit(2);
  }
  const r = spawnSync('git', p.args, { stdio: 'inherit', env: p.env });
  if (r.error) {
    process.stderr.write(`research-git: could not run git (${r.error.code ?? 'error'})\n`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
