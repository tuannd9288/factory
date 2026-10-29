// packs/pstack/bin/lead (#163): starts the pstack Lead of one repository. This file holds the pure parts (the arguments of
// claude, the plugins missing, the refusals) and the start. Nothing here reads a credential or logs in.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretsRead } from '../../../bin/lib/seat.mjs';

const USAGE = 'usage: packs/pstack/bin/lead <repo> [--continue] [--dry-run]';

// The Lead's grants (lead.md): it reads, claims, makes worktrees, pushes its own HEAD, opens and arms pull requests, and starts
// workers through bin/seat. lead.md tells it to write no change itself and never to run gh api; the grants alone do not stop it.
const allowOf = (root) => [
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'Bash(git fetch:*)', 'Bash(git worktree:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
  'Bash(git rev-parse:*)', 'Bash(git branch:*)', 'Bash(git push -u origin HEAD)',
  'Bash(cd:*)', 'Bash(ls:*)', 'Bash(mkdir:*)',
  'Bash(.gate/bin/claim:*)', 'Bash(.gate/bin/tier:*)', 'Bash(.gate/bin/verify:*)', 'Bash(.gate/bin/red-check:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)',
  'Bash(gh pr merge --auto --merge:*)',
  `Bash(${join(root, 'bin/seat')}:*)`,
];
// The Lead writes only in ~/factory-runs: a leading // makes each rule an absolute path.
const denyOf = (cwd) => [
  'Bash(gh api:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(herdr:*)', `Edit(/${cwd}/**)`, `Write(/${cwd}/**)`, ...secretsRead,
];

/** The reason to refuse a start, or null: repo is a plain folder name and root/repo is a real folder with .git, .gate/ and .envrc. */
export function refusal(repo, root) {
  // GitHub's own name characters only: the name goes into the deny rules' paths, where a glob character would bend them.
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo.startsWith('-') || repo.includes('..')) {
    return `bin/lead: "${repo ?? ''}" is not a plain folder name`;
  }
  const dir = join(root, repo);
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    // a missing folder is refused below
  }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return `bin/lead: ${dir} is not a folder of its own (missing, a symlink or a file)`;
  if (!existsSync(join(dir, '.git'))) return `bin/lead: ${dir} has no .git of its own, so it is not a clone`;
  if (!existsSync(join(dir, '.gate'))) return `bin/lead: ${dir} has no .gate/, so it is not an onboarded clone`;
  if (!existsSync(join(dir, '.envrc'))) return `bin/lead: ${dir} has no .envrc, so it has no profile`;
  return null;
}

/** The folder to start in and the command: root is the factory checkout (~/WORKSPACES); roleText is packs/<pack>/lead.md's text. */
export function leadArgs({ repo, home, root, roleText, resume = false }) {
  const cwd = join(root, repo);
  return {
    cwd,
    argv: [
      'direnv', 'exec', '.', 'claude',
      '--model', 'opus', '--effort', 'high',
      '--append-system-prompt', roleText,
      '--permission-mode', 'acceptEdits',
      '--add-dir', join(home, 'factory-runs'),
      '--name', `${repo}-lead`,
      ...(resume ? ['--continue'] : []),
      '--allowedTools', ...allowOf(root),
      '--disallowedTools', ...denyOf(cwd),
    ],
  };
}

/** The plugins the settings enable (value true), by id. */
export function enabledPlugins(settingsJson) {
  const enabled = JSON.parse(settingsJson).enabledPlugins ?? {};
  return Object.entries(enabled).filter(([, on]) => on === true).map(([id]) => id);
}

/** The enabled plugins whose id does not appear, as a quoted string, in the output of `claude plugin list --json`. */
export function missingPlugins(settingsJson, listOutput) {
  return enabledPlugins(settingsJson).filter((id) => !listOutput.includes(JSON.stringify(id)));
}

/** The exit code for a finished child: its status, or 128 plus the signal's number when a signal ended it. */
export function exitCodeOf({ status, signal }) {
  if (typeof status === 'number') return status;
  const n = signal ? osConstants.signals[signal] : undefined;
  return n ? 128 + n : 1;
}

function readSettings(cwd) {
  const path = join(cwd, '.claude/settings.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : '{}';
}

const direnvClaude = (cwd, args) => spawnSync('direnv', ['exec', '.', 'claude', ...args], { cwd, encoding: 'utf8' });
const claudeDirt = (cwd) => spawnSync('git', ['status', '--porcelain', '--', '.claude/'], { cwd, encoding: 'utf8' }).stdout ?? '';
const lastLine = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

function main(argv, env) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const rest = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--continue' && f !== '--dry-run');
  if (rest.length !== 1 || unknown.length) {
    process.stderr.write(`bin/lead: ${unknown.length ? `unknown option ${unknown[0]}\n` : ''}${USAGE}\n`);
    return 2;
  }
  const [repo] = rest;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const why = refusal(repo, root);
  if (why) {
    process.stderr.write(`${why}\n`);
    return 2;
  }
  const rolePath = join(root, 'packs/pstack/lead.md');
  const roleText = existsSync(rolePath) ? readFileSync(rolePath, 'utf8') : '';
  if (!roleText.trim()) {
    process.stderr.write(`bin/lead: ${rolePath} is missing or empty\n`);
    return 2;
  }
  const resume = flags.includes('--continue');
  const { cwd, argv: command } = leadArgs({ repo, home: env.HOME, root, roleText, resume });
  const wanted = enabledPlugins(readSettings(cwd));

  if (flags.includes('--dry-run')) {
    const shown = leadArgs({ repo, home: env.HOME, root, roleText: '<packs/pstack/lead.md>', resume }).argv;
    process.stdout.write(`${cwd}\n`);
    process.stdout.write(`${wanted.length ? `plugins to ensure: ${wanted.join(' ')}` : 'plugins to ensure: none'}\n`);
    process.stdout.write(`${shown.join(' ')}\n`);
    return 0;
  }

  const setup = spawnSync('.gate/bin/setup', [], { cwd, stdio: 'inherit' });
  if (setup.error) {
    process.stderr.write(`bin/lead: .gate/bin/setup: ${setup.error.message}\n`);
    return 1;
  }
  if (setup.status !== 0) {
    process.stderr.write(`bin/lead: .gate/bin/setup failed in ${cwd}\n`);
    return setup.status ?? 1;
  }

  if (wanted.length) {
    const before = claudeDirt(cwd);
    const listed = direnvClaude(cwd, ['plugin', 'list', '--json']);
    for (const id of missingPlugins(readSettings(cwd), listed.status === 0 ? listed.stdout : '')) {
      // Local scope records the install in the git-ignored .claude/settings.local.json, so the committed pin stays as it is.
      const r = direnvClaude(cwd, ['plugin', 'install', id, '--scope', 'local']);
      if (r.status !== 0) {
        process.stderr.write(`bin/lead: ${id} is not installed; it installs once the Human has logged in to the profile and trusted the folder, so run again\n`);
        const detail = r.error ? r.error.message : lastLine(r.stderr);
        if (detail) process.stderr.write(`  ${detail}\n`);
      }
    }
    if (claudeDirt(cwd) !== before) process.stderr.write(`bin/lead: the install changed .claude/ in ${cwd}; check git status there\n`);
  }

  // Ctrl-C reaches this process as well as claude, which uses it itself; like system(), ignore SIGINT and SIGQUIT while the child runs.
  for (const s of ['SIGINT', 'SIGQUIT']) process.on(s, () => {});
  const r = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`bin/lead: ${command[0]}: ${r.error.message}\n`);
    return 1;
  }
  return exitCodeOf(r);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
