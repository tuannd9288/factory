// packs/pstack/bin/lead (#163): starts the pstack Lead of one repository. This file holds the pure parts (the arguments of
// claude, the plugins missing, the refusals) and the start. Nothing here reads a credential or logs in.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretsRead } from '../../../bin/lib/seat.mjs';

const USAGE = 'usage: packs/pstack/bin/lead <repo> [--continue] [--dry-run]';

// The Lead's grants (lead.md): it reads, claims, makes worktrees, pushes its own HEAD, opens and arms pull requests, and starts
// workers through bin/seat. It writes no change itself and never runs gh api.
const allowOf = (home) => [
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'Bash(git fetch:*)', 'Bash(git worktree:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
  'Bash(git rev-parse:*)', 'Bash(git branch:*)', 'Bash(git push -u origin HEAD)',
  'Bash(cd:*)', 'Bash(ls:*)', 'Bash(mkdir:*)',
  'Bash(.gate/bin/claim:*)', 'Bash(.gate/bin/tier:*)', 'Bash(.gate/bin/verify:*)', 'Bash(.gate/bin/red-check:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)',
  'Bash(gh pr merge --auto --merge:*)',
  `Bash(${home}/WORKSPACES/bin/seat:*)`,
];
const deny = ['Bash(gh api:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(herdr:*)', ...secretsRead];

/** The reason to refuse a start, or null: repo is a plain folder name and root/repo holds .gate/ and .envrc. */
export function refusal(repo, root) {
  if (typeof repo !== 'string' || repo === '' || repo === '.' || repo.includes('/') || repo.includes('..')) {
    return `bin/lead: "${repo ?? ''}" is not a plain folder name`;
  }
  const dir = join(root, repo);
  if (!existsSync(join(dir, '.gate'))) return `bin/lead: ${dir} has no .gate/, so it is not an onboarded clone`;
  if (!existsSync(join(dir, '.envrc'))) return `bin/lead: ${dir} has no .envrc, so it has no profile`;
  return null;
}

/** The folder to start in and the command: root is the factory checkout (~/WORKSPACES), whose packs/<pack>/lead.md is the role text. */
export function leadArgs({ repo, home, root, pack = 'pstack', resume = false }) {
  return {
    cwd: join(root, repo),
    argv: [
      'direnv', 'exec', '.', 'claude',
      '--model', 'opus', '--effort', 'high',
      '--append-system-prompt-file', join(root, 'packs', pack, 'lead.md'),
      '--permission-mode', 'acceptEdits',
      '--add-dir', join(home, 'factory-runs'),
      '--name', `${repo}-lead`,
      ...(resume ? ['--continue'] : []),
      '--allowedTools', ...allowOf(home),
      '--disallowedTools', ...deny,
    ],
  };
}

/** The plugins the settings enable (value true), by id. */
export function enabledPlugins(settingsJson) {
  const enabled = JSON.parse(settingsJson).enabledPlugins ?? {};
  return Object.entries(enabled).filter(([, on]) => on === true).map(([id]) => id);
}

/** The enabled plugins whose id does not appear in the output of `claude plugin list --json`. */
export function missingPlugins(settingsJson, listOutput) {
  return enabledPlugins(settingsJson).filter((id) => !listOutput.includes(id));
}

function readSettings(cwd) {
  const path = join(cwd, '.claude/settings.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : '{}';
}

const direnvClaude = (cwd, args) => spawnSync('direnv', ['exec', '.', 'claude', ...args], { cwd, encoding: 'utf8' });

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
  const { cwd, argv: command } = leadArgs({ repo, home: env.HOME, root, resume: flags.includes('--continue') });
  const wanted = enabledPlugins(readSettings(cwd));

  if (flags.includes('--dry-run')) {
    process.stdout.write(`${cwd}\n`);
    process.stdout.write(`${wanted.length ? `plugins to ensure: ${wanted.join(' ')}` : 'plugins to ensure: none'}\n`);
    process.stdout.write(`${command.join(' ')}\n`);
    return 0;
  }

  const setup = spawnSync('.gate/bin/setup', [], { cwd, stdio: 'inherit' });
  if (setup.status !== 0) {
    process.stderr.write(`bin/lead: .gate/bin/setup failed in ${cwd}\n`);
    return setup.status ?? 1;
  }

  if (wanted.length) {
    const listed = direnvClaude(cwd, ['plugin', 'list', '--json']);
    for (const id of missingPlugins(readSettings(cwd), listed.status === 0 ? listed.stdout : '')) {
      const r = direnvClaude(cwd, ['plugin', 'install', id, '--scope', 'project']);
      if (r.status !== 0) {
        process.stderr.write(`bin/lead: ${id} is not installed; it installs once the Human has logged in to the profile and trusted the folder, so run again\n`);
      }
    }
  }

  const r = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit' });
  return r.status ?? 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
