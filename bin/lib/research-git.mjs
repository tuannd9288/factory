// bin/research-git [-C <folder>] <subcommand> [arguments] (#181): the researcher's only way to run git. Bash rules match
// command text, so a rule such as `Bash(git log:*)` also admits `-c`, an alias or `--output` after it. This script takes
// clone over https and the subcommands a researcher reads with, refuses each option that makes git run a program or read
// or write a file it names, refuses a folder git would take for a bare repository, and runs git with no configuration but
// the repository's own. Exits 2 on a refusal, else with git's own code.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// No diff: outside a repository, or with a path outside it, git diff compares any two files as --no-index does.
// diff-tree compares commits only.
const READS = ['log', 'show', 'diff-tree', 'ls-files', 'rev-parse'];
// --output writes the file it names, --no-index and -O read one, --ext-diff runs another program.
const REFUSED = ['--output', '--no-index', '--ext-diff'];
// Clone's other options can run a program (--upload-pack, --template, -c, --recurse-submodules) or read another folder.
const CLONE_FLAGS = ['--single-branch', '--no-checkout', '-n', '--quiet', '-q'];
const CLONE_VALUES = ['--depth', '--branch', '-b', '--filter'];

class Refused extends Error {}

function checkRead(args) {
  for (const a of args) {
    if (a === '--') return;
    const name = a.split('=')[0];
    if (REFUSED.includes(name)) throw new Refused(`${name}: it writes a file, reads one outside the repository or runs another program`);
    if (/^-[^-]/.test(a) && a.includes('O')) throw new Refused(`${a}: -O reads the file it names`);
  }
}

function checkClone(args) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.split('=')[0];
    if (CLONE_FLAGS.includes(a)) continue;
    if (CLONE_VALUES.includes(name)) {
      if (a === name) i++;
      continue;
    }
    if (a.startsWith('-')) throw new Refused(`clone ${name}: clone takes ${[...CLONE_VALUES, ...CLONE_FLAGS].join(', ')}`);
    words.push(a);
  }
  const [url, folder, ...rest] = words;
  if (!url?.startsWith('https://') || folder === undefined || rest.length) throw new Refused('clone takes one https:// URL and a new folder');
  // A folder elsewhere could put a skill or a hook where a later session loads it. Claude Code keeps the current folder
  // inside the session's own (probe, run-probe-cd.jsonl); a symlink under it is resolved here (review of #184, B2).
  let exists = true;
  try {
    lstatSync(folder);
  } catch {
    exists = false;
  }
  let up = resolve(folder);
  while (!existsSync(up)) up = dirname(up);
  const here = realpathSync(process.cwd());
  const there = realpathSync(up);
  if (exists || (there !== here && !there.startsWith(here + sep))) throw new Refused(`clone ${folder}: the folder must be new and under the current one`);
}

/** The folder git would take for a bare repository, looking up from start the way git does, or null when git would find a
 * .git first. Such a folder's config can run a program (diff.<driver>.textconv), and the Write tool can make one from
 * plain files; it may not write a .git (review of #184, B1). */
function bareFrom(start) {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return null;
    if (['HEAD', 'objects', 'refs'].every((n) => existsSync(join(d, n)))) return d;
    if (dirname(d) === d) return null;
  }
}

/** The git arguments and environment for the script's own arguments, or a Refused error. */
export function plan(argv, env = process.env) {
  const args = [...argv];
  let dir = null;
  if (args[0] === '-C') {
    args.shift();
    dir = args.shift();
    if (dir === undefined) throw new Refused('-C needs a folder');
  }
  const sub = args.shift();
  if (sub === 'clone') {
    if (dir !== null) throw new Refused('clone takes no -C: it clones under the current folder');
    checkClone(args);
  } else if (READS.includes(sub)) {
    checkRead(args);
    const bare = bareFrom(dir ?? '.');
    if (bare !== null) throw new Refused(`${bare}: git would take it for a bare repository, whose config can run a program`);
  } else throw new Refused(`${sub === undefined ? 'no subcommand' : sub}: the subcommands are clone, ${READS.join(', ')}`);
  return {
    args: ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...(dir === null ? [] : ['-C', dir]), sub, ...args],
    env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https' },
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
