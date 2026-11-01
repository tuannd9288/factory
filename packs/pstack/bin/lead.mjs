// packs/pstack/bin/lead (#163): starts the pstack Lead of one repository. This file holds the pure parts (the arguments of
// claude, the enabled plugins, the refusals) and the start. Nobody logs in (#179): the Lead needs the row factory/lead-<repo> in the
// accounts file and refuses to start without it; it reads that account's token file once, before setup, and gives it to claude's
// environment alone (CLAUDE_CODE_OAUTH_TOKEN), with no scrub, in auto mode (the Human, 2026-11-01); it prints none of it. It also
// sets hasCompletedOnboarding in the profile's .claude.json, since a token on a fresh profile would replay onboarding.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginError, installPlugins, pluginPaths } from '../../../bin/lib/plugins.mjs';
import { firstFree } from '../../../bin/lib/names.mjs';
import { heldNames, secretsRead, tokenStoreDeny } from '../../../bin/lib/seat.mjs';
import { accountRefusal, readAccounts, readTokenFile, tokenDir } from '../../../bin/lib/token.mjs';

const USAGE = 'usage: factory lead <repo> [--new] [--dry-run]   (--new starts a fresh session; otherwise the newest earlier one is resumed)';
const SESSION_COPY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** The Lead's earlier session, from the copies transcript-copy.mjs keeps in dir (~/factory-runs/<repo>-lead/transcripts), never from
 * a profile: { id, count } for the newest regular file by mtime whose name is a plain session id plus .jsonl, or null. */
export function newestSession(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const found = [];
  for (const name of names) {
    const m = SESSION_COPY.exec(name);
    if (!m) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile()) found.push({ id: m[1], mtime: st.mtimeMs });
    } catch {
      // gone since the listing
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  return { id: found[0].id, count: found.length };
}

// The Lead's grants (lead.md): it reads, claims, makes worktrees, pushes its own HEAD, files, comments on and edits issues,
// opens, comments on and arms pull requests, and starts workers through bin/seat. In auto mode a write to GitHub that no rule
// names is refused by the classifier (#277). lead.md tells it to write no change itself and never to run gh api; the grants alone do not stop it.
const allowOf = (root) => [
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'Bash(git fetch:*)', 'Bash(git worktree:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
  'Bash(git rev-parse:*)', 'Bash(git branch:*)', 'Bash(git push -u origin HEAD)',
  'Bash(cd:*)', 'Bash(ls:*)', 'Bash(mkdir:*)',
  'Bash(.gate/bin/claim:*)', 'Bash(.gate/bin/tier:*)', 'Bash(.gate/bin/verify:*)', 'Bash(.gate/bin/red-check:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh issue create:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue edit:*)',
  'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr comment:*)',
  'Bash(gh pr merge --auto --merge:*)',
  `Bash(${join(root, 'bin/seat')}:*)`,
];
// The Lead writes only in ~/factory-runs: a leading // makes each rule an absolute path.
const denyOf = (cwd) => [
  ...tokenStoreDeny, 'Bash(gh api:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(herdr:*)', 'Bash(env:*)', 'Bash(printenv:*)', `Edit(/${cwd}/**)`, `Write(/${cwd}/**)`, ...secretsRead,
  // The tokens, the archive and seat 1's old file, by name, beside the whole profiles folder (#178).
  'Read(~/.agent-profiles/tokens/**)', 'Read(~/.agent-profiles/archive/**)', 'Read(~/.agent-profiles/seats/1/oauth-token)',
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

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

/** The first `node` that PATH names, as PATH names it (a link stays a link: brew upgrade keeps /opt/homebrew/bin/node and removes
 * the Cellar path behind it), or null. Only absolute folders count. */
export function findNode(PATH) {
  for (const dir of (PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, 'node');
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // not here
    }
  }
  return null;
}

// The hooks that run transcript-copy.mjs: it copies the transcript on Stop and SessionEnd, and on all five tells `top` the Lead's state (#286).
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];

/** The folder to start in and the command: root is the factory checkout (~/WORKSPACES); roleText is packs/<pack>/lead.md's text.
 * hook is the command of the hooks (HOOK_EVENTS), which copy the session's own transcript on Stop and SessionEnd to ~/factory-runs/<repo>-lead/
 * transcripts, outside every profile (#185); it runs the script through node (the path findNode gave), so the script needs no
 * exec bit. */
export function leadArgs({ repo, home, root, roleText, node, resume = null, hookScript = join(root, 'packs/pstack/bin/transcript-copy.mjs') }) {
  const cwd = join(root, repo);
  const hook = [node, hookScript, join(home, 'factory-runs', `${repo}-lead`, 'transcripts')].map(quote).join(' ');
  const hooks = [{ hooks: [{ type: 'command', command: hook }] }];
  return {
    cwd,
    hook,
    argv: [
      'direnv', 'exec', '.', 'claude',
      '--model', 'opus', '--effort', 'high',
      '--append-system-prompt', roleText,
      '--permission-mode', 'auto',
      '--add-dir', join(home, 'factory-runs'),
      '--name', `${repo}-lead`,
      '--settings', JSON.stringify({ autoMemoryEnabled: false, hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, hooks])) }),
      ...(resume ? ['--resume', resume] : []),
      '--allowedTools', ...allowOf(root),
      '--disallowedTools', ...denyOf(cwd),
    ],
  };
}

