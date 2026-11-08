import { pushHook } from '../../../bin/lib/force-push.mjs';
// packs/pstack/bin/lead (#163): starts the pstack Lead of one team of a repository (#196: --team, use the only existing team, pick a nickname when none exists, refuse when several exist; --new-team picks a free nickname; the session is named
// <repo>-<team> and its folder is ~/factory-runs/<repo>-<team>/; the account row is the team's, factory/<repo>-<team>). This file holds the pure parts (the arguments of
// claude, the enabled plugins, the refusals) and the start. Nobody logs in (#179): the Lead needs the row factory/<repo>-<team> in the
// accounts file (#311) and refuses to start without it; it sets FACTORY_TEAM=<repo>-<team> in claude's environment for bin/seat; it reads that account's token file once, before setup, and gives it to claude's
// environment alone (CLAUDE_CODE_OAUTH_TOKEN), with no scrub, in auto mode (the Human, 2026-11-01); it prints none of it. It also
// sets hasCompletedOnboarding in the profile's .claude.json, since a token on a fresh profile would replay onboarding.
// A resumed session ignores a new --append-system-prompt (2.1.316), so <run folder>/role.sha keeps "<hash of the role text> <session id>"
// of the session that was last given the text, and a resume of any other session, or with another hash, or with no record, gets the current
// text as its first message under "[factory] your role changed:" (#316). A new session picks its own id (--session-id) and records it
// with the hash, as piggery records card_hash when a new participant gets its card (internal/core/session.go). piggery v0.10.3 keeps
// the same kind of record for each participant (internal/store/migrate_15.sql, internal/core/harness.go newCard and giveCard), but hashes
// team, role and name, checks at every turn and, when it changed, gives the card before the turn's text; here the whole text is hashed
// and given once, as the first message of a resume.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginError, installPlugins, pluginPaths } from '../../../bin/lib/plugins.mjs';
import { onLinear } from '../../../bin/lib/linear-repos.mjs';
import { TEAM, firstFree } from '../../../bin/lib/names.mjs';
import { profilesOf, runsOf, stateDirOf } from '../../../bin/lib/node.mjs';
import { pickTeam } from '../../../bin/lib/team-names.mjs';
import { refusal } from '../../../bin/lib/repos.mjs';
import { heldNames, tokenStoreDeny } from '../../../bin/lib/seat.mjs';
import { readRules } from '../../../bin/lib/deny-read.mjs';
import { accountRefusal, readAccounts, readTokenFile, tokenDir } from '../../../bin/lib/token.mjs';

const USAGE = 'usage: factory lead <repo> [--team <name> | --new-team] [--new] [--dry-run]   (--team names the team, use the only existing team, pick a nickname when none exists, refuse when several exist; --new-team picks a free nickname; --new starts a fresh session, otherwise the newest earlier one of the team is resumed)';
const TEAM_TOKEN = '{{TEAM}}'; // in lead.md where the team's name goes; nothing else in that text is written so
const TEAM_KEY_TOKEN = '{{TEAMKEY}}'; // in the Linear form of lead.md: the repository's Linear team key, from the registry
const SEAT_TOKEN = '{{SEAT}}'; // in lead.md: the absolute path of the bin/seat the Lead's grant names, which differs by node (#366)
const RUNS_TOKEN = '{{RUNS}}'; // in lead.md: the absolute runs folder, whose paths the seats' records carry (#366)

/** lead.md for one Lead: the form of its repository, its team, its Linear team key, the bin/seat its grant names and its runs folder.
 * With no `seat` (a MacBook Lead that does not run as the agents' user, #366) it takes the <!--noseat--> form, which starts no seat, and
 * names no bin/seat. Each value goes in as written (a function replacement, so no `$` in a path is read as a pattern). */
export const roleFor = (text, { linear, team, seat = null, runs }) => formOf(roleOf(text, Boolean(linear)), seat ? 'seat' : 'noseat', seat ? 'noseat' : 'seat')
  .replaceAll(TEAM_TOKEN, () => team).replaceAll(TEAM_KEY_TOKEN, () => linear?.key ?? '').replaceAll(SEAT_TOKEN, () => seat ?? '').replaceAll(RUNS_TOKEN, () => runs);

/** The text with each span of `drop` taken out, markers included (a span that starts a line takes its line break with it), and the markers
 * of `keep` taken out around their text. */
const formOf = (text, keep, drop) => text
  .replace(new RegExp(`^<!--${drop}-->[\\s\\S]*?<!--/${drop}-->\\n`, 'gm'), '')
  .replace(new RegExp(`<!--${drop}-->[\\s\\S]*?<!--/${drop}-->`, 'g'), '')
  .replaceAll(`<!--${keep}-->`, '')
  .replaceAll(`<!--/${keep}-->`, '');