/** Where the hooks' script is copied to (#257): <run folder>/hooks/transcript-copy-<sha7 of its bytes>.mjs. A Lead pane stays open
 * for days, and its Stop hook would otherwise run whatever the checkout holds by then; the script imports only node: modules, so the
 * copy runs alone. */
export function hookPath({ root, runDir }) {
  const sha = createHash('sha256').update(readFileSync(join(root, 'packs/pstack/bin/transcript-copy.mjs'))).digest('hex').slice(0, 7);
  return join(runDir, 'hooks', `transcript-copy-${sha}.mjs`);
}

/** Copies the script to hookPath unless a copy is there already (reused, never written again), and returns the path. A changed
 * script has another name, so an earlier copy stays for the panes that run it. */
export function copyHook({ root, runDir }) {
  const to = hookPath({ root, runDir });
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    const tmp = `${to}.${process.pid}.tmp`;
    writeFileSync(tmp, readFileSync(join(root, 'packs/pstack/bin/transcript-copy.mjs')));
    renameSync(tmp, to);
  }
  return to;
}

/** The plugins the settings enable (value true), by id. */
export function enabledPlugins(settingsJson) {
  const enabled = JSON.parse(settingsJson).enabledPlugins ?? {};
  return Object.entries(enabled).filter(([, on]) => on === true).map(([id]) => id);
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

/** The Lead profile's config dir, as the repository's .envrc sets it: a path, not a secret. Throws a PluginError when direnv gives none. */
function profileConfig(cwd) {
  const r = spawnSync('direnv', ['exec', '.', 'printenv', 'CLAUDE_CONFIG_DIR'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const config = lastLine(r.stdout);
  if (r.status !== 0 || !config) throw new PluginError(`direnv gave no CLAUDE_CONFIG_DIR in ${cwd}${r.error ? ` (${r.error.message})` : ''}`);
  return config;
}

/** With a token in its environment a fresh profile replays onboarding (theme, login method; probe on 2.1.308, 2026-11-01), so the
 * profile's <config>/.claude.json gets "hasCompletedOnboarding": true, set only when it is not true, every other key and the file's
 * mode kept, through a temporary file and a rename. A trust key is never set: trust stays the Human's. Throws an Error whose message
 * names the file when it does not parse into an object; the file is then unchanged. */
export function markOnboarded(config) {
  const file = join(config, '.claude.json');
  let text = '{}';
  let mode = 0o600;
  try {
    text = readFileSync(file, 'utf8');
    mode = statSync(file).mode & 0o777;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`could not read ${file}: ${e.code ?? e.message}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file} does not hold a JSON object; fix or move it`);
  if (json.hasCompletedOnboarding === true) return;
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...json, hasCompletedOnboarding: true }, null, 2)}\n`, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`could not write ${file}: ${e.code ?? e.message}`);
  }
}

/** The Lead's name (#286): the file <runDir>/name when it is there, else the first animal no live run and no Lead holds, written
 * to it. Every Lead's name is held for as long as its file exists, so the name stays across restarts. */
export function leadName(runDir, state) {
  const file = join(runDir, 'name');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    const name = firstFree(heldNames(dirname(runDir), state));
    mkdirSync(runDir, { recursive: true });
    writeFileSync(file, `${name}\n`);
    return name;
  }
}

/** Inside a Herdr pane: keeps the pane id in <runDir>/pane for `top` and renames the pane to the Lead's name. A failure is one note
 * line and the start goes on. */
function renamePane(runDir, name, paneId) {
  writeFileSync(join(runDir, 'pane'), `${paneId}\n`);
  const r = spawnSync('herdr', ['pane', 'rename', paneId, name], { stdio: 'ignore', timeout: 5000 });
  if (r.error || r.status !== 0) process.stderr.write(`bin/lead: note: could not rename the Herdr pane ${paneId} to ${name}\n`);
}

const claudeDirt = (cwd) => spawnSync('git', ['status', '--porcelain', '--', '.claude/'], { cwd, encoding: 'utf8' }).stdout ?? '';
const lastLine = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

function main(argv, env) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const rest = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--new' && f !== '--dry-run');
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
  // No row, no start: the Lead runs on a row's token, never on a login (the Human, 2026-11-01).
  const state = resolve(env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory'));
  const row = `factory/lead-${repo}`;
  const account = readAccounts(state)[row] ?? null;
  if (!account) {
    process.stderr.write(`bin/lead: no row ${row} in the accounts file; the Human runs \`factory use lead-${repo} <letter>\` (\`factory\` lists the letters)\n`);
    return 2;
  }
  if (accountRefusal(account)) {
    process.stderr.write(`bin/lead: the account of ${row} is not a plain account name\n`);
    return 2;
  }
  const transcripts = join(env.HOME, 'factory-runs', `${repo}-lead`, 'transcripts');
  const earlier = flags.includes('--new') ? null : newestSession(transcripts);
  const resume = earlier?.id ?? null;
  const sessionLine = resume
    ? `session: resume ${resume} (newest of ${earlier.count} ${earlier.count === 1 ? 'copy' : 'copies'} in ${transcripts})`
    : `session: new (${flags.includes('--new') ? '--new' : `no copy in ${transcripts}`})`;
  const node = findNode(env.PATH);
  if (!node) {
    process.stderr.write('bin/lead: no node on PATH, which the transcript hook needs\n');
    return 2;
  }
  const runDir = join(env.HOME, 'factory-runs', `${repo}-lead`);
  const hookScript = hookPath({ root, runDir });
  const { cwd, argv: command, hook } = leadArgs({ repo, home: env.HOME, root, roleText, node, resume, hookScript });
  const wanted = enabledPlugins(readSettings(cwd));
  // The plugins are cached in a root of this profile outside ~/.agent-profiles, which the deny list hides (#185).
  const profiles = resolve(env.AGENT_PROFILES ?? join(env.HOME, '.agent-profiles'));
  let config;
  let pluginRoot;
  try {
    config = profileConfig(cwd);
    pluginRoot = pluginPaths(config, { home: env.HOME, profiles }).root;
  } catch (e) {
    if (!(e instanceof PluginError)) throw e;
    process.stderr.write(`bin/lead: ${e.message}\n`);
    return 1;
  }

  if (flags.includes('--dry-run')) {
    const shown = leadArgs({ repo, home: env.HOME, root, roleText: '<packs/pstack/lead.md>', node, resume, hookScript }).argv;
    process.stdout.write(`${cwd}\n`);
    process.stdout.write(`${wanted.length ? `plugins to ensure: ${wanted.join(' ')}` : 'plugins to ensure: none'}\n`);
    process.stdout.write(`plugin root: ${pluginRoot}\n`);
    process.stdout.write(`transcript hook: ${hook}\n`);
    process.stdout.write(`${shown.join(' ')}\n`);
    process.stdout.write(`${sessionLine}\n`);
    process.stdout.write(`account: ${account} (row ${row})\n`);
    return 0;
  }

  // The token is read once, before anything runs, and held for claude's environment alone.
  const tokenPath = join(tokenDir(profiles), account);
  const t = readTokenFile(tokenPath);
  if (t.error) {
    process.stderr.write(`bin/lead: ${t.error === 'missing' ? `the account ${account} has no token file ${tokenPath}; the Human runs \`factory login ${account}\`` : `the token file ${tokenPath} is empty or not printable ASCII`}\n`);
    return 2;
  }
  const token = t.token;
  try {
    markOnboarded(config);
  } catch (e) {
    process.stderr.write(`bin/lead: ${e.message}\n`);
    return 2;
  }

  try {
    copyHook({ root, runDir });
  } catch (e) {
    process.stderr.write(`bin/lead: could not copy the transcript hook to ${hookScript}: ${e.code ?? e.message}\n`);
    return 1;
  }

  const name = leadName(runDir, state);
  if (env.HERDR_PANE_ID) renamePane(runDir, name, env.HERDR_PANE_ID);

  const setup = spawnSync('.gate/bin/setup', [], { cwd, stdio: 'inherit' });
  if (setup.error) {
    process.stderr.write(`bin/lead: .gate/bin/setup: ${setup.error.message}\n`);
    return 1;
  }
  if (setup.status !== 0) {
    process.stderr.write(`bin/lead: .gate/bin/setup failed in ${cwd}\n`);
    return setup.status ?? 1;
  }

  // Local scope records the install in the git-ignored .claude/settings.local.json, so the committed pin stays as it is. A failed
  // install stops the start.
  const before = claudeDirt(cwd);
  try {
    installPlugins({ work: cwd, config, home: env.HOME, profiles, env });
  } catch (e) {
    if (!(e instanceof PluginError)) throw e;
    process.stderr.write(`bin/lead: plugins: ${e.message}\n`);
    return 1;
  }
  if (claudeDirt(cwd) !== before) process.stderr.write(`bin/lead: the install changed .claude/ in ${cwd}; check git status there\n`);

  // The token goes to claude's environment alone, never to the plugin installs above or to a message.
  const childEnv = { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginRoot, CLAUDE_CODE_OAUTH_TOKEN: token };
  // Ctrl-C reaches this process as well as claude, which uses it itself; like system(), ignore SIGINT and SIGQUIT while the child runs.
  for (const s of ['SIGINT', 'SIGQUIT']) process.on(s, () => {});
  const r = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit', env: childEnv });
  if (r.error) {
    process.stderr.write(`bin/lead: ${command[0]}: ${r.error.message}\n`);
    return 1;
  }
  return exitCodeOf(r);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