/** lead.md holds each issue step twice, between <!--github-->…<!--/github--> and <!--linear-->…<!--/linear-->. The text for a repository keeps
 * one form and drops the other, markers included, so a Lead never sees both (#404). */
export function roleOf(text, linear) {
  return linear ? formOf(text, 'linear', 'github') : formOf(text, 'github', 'linear');
}

const ROLE_CHANGED = '[factory] your role changed:'; // the head of a resumed session's first message (#316)
const SESSION_COPY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** The Lead's earlier session, from the copies transcript-copy.mjs keeps in dir (~/factory-runs/<repo>-<team>/transcripts), never from
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
// ships pull requests through scripts/ship (which runs gh for it), rewrites a pull request's body through scripts/pr-body
// (#386; never `gh pr edit`, which also changes labels, base and reviewers), comments on them and starts workers through bin/seat.
// In auto mode a write to GitHub that no rule names is refused by the
// classifier (#277). lead.md tells it to write no change itself; the grants alone do not stop it. It may read with
// gh api and needs the Human's approval to write through it (his answer 2026-11-02 15:09:43, #343); no setting blocks
// gh api.
const allowOf = (root) => [
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'Bash(git fetch:*)', 'Bash(git worktree:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
  'Bash(git rev-parse:*)', 'Bash(git branch:*)', 'Bash(git push -u origin HEAD)',
  'Bash(cd:*)', 'Bash(ls:*)', 'Bash(mkdir:*)',
  'Bash(.gate/bin/claim:*)', 'Bash(.gate/bin/tier:*)', 'Bash(.gate/bin/verify:*)', 'Bash(.gate/bin/red-check:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh issue create:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue edit:*)',
  'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr comment:*)', 'Bash(scripts/ship:*)', 'Bash(scripts/pr-body:*)',
  'Bash(factory linear:*)',
  // pstack's other-model-family steps on Codex, through the factory's verb alone; codex itself stays denied (#182).
  'Bash(factory codex:*)',
  `Bash(${join(root, 'bin/seat')}:*)`,
];
// The Lead writes only in ~/factory-runs: a leading // makes each rule an absolute path.
const denyOf = (cwd) => [
  ...tokenStoreDeny, 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(herdr:*)', 'Bash(env:*)', 'Bash(printenv:*)', `Edit(/${cwd}/**)`,
  // The paths no agent reads (bin/lib/deny-read.mjs), the whole profiles folder among them (#178).
  ...readRules({ role: 'lead' }),
];

// The reason to refuse a start, or null, lives in bin/lib/repos.mjs (#311), which bin/seat and the teams use too.
export { refusal };

export const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

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
 * hook is the command of the hooks (HOOK_EVENTS), which copy the session's own transcript on Stop and SessionEnd to
 * <runs>/<repo>-<team>/transcripts, outside every profile (#185); it runs the script through node (the path findNode gave), so the script
 * needs no exec bit. runs is the runs folder (runsOf, bin/lib/node.mjs), ~/factory-runs unless FACTORY_RUNS names another. */
export function leadArgs({ repo, team, home, runs = join(home, 'factory-runs'), root, roleText, node, resume = null, message = null, sessionId = null, hookScript = join(root, 'packs/pstack/bin/transcript-copy.mjs') }) {
  const cwd = join(root, repo);
  const hook = [node, hookScript, join(runs, `${repo}-${team}`, 'transcripts')].map(quote).join(' ');
  const hooks = [{ hooks: [{ type: 'command', command: hook }] }];
  return {
    cwd,
    hook,
    argv: [
      'direnv', 'exec', '.', 'claude',
      '--model', 'opus', '--effort', 'high',
      '--append-system-prompt', roleText,
      '--permission-mode', 'auto',
      '--add-dir', runs,
      '--name', `${repo}-${team}`,
      '--settings', JSON.stringify({ autoMemoryEnabled: false, hooks: { ...Object.fromEntries(HOOK_EVENTS.map((e) => [e, hooks])), PreToolUse: pushHook(false, node) } }),
      // The prompt argument goes right after the id: --allowedTools and --disallowedTools take every word up to the next option.
      ...(resume ? ['--resume', resume, ...(message ? [message] : [])] : sessionId ? ['--session-id', sessionId] : []),
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

/** Copy pstack's mapped skill defaults into the Lead profile on every start (#436). Model changes are the Human's. */
export function writeModels(config, root) {
  const file = join(config, 'rules/pstack-models.md');
  const text = readFileSync(join(root, 'packs/pstack/pstack-models.md'));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`could not write ${file}: ${e.code ?? e.message}`);
  }
}

/** The role text's hash (#316): SHA-256 hex of the exact string that goes to --append-system-prompt. */
export const roleHash = (roleText) => createHash('sha256').update(roleText).digest('hex');

const ROLE_RECORD = /^([0-9a-f]{64}) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/;

/** What <runDir>/role.sha holds: { raw, hash, session }. raw is the file's text, or null when it is missing or unreadable; hash and
 * session are null unless it is one line, 64 lowercase hex characters, a space, a session id and a newline (an older one-field file is none). */
export function readRole(runDir) {
  let raw = null;
  try {
    raw = readFileSync(join(runDir, 'role.sha'), 'utf8');
  } catch {
    // missing or unreadable: no record
  }
  const m = raw === null ? null : ROLE_RECORD.exec(raw);
  return { raw, hash: m?.[1] ?? null, session: m?.[2] ?? null };
}

/** Writes <runDir>/role.sha through a temporary file in the same folder (exclusive create) and a rename. */
export function writeRole(runDir, text) {
  const file = join(runDir, 'role.sha');
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(runDir, { recursive: true });
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Puts role.sha back as readRole saw it: its raw text, or no file. */
export function restoreRole(runDir, raw) {
  if (raw === null) rmSync(join(runDir, 'role.sha'), { force: true });
  else writeRole(runDir, raw);
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

/** The arguments: { repo, team, flags } (flags are --new and --dry-run, once each) or { error }. `--team <name>` is checked against
 * the grammar here, before anything runs (#196). */
export function parseArgs(argv) {
  const flags = [];
  const rest = [];
  let team = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--team') {
      if (team !== null) return { error: '--team is given once' };
      team = argv[++i] ?? '';
      if (!TEAM.test(team)) return { error: `the team "${team}" is not a letter then at most 31 lowercase letters and digits` };
    } else if (a.startsWith('--')) {
      if (a !== '--new' && a !== '--dry-run' && a !== '--new-team') return { error: `unknown option ${a}` };
      flags.push(a);
    } else rest.push(a);
  }
  if (rest.length !== 1) return { error: '' };
  if (new Set(flags).size !== flags.length || (team !== null && flags.includes('--new-team'))) return { error: '--new-team and --team are exclusive, flags are given once' };
  return { repo: rest[0], team, flags };
}

function main(argv, env) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`bin/lead: ${parsed.error ? `${parsed.error}\n` : ''}${USAGE}\n`);
    return 2;
  }
  const { repo, flags } = parsed;
  let { team } = parsed;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const why = refusal(repo, root);
  if (why) {
    process.stderr.write(`${why}\n`);
    return 2;
  }
  const rolePath = join(root, 'packs/pstack/lead.md');
  const stateDir = resolve(stateDirOf(env));
  let linear;
  try {
    team ??= pickTeam(repo, { home: env.HOME, state: stateDir, runs: env.FACTORY_RUNS ?? join(env.HOME, 'factory-runs'), root, newTeam: flags.includes('--new-team') });
    linear = onLinear(repo, stateDir);
  } catch (e) {
    // A registry that does not parse would give every repository the GitHub form without a word: no start instead.
    process.stderr.write(`bin/lead: ${e.message}\n`);
    return 2;
  }
  const runs = runsOf(env);
  const roleText = existsSync(rolePath) ? roleFor(readFileSync(rolePath, 'utf8'), { linear, team, seat: join(root, 'bin/seat'), runs }) : '';
  if (!roleText.trim()) {
    process.stderr.write(`bin/lead: ${rolePath} is missing or empty\n`);
    return 2;
  }
  // No row, no start: the Lead runs on a row's token, never on a login (the Human, 2026-11-01).
  const state = stateDir;
  const row = `factory/${repo}-${team}`;
  const account = readAccounts(state)[row] ?? null;
  if (!account) {
    process.stderr.write(`bin/lead: no row ${row} in the accounts file; the Human or Colly on his spoken word runs \`factory use ${repo}-${team} <letter>\` (INN-30, 2026-11-05) (\`factory\` lists the letters)\n`);
    return 2;
  }
  if (accountRefusal(account)) {
    process.stderr.write(`bin/lead: the account of ${row} is not a plain account name\n`);
    return 2;
  }
  const runDir = join(runs, `${repo}-${team}`);
  const transcripts = join(runDir, 'transcripts');
  const earlier = flags.includes('--new') ? null : newestSession(transcripts);
  const resume = earlier?.id ?? null;
  const sessionLine = resume
    ? `session: resume ${resume} (newest of ${earlier.count} ${earlier.count === 1 ? 'copy' : 'copies'} in ${transcripts})`
    : `session: new (${flags.includes('--new') ? '--new' : `no copy in ${transcripts}`})`;
  // A resumed session ignores a new --append-system-prompt, so a text it was not given goes as its first message (#316; piggery's card_hash).
  const hash = roleHash(roleText);
  const earlierRole = readRole(runDir);
  const given = resume !== null && earlierRole.hash === hash && earlierRole.session === resume;
  const roleLine = !resume
    ? 'role: new session, the role text goes as the system prompt'
    : given
      ? `role: unchanged since ${hash.slice(0, 7)}, no message`
      : `role: ${earlierRole.hash === hash ? 'given to another session, not to this one' : earlierRole.hash ? `changed since ${earlierRole.hash.slice(0, 7)}` : 'no record'}, the first message gives the role text`;
  const message = resume && !given ? `${ROLE_CHANGED}\n${roleText}` : null;
  const sessionId = resume ? null : randomUUID(); // a new session's own id, so the record can name it
  const node = findNode(env.PATH);
  if (!node) {
    process.stderr.write('bin/lead: no node on PATH, which the transcript hook needs\n');
    return 2;
  }
  const hookScript = hookPath({ root, runDir });
  const { cwd, argv: command, hook } = leadArgs({ repo, team, home: env.HOME, runs, root, roleText, node, resume, message, sessionId, hookScript });
  const wanted = enabledPlugins(readSettings(cwd));
  // The plugins are cached in a root of this profile outside ~/.agent-profiles, which the deny list hides (#185).
  const profiles = resolve(profilesOf(env));
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
    const shown = leadArgs({ repo, team, home: env.HOME, runs, root, roleText: '<packs/pstack/lead.md>', node, resume, message: message && '<first message: packs/pstack/lead.md>', sessionId: sessionId && '<new session id>', hookScript }).argv;
    process.stdout.write(`${cwd}\n`);
    process.stdout.write(`${wanted.length ? `plugins to ensure: ${wanted.join(' ')}` : 'plugins to ensure: none'}\n`);
    process.stdout.write(`plugin root: ${pluginRoot}\n`);
    process.stdout.write(`transcript hook: ${hook}\n`);
    process.stdout.write(`${shown.join(' ')}\n`);
    process.stdout.write(`team: ${team}\n`);
    process.stdout.write(`${sessionLine}\n`);
    process.stdout.write(`${roleLine}\n`);
    process.stdout.write(`account: ${account} (row ${row})\n`);
    return 0;
  }

  // The token is read once, before anything runs, and held for claude's environment alone.
  const tokenPath = join(tokenDir(profiles), account);
  const t = readTokenFile(tokenPath);
  if (t.error) {
    process.stderr.write(`bin/lead: ${t.error === 'missing' ? `the account ${account} has no token file ${tokenPath}; the Human runs \`factory account add ${account}\`` : `the token file ${tokenPath} is empty or not printable ASCII`}\n`);
    return 2;
  }
  const token = t.token;
  try {
    markOnboarded(config);
    writeModels(config, root);
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

  // Last step before claude, so a start refused or stopped above records nothing. A resume that was given the text leaves the file
  // alone; one that gets the message, and a new session (which got the text as its system prompt), record the hash and the session id.
  if (!given) {
    try {
      writeRole(runDir, `${hash} ${resume ?? sessionId}\n`);
    } catch (e) {
      process.stderr.write(`bin/lead: could not record the role text's hash in ${join(runDir, 'role.sha')}: ${e.code ?? e.message}\n`);
      return 1;
    }
  }

  // The token goes to claude's environment alone, never to the plugin installs above or to a message.
  // FACTORY_TEAM is the team's row for every bin/seat the Lead runs (#311); an inherited value is replaced.
  const childEnv = { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginRoot, CLAUDE_CODE_OAUTH_TOKEN: token, FACTORY_TEAM: `${repo}-${team}` };
  // Ctrl-C reaches this process as well as claude, which uses it itself; like system(), ignore SIGINT and SIGQUIT while the child runs.
  for (const s of ['SIGINT', 'SIGQUIT']) process.on(s, () => {});
  const r = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit', env: childEnv });
  if (r.error) {
    process.stderr.write(`bin/lead: ${command[0]}: ${r.error.message}\n`);
    // claude never ran, so the text was not given: the next start gives it.
    if (!given) {
      try {
        restoreRole(runDir, earlierRole.raw);
      } catch (e) {
        process.stderr.write(`bin/lead: could not put back ${join(runDir, 'role.sha')}: ${e.code ?? e.message}\n`);
      }
    }
    return 1;
  }
  return exitCodeOf(r);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
