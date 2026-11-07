// bin/factory (#173, #177, #178, #311): the account list of every agent profile and quota, and `account add`,
// `store`, `use` and `account remove`. On the Mac mini the rows are numbered (each team the accounts file names, the verifier) and the accounts
// lettered; `use` rewrites the accounts file (`use <repo>-<team>` makes a team's row; that team's running Lead alone is restarted once
// Herdr reports it idle, #179, #196; `lead <repo> [--team <name>]` starts one team's); on the MacBook `use` writes the MacBook's own file for a
// team it has a row for, or with --node macbook, and restarts nothing (#366); `account remove` moves a token into the archive; `account add` and
// `store` put a token in the factory's token store. The list runs only the vendors' own status commands (codex login status,
// gh auth status; on the MacBook claude auth status too), reads quota through quotaRows(), and keeps from each answer
// only the logged-in flag, the local part of the account and the plan. It reads no token (a token file shows its mode and recorded added date).
// The committed profile list below holds no account name: the factory repository is public, and an account is an email local
// part. On the Mac mini the account of a row is in $FACTORY_STATE/accounts, local to a machine, the one source of it.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_GIT, installedRoot, nodeGithubToken, placeOf } from './node.mjs';
import { lastStatusLine, quotaRows } from './quota.mjs';
import { alive, post, wakeLine } from './wake.mjs';
import { liveOfAccount, tokenStoreDeny } from './seat.mjs';
import { markOnboarded, quote, roleOf, copyHook } from '../../packs/pstack/bin/lead.mjs';
import { onLinear } from './linear-repos.mjs';
import { TEAM, parseTeam } from './names.mjs';
import { FACTORY_REPO, repoOk, teamRows } from './teams.mjs';
import { pickTeam } from './team-names.mjs';
import { leadTeams } from './colly-status.mjs';
import { APP_FOLDERS, accountList, accountRefusal, archiveToken, nodeAccountList, readAccounts, readTokenFile, readSecret, retireSeat1File, seat1File, seatAccounts, setAccount, tokenAdded, tokenAccounts, tokenDir, tokenOf, writeAppFile, writeToken } from './token.mjs';

const HOST = 'tuans-mac-mini';
const KINDS = { claude: 'Claude', codex: 'Codex', gh: 'gh' };

const claude = (profile, role, env, login) => ({ profile, role, kind: 'claude', check: { cmd: 'claude', args: ['auth', 'status'], env }, login });

/** The numbers N of the `.claude-acc<N>` folders in home, ascending: a spare Claude row exists only for a folder that is there, so
 * the check never points CLAUDE_CONFIG_DIR at a missing one and never makes it. */
function spareFolders(home) {
  let entries = [];
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    // no home to list: no spare rows
  }
  return entries.filter((e) => e.isDirectory() && /^\.claude-acc[0-9]+$/.test(e.name)).map((e) => Number(e.name.slice('.claude-acc'.length))).sort((a, b) => a - b);
}

/** Colly's Claude Code profile on the MacBook (INN-31 3A, #365): a plain folder the factory owns, signed in once by /login. */
const collyProfile = (state) => join(state, 'colly', 'profile');

/** The profiles of a place, from the committed list. On the Mac mini the Lead rows are the ones the accounts file names. A row with
 * `byFile` has its account from that file, and its login state is the token file of that account. */
export function profilesOf(place, { home, agentProfiles, state, root, runs }) {
  if (place === 'macbook') {
    // #365 (B5): the MacBook's own teams, its accounts file's `factory/<repo>-<team>` lines, sorted, numbered as `factory use` numbers them
    // here (hereListing). Their profile names the place, as every row's does; `key` is the line the account is read from.
    const teams = Object.keys(readAccounts(state)).filter((key) => key.startsWith('factory/') && parseTeam(key.slice('factory/'.length))).sort();
    return [
      ...teams.map((key) => {
        const t = parseTeam(key.slice('factory/'.length));
        return { profile: `macbook/${t.repo}-${t.team}`, key, role: `Lead of ${t.repo}, team ${t.team}`, kind: 'claude', byFile: true, numbered: true, statusFile: statusFile(runs, t.repo, t.team) };
      }),
      // Colly's own factory profile (INN-31 3A, #365); Colly writes to GitHub only through factory gh, so it has no gh row.
      claude('macbook/claude', 'Colly', { CLAUDE_CONFIG_DIR: collyProfile(state) }, 'factory colly, then /login'),
      ...spareFolders(home).map((n) => claude(`macbook/claude-acc${n}`, 'spare Claude', { CLAUDE_CONFIG_DIR: join(home, `.claude-acc${n}`) }, `claude-use login ${n}`)),
      { profile: 'macbook/codex', role: 'Colly Codex', kind: 'codex', check: { cmd: 'codex', args: ['login', 'status'], env: {} }, login: 'codex-use login <N>' },
    ];
  }
  if (place === 'factory') {
    const byFile = (profile, role) => ({ profile, role, kind: 'claude', byFile: true, numbered: true });
    // No folder scan and no direnv (#205): a team is a row because the file names it and its repository is onboarded or the
    // factory (#311). No seat has a row: a seat is a slot of a team's account.
    return [
      ...teamRows(state, root).map((t) => byFile(t.row, `Lead and seats of ${t.repo}, team ${t.team}`)),
      { profile: 'factory/verifier', numbered: true, role: 'live verifier', kind: 'codex', check: { cmd: 'codex', args: ['login', 'status'], env: { CODEX_HOME: join(agentProfiles, 'verifier/codex') } }, login: 'CODEX_HOME=~/.agent-profiles/verifier/codex codex login --device-auth' },
      { profile: 'factory/gh', role: 'agents gh', kind: 'gh', check: { cmd: 'gh', args: ['auth', 'status'], env: {} }, login: 'gh auth login --insecure-storage' },
    ];
  }
  return [
    { profile: 'piggery/claude', role: 'piggery teams', kind: 'claude', check: { cmd: 'pig', args: ['claude', 'auth', 'status'], env: {} }, login: `ssh -t tuannguyen@${HOST}\npig claude auth login` },
    { profile: 'piggery/codex', role: 'piggery teams', kind: 'codex', check: { cmd: 'pig', args: ['codex', 'login', 'status'], env: {} }, login: `ssh -t tuannguyen@${HOST}\npig codex login --device-auth` },
  ];
}

const timeoutMs = (env) => Number(env.FACTORY_TIMEOUT_MS) || 15000;

/** One vendor command with a time limit. { code, out, stdout, error }: out is stdout then stderr (gh auth status prints on stderr),
 * stdout alone holds claude auth status's JSON (direnv and ssh print on stderr); error is 'timed out' or the spawn error's code. */
function call(cmd, args, { extra = {}, cwd, env, timeout }) {
  const childEnv = { ...env };
  // The profile folders, and the credentials bin/seat strips too (lib/seat.mjs): a vendor command reports its own login.
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete childEnv[k];
  const r = spawnSync(cmd, args, { cwd, env: { ...childEnv, ...extra }, encoding: 'utf8', timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  const error = r.error ? (r.error.code === 'ETIMEDOUT' ? 'timed out' : `${cmd}: ${r.error.code ?? 'failed'}`) : null;
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', error };
}

/** What claude auth status prints, reduced to the logged-in flag, the local part of the address and the plan; the rest is dropped. */
export function readClaude(text) {
  let j;
  try {
    j = JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    return null;
  }
  if (typeof j?.loggedIn !== 'boolean') return null;
  const email = typeof j.email === 'string' ? j.email.split('@')[0] : null;
  return { loggedIn: j.loggedIn, account: email || null, plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : null };
}

const readGh = (text) => {
  const m = /Logged in to \S+ account (\S+)/.exec(text);
  return m ? { loggedIn: true, account: m[1], plan: null } : { loggedIn: false, account: null, plan: null };
};

/** codex login status exits 0 when logged in and 1 when not; any other exit (127 for a missing command, a failed shell) says nothing. */
const readCodex = (code) => ({ loggedIn: code === 0 ? true : code === 1 ? false : null, account: null, plan: null });

/** An account's token stat and date-only sidecar: { ok, note }; the token content is never read. */
function tokenState(agentProfiles, account, now = Date.now()) {
  let s;
  try {
    s = statSync(join(tokenDir(agentProfiles), account));
  } catch {
    return { ok: false, note: 'no token file' };
  }
  const mode = (s.mode & 0o777).toString(8);
  const added = tokenAdded(agentProfiles, account);
  const expiry = new Date(`${added}T00:00:00Z`);
  let expiryNote = 'expiry unknown';
  if (Number.isFinite(expiry.getTime()) && expiry.toISOString().slice(0, 10) === added) {
    // Anthropic authentication page, captured 2026-11-06, line 295: setup-token makes a one-year OAuth token.
    const month = expiry.getUTCMonth();
    expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
    if (expiry.getUTCMonth() !== month) expiry.setUTCDate(0); // February 29 -> February 28.
    const remaining = expiry.getTime() - now;
    const warning = remaining <= 0 ? 'WARNING: expired' : remaining <= 7 * 86400000 ? 'WARNING: expires within 7 days' : '';
    expiryNote = `expiry ${expiry.toISOString().slice(0, 10)}${warning ? `; ${warning}` : ''}`;
  }
  return { ok: true, note: `token file, mode ${mode}${mode === '600' ? '' : ' (should be 600)'}, added ${added}; ${expiryNote}` };
}

/** The profile's login state by its own vendor command: { loggedIn: true|false|null, account, plan, note }. A row of the accounts
 * file is logged in when its account has a token file; it runs no command. */
function check(p, ctx) {
  if (p.byFile) {
    const account = ctx.accounts[p.key ?? p.profile] ?? null;
    if (!account) return { loggedIn: false, account: null, plan: null, note: 'no row in the accounts file' };
    const t = tokenState(ctx.agentProfiles, account);
    return { loggedIn: t.ok, account, plan: null, note: t.note };
  }
  const r = call(p.check.cmd, p.check.args, { extra: p.check.env, env: ctx.env, timeout: ctx.timeout });
  if (r.error) return { loggedIn: null, account: null, plan: null, note: r.error };
  if (p.kind === 'codex') {
    const read = readCodex(r.code);
    return { ...read, note: read.loggedIn === null ? `${p.check.cmd} exited ${r.code}` : '' };
  }
  const read = p.kind === 'gh' ? readGh(r.out) : readClaude(r.stdout);
  return read ? { ...read, note: '' } : { loggedIn: null, account: null, plan: null, note: `${p.check.cmd} printed nothing readable` };
}

/** The account of each profile the accounts file names ("<profile>=<name>" a line): the expected one for a profile whose account
 * is read, the one used for a row of the Mac mini. No file: every account not read is unknown. */
export function expectedAccounts(env, state) {
  return readAccounts(state);
}

export function contextOf(env = process.env) {
  const home = env.HOME;
  return {
    env,
    home,
    root: env.FACTORY_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../..'),
    state: env.FACTORY_STATE ?? join(home, '.local/state/factory'),
    agentProfiles: env.AGENT_PROFILES ?? join(home, '.agent-profiles'),
    runs: resolve(env.FACTORY_RUNS ?? join(home, 'factory-runs')),
    timeout: timeoutMs(env),
  };
}

// The place this command runs in and the installed copy of the factory are this node's (bin/lib/node.mjs), re-exported for the commands
// that read them from here.
export { installedRoot, placeOf };

const win = (w) => (w ? { use: w.use, resetsAt: w.resetsAt } : null);

/** The rows of one place: the profile list read through the vendors' commands. A team's row carries the quota of its account. */
export function readPlace(place, ctx) {
  let quota = [];
  if (place === 'factory') {
    try {
      quota = quotaRows({ runs: ctx.runs, state: ctx.state, root: ctx.root });
    } catch {
      quota = [];
    }
  }
  // The MacBook reads its own accounts file and letters its own token files, as `factory use` does there (#365, B5).
  const accounts = readAccounts(ctx.state);
  const seatRows = place === 'factory' ? seatAccounts(ctx.state) : {};
  const letters = new Map((place === 'factory' ? accountList(ctx) : nodeAccountList(ctx.agentProfiles)).map((a) => [a.name, a.letter]));
  let numbered = 0;
  const rows = profilesOf(place, ctx).map((p) => {
    const c = check(p, { ...ctx, accounts });
    const n = p.numbered ? (numbered += 1) : null;
    // A MacBook team's quota is what its Lead's status line kept (#365 B5); a Mac mini team's, its account's newest run report.
    const q = p.statusFile ? lastStatusLine(p.statusFile) : c.account ? quota.find((x) => x.account === c.account) : null;
    let live = null;
    // Only a team's row runs sessions; the gh row and the MacBook's rows name an account but run none.
    if (p.byFile && c.account) {
      try {
        live = liveOfAccount(ctx.runs, c.account, seatRows);
      } catch {
        live = null;
      }
    }
    // A row of the file that is not logged in shows both ways out: log its account in, or move the row to another account.
    const login = p.byFile && c.loggedIn === false ? [...(c.account ? [`factory account add ${c.account}`] : []), `factory use ${n} <letter>`].join('\n') : p.login;
    return {
      place, profile: p.profile, role: p.role, kind: KINDS[p.kind], loggedIn: c.loggedIn, account: c.account, accountFrom: c.account ? 'read' : null, plan: c.plan,
      five_hour: win(q?.windows?.five_hour), seven_day: win(q?.windows?.seven_day), asOf: q?.asOf ?? null, live, shared: [], login, note: c.note,
      n, letter: (c.account && letters.get(c.account)) || null,
    };
  });
  for (const account of tokenAccounts(ctx.agentProfiles)) {
    const note = tokenState(ctx.agentProfiles, account).note;
    rows.push({ ...blank(place, { profile: `${place}/tokens/${account}`, role: 'node token', kind: 'claude' },
      { loggedIn: true, account, plan: null }, note), n: null, letter: letters.get(account) ?? null });
  }
  return rows;
}

// accountList moved to token.mjs, so that colly-status.mjs can use it without importing this file, which `bin/factory` runs as its main module.
export { accountList };

/** Rows of piggery's two profiles through pig on the Mac mini, by ssh. */
export function readPiggery(ctx) {
  const ssh = (cmd) => call('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `tuannguyen@${HOST}`, `zsh -lc '${cmd}'`], { env: ctx.env, timeout: ctx.timeout * 4 });
  const probes = profilesOf('piggery', ctx).map((p) => ({ p, r: ssh(`${p.check.cmd} ${p.check.args.join(' ')}`) }));
  const down = probes.find(({ r }) => r.code === 255 || r.error);
  if (down) return [unreachable('piggery', down.r)];
  return probes.map(({ p, r }) => {
    if (p.kind === 'codex') {
      const read = readCodex(r.code);
      return blank('piggery', p, read, read.loggedIn === null ? `pig exited ${r.code}` : '');
    }
    const read = readClaude(r.stdout);
    return blank('piggery', p, read ?? { loggedIn: null, account: null, plan: null }, read ? '' : 'pig printed nothing readable');
  });
}

const lastLine = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'no answer';

const unreachable = (place, r) => ({ place, profile: `${place} (unreachable)`, role: '', kind: '', loggedIn: null, account: null, accountFrom: null, plan: null, five_hour: null, seven_day: null, asOf: null, live: null, shared: [], login: null, note: r.error ?? lastLine(r.out), unreachable: true });

function blank(place, p, read, note) {
  return { place, profile: p.profile, role: p.role, kind: KINDS[p.kind], loggedIn: read.loggedIn, account: read.account, accountFrom: read.account ? 'read' : null, plan: read.plan, five_hour: null, seven_day: null, asOf: null, live: null, shared: [], login: p.login, note };
}

/** The factory rows from the Mac mini: its own `factory account list --json`, run in a login shell over ssh. */
export function readFactory(ctx) {
  const r = call('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `factory@${HOST}`, "zsh -lc '~/WORKSPACES/bin/factory account list --json'"], { env: ctx.env, timeout: ctx.timeout * 4 });
  if (r.error || r.code !== 0) return [unreachable('factory', r)];
  try {
    // stdout only: ssh and the login shell may print on stderr, and a line there can start with "[" too (#180).
    const rows = JSON.parse(r.stdout.split('\n').reverse().find((l) => l.startsWith('[')));
    if (!Array.isArray(rows)) throw new Error('not a list');
    const s = (v) => (typeof v === 'string' ? v : null);
    const n = (v) => (typeof v === 'number' ? v : null);
    const w = (v) => (v && n(v.use) !== null ? { use: v.use, resetsAt: n(v.resetsAt) } : null);
    return rows.map((x) => ({
      place: 'factory', profile: s(x.profile) ?? '?', role: s(x.role) ?? '', kind: s(x.kind) ?? '', loggedIn: typeof x.loggedIn === 'boolean' ? x.loggedIn : null,
      account: s(x.account) && x.accountFrom === 'read' ? x.account : null, accountFrom: x.accountFrom === 'read' ? 'read' : null, plan: s(x.plan),
      five_hour: w(x.five_hour), seven_day: w(x.seven_day), asOf: n(x.asOf), live: n(x.live), shared: [], login: s(x.login), note: s(x.note) ?? '', n: n(x.n), letter: s(x.letter),
      ...(x.accountFrom === 'expected' && s(x.account) ? { expectedRemote: x.account } : {}),
    }));
  } catch {
    return [unreachable('factory', { out: 'ssh answered, but not with factory account list --json' })];
  }
}

/** Fills each account (read, else expected, else unknown) and "shared with": every other row of the same kind on that account. */
export function finish(rows, expected) {
  for (const r of rows) {
    if (r.unreachable) continue;
    if (r.account) r.accountFrom = 'read';
    else if (expected[r.profile] ?? r.expectedRemote) {
      r.account = expected[r.profile] ?? r.expectedRemote;
      r.accountFrom = 'expected';
    } else {
      r.account = 'unknown';
      r.accountFrom = 'unknown';
    }
    delete r.expectedRemote;
  }
  for (const r of rows) r.shared = r.account && r.account !== 'unknown' && !r.unreachable ? rows.filter((o) => o !== r && o.role !== 'node token' && o.kind === r.kind && o.account === r.account).map((o) => o.profile) : [];
  return rows;
}

const pad = (s, n) => String(s).padEnd(n);
const pct = (u) => `${Math.round(u * 1000) / 10}%`;
const utc = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
const windowCell = (w, now) => (w ? `${pct(w.use)} ${w.resetsAt != null && w.resetsAt * 1000 <= now ? '(reset since)' : w.resetsAt != null ? `@${utc(w.resetsAt * 1000)}` : ''}`.trim() : '–');

/** "Shared with" in the table: the names while they fit in 24 columns, else the first and a count; --json has the whole list. */
const sharedCell = (names) => (names.join(', ').length <= 24 ? names.join(', ') || '–' : `${names[0]} +${names.length - 1}`);

const red = (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[31m${text}\x1b[0m` : text);

/** The lines of the lettered accounts (Mac mini): for each, its 5h and 7d use with the reset, the token file, and the numbers of the
 * rows that name it. The quota is the newest a run of that account reported; "?" where none did. */
export function accountsText(rows, accounts, { now = Date.now(), agentProfiles, title = 'ACCOUNTS' }) {
  const win = (w) => (w ? windowCell(w, now) : '?');
  const heads = accounts.map(({ name, letter }) => {
    const members = rows.filter((r) => r.n && r.account === name);
    const q = members.filter((r) => r.asOf).sort((a, b) => b.asOf - a.asOf)[0];
    const t = tokenState(agentProfiles, name, now);
    return { name, letter, members, q, t };
  });
  const nameW = Math.max(0, ...heads.map((h) => h.name.length));
  const rowsOf = (h) => (h.members.length ? `rows ${h.members.map((r) => r.n).join(', ')}` : 'no row');
  const rowsW = Math.max(0, ...heads.map((h) => rowsOf(h).length));
  const lines = [title];
  for (const h of heads) {
    const text = `  ${h.letter}  ${pad(h.name, nameW)}  5H ${pad(win(h.q?.five_hour), 17)}  7D ${pad(win(h.q?.seven_day), 17)}  ${pad(rowsOf(h), rowsW)}  ${h.t.note}`;
    lines.push(h.t.ok ? text : red(text));
  }
  return lines;
}

/** The text of the table: the profiles, then the accounts block where there is one, then the quota of the rows that have one, then
 * what to do and what to know. A row of the Mac mini has its number first and its account's letter after the name; one that is not
 * logged in is red on a terminal. */
export function tableText(rows, { now = Date.now(), accounts = null } = {}) {
  const normal = rows.filter((r) => !r.unreachable && r.role !== 'node token');
  const numbered = normal.some((r) => r.n);
  const heads = [...(numbered ? ['#'] : []), 'PROFILE', 'ROLE', 'KIND', 'IN', 'ACCOUNT', 'PLAN', 'LIVE', 'SHARED WITH / WHY NOT READ'];
  const cells = normal.map((r) => [...(numbered ? [r.n ?? '–'] : []), r.profile, r.role, r.kind, r.loggedIn === null ? '?' : r.loggedIn ? 'yes' : 'NO', `${r.accountFrom === 'expected' ? `${r.account}*` : r.account}${r.letter ? ` (${r.letter})` : ''}`, r.plan ?? '–', r.live ?? '–', r.loggedIn === null ? r.note : sharedCell(r.shared)]);
  const widths = heads.slice(0, -1).map((h, i) => Math.max(h.length, ...cells.map((c) => String(c[i]).length)));
  const line = (c) => [...c.slice(0, -1).map((x, i) => pad(x, widths[i])), c.at(-1)].join('  ').trimEnd();
  const out = [line(heads), ...cells.map((c, i) => (numbered && normal[i].loggedIn === false && normal[i].n ? red(line(c)) : line(c)))];
  for (const r of rows.filter((x) => x.unreachable)) out.push(`${r.profile}  ${r.note}`);
  if (accounts?.length) out.push('', ...accounts);
  const tokens = rows.filter((r) => r.role === 'node token');
  // Each account's letter, a spare's too, so `factory use <row> <letter>` finds it here (#365 B5).
  if (tokens.length) out.push('', 'TOKENS BY NODE', ...tokens.map((r) => `  ${r.place === 'factory' ? HOST : r.place}  ${r.account}${r.letter ? ` (${r.letter})` : ''}  ${r.note}`));
  // One row for each account, not for each team: teams on one account share it.
  const quota = normal.filter((r) => (r.five_hour || r.seven_day || r.asOf) && r.account && r.account !== 'unknown').filter((r, i, all) => all.findIndex((o) => o.account === r.account) === i);
  if (quota.length) {
    const names = quota.map((r) => `account ${r.account}`);
    const qw = Math.max(7, ...names.map((n) => n.length));
    out.push('', `${pad('QUOTA', qw)}  ${pad('5H USE @RESET (UTC)', 21)}  ${pad('7D USE @RESET (UTC)', 21)}  AS OF (UTC)`);
    for (const [i, r] of quota.entries()) out.push(`${pad(names[i], qw)}  ${pad(windowCell(r.five_hour, now), 21)}  ${pad(windowCell(r.seven_day, now), 21)}  ${r.asOf ? utc(r.asOf) : '–'}`);
  }
  out.push('', 'Quota is reported for each account that has run a session: from the run logs, and on the MacBook from its team\'s Lead\'s status line; every other row: not reported.', '* = the expected account (a local file), not one read.');
  const out_ = normal.filter((r) => r.loggedIn !== true);
  if (out_.length) {
    out.push('', 'Not logged in or not readable:');
    for (const r of out_) out.push(`  ${r.profile}${r.note ? ` (${r.note})` : ''}`, ...(r.login ?? '').split('\n').map((l) => `    ${l}`));
  }
  const notes = normal.filter((r) => r.loggedIn === true && r.note);
  if (notes.length) out.push('', 'Notes:', ...notes.map((r) => `  ${r.profile}: ${r.note}`));
  return out.join('\n');
}

const USAGE = `usage: bin/factory account list [--all] [--json]
       bin/factory account add <account> [--node <node>] [--no-setup]
       bin/factory account add linear-app <client-id|client-secret>   (the Factory app's Linear credentials, #403; no setup-token)
       bin/factory store <account>   (on this node; reads the token from stdin; \`store linear-app <client-id|client-secret>\` likewise)
       bin/factory use [--node <node>] [<row|repo-team> [<letter>]]   (the row's account becomes the letter's, on the node whose accounts file has the row: on the MacBook a team of its own file, nothing restarted; else on the Mac mini, by ssh from the MacBook, where <repo>-<team> makes a team's row and that team's running Lead restarts when idle; --node macbook makes a MacBook team's first line)
       bin/factory account remove <account>   (moves this node's account token into the archive)
       bin/factory colly   (starts Colly in this pane on the MacBook)
       bin/factory colly --line [--width N]
       bin/factory colly --brief [--after <seq>]
       bin/factory lead <repo> [--team <name> | --new-team] [--new] [--dry-run]
       bin/factory lead <repo> [--team <name> | --new-team] --here [-- <claude arguments>]   (on the MacBook: a Lead with no GitHub login of the Human's)
       bin/factory lead --resume-session <id> [--check]
       bin/factory gh <gh arguments>   (under the agents' login: here, with this node's stored agents GitHub token; otherwise, on the MacBook, on the Mac mini)
       bin/factory linear take|release|accept|decline|duplicate|read|list|comment|ask|answered|create|onboard ...   (a Lead's Linear steps, #404; here when this node's store holds the Factory app's credentials, else on the Mac mini, a body on stdin; decision-create and decision-close always on the Mac mini)
       bin/factory codex --role <role> [--effort <e>] [--write <folder>]   (a pstack step on another model family, on Codex, #182; the brief on stdin)
       bin/factory wake <repo> --issue <n> [--team <name>]   (wakes the Lead of a team that holds the issue, with no keys typed into its pane; on the MacBook, by ssh unless its own Lead runs there)`;

/** On the MacBook: the same `factory <sub> <args>` on the Mac mini, in a login shell over ssh, on this terminal's own streams;
 * -t asks for a terminal of its own. The exit code is the remote command's. */
function onHostBySsh(sub, args, tty, env) {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', ...(tty ? ['-t'] : []), `factory@${HOST}`, `zsh -lc '~/WORKSPACES/bin/factory ${[sub, ...args].join(' ')}'`], { stdio: 'inherit', env });
  if (r.error) {
    console.error(`bin/factory: ${sub}: ssh did not run (${r.error.code ?? 'error'})`);
    return 1;
  }
  return r.status ?? 1;
}

/** `factory lead <repo> [--team <name> | --new-team] [--new] [--dry-run]` (#166, #196): starts the pstack Lead of one team of a repository. On
 * the factory host it runs this clone's packs/pstack/bin/lead; on the MacBook it runs the same command there by ssh. The name, the
 * team (the grammar of bin/lib/names.mjs) and the flags are checked before anything runs.
 * --resume-session restores a recorded --here session; --check only tests whether its record exists. */
function lead(all, env) {
  if (all[0] === '--resume-session') {
    const [, session, check] = all;
    if (!session || all.length > 3 || (check !== undefined && check !== '--check')) {
      console.error(USAGE);
      return 2;
    }
    let saved;
    try {
      if (!/^[A-Za-z0-9-]+$/.test(session)) return 1;
      saved = JSON.parse(readFileSync(join(contextOf(env).state, 'lead-here', `${session}.json`), 'utf8'));
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(saved.repo ?? '') || !TEAM.test(saved.team ?? '') || typeof saved.cwd !== 'string') return 1;
    } catch { return 1; }
    if (check) return 0;
    return leadHere(saved.repo, saved.team, ['--resume', session], env, saved.cwd);
  }
  // What follows `--` is for claude, and only `--here` takes it.
  const dd = all.indexOf('--');
  const args = dd === -1 ? all : all.slice(0, dd);
  const passed = dd === -1 ? null : all.slice(dd + 1);
  const [repo, ...more] = args;
  const flags = [];
  let teams = 0;
  let okTeam = true;
  let team = null;
  for (let i = 0; i < more.length; i++) {
    if (more[i] === '--team') {
      teams += 1;
      team = more[++i] ?? '';
      okTeam = okTeam && TEAM.test(team);
    } else flags.push(more[i]);
  }
  const here = flags.includes('--here');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo ?? '') || teams > 1 || !okTeam || flags.some((f) => f !== '--new' && f !== '--dry-run' && f !== '--here' && f !== '--new-team') || new Set(flags).size !== flags.length || (teams && flags.includes('--new-team')) || (here ? flags.some((f) => !['--here', '--new-team'].includes(f)) : passed !== null)) {
    console.error(USAGE);
    return 2;
  }
  if (here) {
    try { team ??= pickTeam(repo, { ...contextOf(env), newTeam: flags.includes('--new-team') }); }
    catch (e) { console.error(e.message); return 2; }
    return leadHere(repo, team, passed ?? [], env);
  }
  if (placeOf(env) !== 'factory') return onHostBySsh('lead', args, true, env);
  const r = spawnSync(resolve(fileURLToPath(import.meta.url), '../../../packs/pstack/bin/lead'), args, { stdio: 'inherit', env });
  if (r.error) {
    console.error(`bin/factory: lead: ${r.error.code ?? 'error'}`);
    return 1;
  }
  return r.status ?? 1;
}

/** The agents' git name and e-mail (#349, #366). With the node's agents token, from GitHub: `gh api user` gives the login and the id,
 * and the e-mail is GitHub's noreply address for them; this node's own git settings are the Human's and are never read. Without it, read
 * on the factory host as the host's user, from its own git settings: no account is named in this repository. { name, email }, or null
 * when the read fails or gives nothing. */
function hostIdentity(env, token) {
  if (token) {
    const r = spawnSync('gh', ['api', '-X', 'GET', 'user'], {
      encoding: 'utf8', env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: '' }, timeout: 30000, killSignal: 'SIGKILL',
    });
    if (r.error || r.status !== 0) return null;
    try {
      const { login, id } = JSON.parse(r.stdout);
      return typeof login === 'string' && login.trim() && Number.isSafeInteger(id) && id > 0
        ? { name: login, email: `${id}+${login}@users.noreply.github.com` } : null;
    } catch { return null; }
  }
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `factory@${HOST}`, `zsh -lc 'echo "name:$(git config --global user.name)"; echo "email:$(git config --global user.email)"'`], { encoding: 'utf8', env, timeout: 30000, killSignal: 'SIGKILL' });
  if (r.error || r.status !== 0) return null;
  const name = /^name:(.+)$/m.exec(r.stdout)?.[1].trim();
  const email = /^email:(.+)$/m.exec(r.stdout)?.[1].trim();
  return name && email ? { name, email } : null;
}

// A push over HTTPS to GitHub fails at once, with this unreachable URL and its reason in the message; git over ssh is off (see
// GIT_SSH_COMMAND). A fetch over HTTPS is not rewritten, so it stays on the MacBook. The credential.helper entry empties every helper
// git has been given.
const PUSH_BASE = 'file:///nonexistent/factory-lead-pushes-from-the-mac-mini/';
// Git runs this in place of ssh, so no ssh connection or key is used: it says why on stderr and exits 1.
const GIT_SSH_COMMAND = "sh -c 'echo git over ssh is off for a MacBook Lead, pushes go from the Mac mini >&2; exit 1'";
const GIT_CONFIG = [
  ['credential.helper', ''],
  ...['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'].map((from) => [`url.${PUSH_BASE}.pushInsteadOf`, from]),
];

/** git settings as the environment variables git reads them from: GIT_CONFIG_COUNT and a GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n pair for each. */
const gitConfigEnv = (pairs) => ({
  GIT_CONFIG_COUNT: String(pairs.length),
  ...Object.fromEntries(pairs.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
});

/** The git fence of a factory session on this MacBook that holds no agents' GitHub token: a `--here` Lead without one (#366) and Colly,
 * always (#365 B8). No password prompt, ssh off (GIT_SSH_COMMAND), every credential helper emptied, and GitHub's push URLs rewritten to
 * an unreachable one (GIT_CONFIG), so a push can never use the Human's own credential helper or SSH key. Fetches are untouched. */
export const noPushGitEnv = () => ({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND, ...gitConfigEnv(GIT_CONFIG) });

// What the auto-mode classifier of a MacBook Lead and of Colly is told is inside its boundary (#366, #365): it trusts only the working
// folder and its remotes by default, so it refused `ssh factory@<host>` on 2026-11-06, and every `factory gh`, `factory linear` and seat
// goes through that ssh. Claude Code reads autoMode from --settings, never from a project's .claude/ (code.claude.com/docs/en/auto-mode-config);
// "$defaults" keeps the built-in entries, which a list without it replaces.
const AUTO_MODE_ENVIRONMENT = [
  '$defaults',
  `Key internal services: the factory host ${HOST}, the Human's own Mac mini, reached over ssh as factory@${HOST} (factory is the agents' macOS account there). The factory's sessions on this MacBook (a team's Lead, and Colly, the Human's own assistant) run their routine work there through that ssh: the factory's own command ~/WORKSPACES/bin/factory (linear, wake, account list, and gh while this MacBook holds no agents' GitHub token), a Lead's workers with /Users/factory/WORKSPACES/bin/seat, Colly's watch of the factory's events with /Users/factory/WORKSPACES/bin/factory-events --follow, and reads of that account's git settings.`,
  `Org-specific CLIs: factory, the factory's own command (bin/factory of this checkout). factory gh runs gh under the agents' GitHub login: on this MacBook itself when its own token store holds the agents' GitHub token, otherwise on ${HOST} over ssh factory@${HOST}. factory linear runs on this MacBook itself when its own token store holds the Factory app's credentials, otherwise on ${HOST} over that ssh, and Colly's decision-create and decision-close always run on ${HOST}; factory wake runs on ${HOST} over that ssh. factory use and factory account add are the Human's, never a Lead's.`,
  `Source control: github.com/tuannd9288, the Human's GitHub account, and every repository under it; the factory's Leads read and write their issues and pull requests through factory gh. Pushes to them go over HTTPS as the agents' GitHub account: from this MacBook when it holds the agents' GitHub token, otherwise from ${HOST}.`,
];

// What Colly's auto-mode classifier is told (#365 B8). The Mac mini and the factory's commands are inside, as for a MacBook Lead, but
// Colly pushes nothing: its git cannot reach GitHub (noPushGitEnv), so no source-control write is routine for it. "$defaults" keeps
// the built-in entries.
const COLLY_AUTO_MODE_ENVIRONMENT = [
  '$defaults',
  `Key internal services: the factory host ${HOST}, the Human's own Mac mini, reached over ssh as factory@${HOST} (factory is the agents' macOS account there). Colly, the Human's own assistant on this MacBook, runs its routine work there through that ssh: the factory's own command ~/WORKSPACES/bin/factory (gh, linear, wake, account list) and its watch of the factory's events with /Users/factory/WORKSPACES/bin/factory-events --follow.`,
  `Org-specific CLIs: factory, the factory's own command (bin/factory of this checkout). factory gh runs gh under the agents' GitHub login, on ${HOST} over ssh factory@${HOST}, or on this MacBook itself when its token store holds the agents' GitHub token; factory linear runs on this MacBook itself when its token store holds the Factory app's credentials, else on ${HOST}, and decision-create and decision-close always run on ${HOST}; factory wake runs on ${HOST}. On the Human's spoken word Colly runs factory use and factory lead; factory account add, factory account remove and factory store are the Human's, never Colly's.`,
  `Source control: github.com/tuannd9288, the Human's GitHub account, and every repository under it. Colly reads them, and reads and writes their issues and pull requests only through factory gh, as the agents. Colly pushes nothing and makes no source-control write of its own: its git cannot push to GitHub, and a git push, a force push, or a branch or tag write by Colly is never routine.`,
];

/** Where the socket of the MacBook Lead of a repository's team is recorded (#351), beside `lead-here`'s other files. */
export const wakeFile = (state, repo, team) => join(state, 'lead-here', `${repo}-${team}.socket`);

/** Where a MacBook Lead's status line keeps the newest quota Claude Code showed it (#365 B5, bin/lib/statusline-hook.mjs). */
const statusFile = (runs, repo, team) => join(runs, `${repo}-${team}`, 'statusline.jsonl');

/** `factory wake <repo> --issue <n> [--team <name>]` (#351): posts one line into the Lead's Claude Code inbox socket, which says to re-read
 * the issue and carries nothing else (bin/lib/wake.mjs); the message itself is a comment on the issue. On the factory host the socket is the
 * one `<runs>/<repo>-<team>/socket` records; on the MacBook it is the one `factory lead --here` recorded when the Lead of that team runs there,
 * and otherwise the same command runs on the factory host by ssh. One line is printed. Exit 0 posted, 1 not posted (the reason; the comment
 * waits on GitHub), 2 usage. */
async function wake(args, env) {
  const [repo, ...more] = args;
  let issue = null;
  let team = null;
  let ok = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo ?? '');
  const seen = new Set();
  for (let i = 0; i < more.length && ok; i++) {
    const flag = more[i];
    if (seen.has(flag)) {
      ok = false;
      break;
    }
    seen.add(flag);
    if (flag === '--issue') {
      issue = more[++i] ?? '';
      ok = /^[1-9][0-9]{0,8}$/.test(issue);
    } else if (flag === '--team') {
      team = more[++i] ?? '';
      ok = TEAM.test(team);
    } else ok = false;
  }
  if (!ok || issue === null) {
    console.error(USAGE);
    return 2;
  }
  const { state, runs } = contextOf(env);
  const onHost = placeOf(env) === 'factory';
  try { team ??= pickTeam(repo, { ...contextOf(env), existing: true }); }
  catch (e) { console.error(e.message); return 2; }
  const file = onHost ? join(runs, `${repo}-${team}`, 'socket') : wakeFile(state, repo, team);
  if (!onHost && !existsSync(file)) {
    const code = remote('wake', args, env);
    // The host's own answer is 0 or 1 and says why; anything else (ssh's 255, a timeout) is a host that did not answer.
    if (code > 1 || code === null) console.log(`did not wake the Lead of ${repo} (team ${team}): the Mac mini did not answer; the comment on #${issue} waits on GitHub`);
    return code === 0 ? 0 : 1;
  }
  const r = await post(file, wakeLine(repo, issue));
  if (r.posted) {
    console.log(`woke the Lead of ${repo} (team ${team}) for #${issue}`);
    return 0;
  }
  console.log(`did not wake the Lead of ${repo} (team ${team}): ${r.why}; the comment on #${issue} waits on GitHub`);
  return 1;
}

/** Copies bin/lib/<name>.mjs (socket-hook, statusline-hook) to <dir>/<name>-<sha7 of its bytes>.mjs unless a copy is there (reused, never
 * written again), and returns the path. A changed script has another name, so an earlier copy stays for the Leads that run it; each
 * imports only node: modules. */
function copyLibHook(dir, name) {
  const from = resolve(fileURLToPath(import.meta.url), `../${name}.mjs`);
  const bytes = readFileSync(from);
  const to = join(dir, `${name}-${createHash('sha256').update(bytes).digest('hex').slice(0, 7)}.mjs`);
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    const tmp = `${to}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, to);
  }
  return to;
}

/** A fresh profile asks at its first start whether to trust the folder, and stops there (#366). So, as agent-orchestrator does before
 * each launch (ensureClaudeLaunchConfigForOS in backend/internal/adapters/agent/claudecode/claudecode.go, at 9dc1c14), the profile's
 * <config>/.claude.json gets projects[<folder>].hasTrustDialogAccepted = true for the folder the Lead starts in, by its real path, the key
 * Claude Code reads (2.1.319, 2026-11-06: a key under /var/... for a folder whose real path is /private/var/... still asks). Only that key
 * is added, every other key and the file's mode kept, through a temporary file and a rename; nothing is written when it is already true.
 * markOnboarded runs first, so the file exists and holds a JSON object. */
function markTrusted(config, folder) {
  const file = join(config, '.claude.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const projects = json.projects && typeof json.projects === 'object' && !Array.isArray(json.projects) ? json.projects : {};
  const entry = projects[folder] && typeof projects[folder] === 'object' ? projects[folder] : {};
  if (entry.hasTrustDialogAccepted === true) return;
  const mode = statSync(file).mode & 0o777;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...json, projects: { ...projects, [folder]: { ...entry, hasTrustDialogAccepted: true } } }, null, 2)}\n`, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** `factory lead <repo> --here [--team <name>] [-- <claude arguments>]` (#349), on the MacBook: `claude` in this terminal and folder
 * as the Lead of the repository, with the Human's GitHub login out of its reach. Through `--settings`, whose `env` reaches every
 * command the Lead runs whatever its shell profile does to PATH: an empty GH_CONFIG_DIR and empty GH_TOKEN and GITHUB_TOKEN (gh has
 * no login here; `factory gh` runs it on the Mac mini), the agents' git identity, an emptied credential.helper list, no git password
 * prompt, a push URL that cannot be reached for GitHub's HTTPS addresses, and an ssh command that only fails (a push goes from the
 * Mac mini); `gh auth` and `security` (the Keychain) are denied. It refuses to start when the gh folder holds hosts.yml, the file a gh login writes.
 * With the agents' GitHub token in this node's own token store (#366), gh and pushes to GitHub run here instead: the token is in claude's
 * process environment as GH_TOKEN, never in the settings or an argument; a git credential helper for https://github.com reads it from there;
 * GitHub's ssh addresses go over HTTPS; and the git identity comes from GitHub with that token (hostIdentity), so the team ships with the
 * Mac mini off. Without that token, everything above holds as it is.
 * The session runs on the team's own profile and token, in auto mode with the factory host and its commands inside the classifier's
 * boundary (AUTO_MODE_ENVIRONMENT), and the folder it starts in is trusted in that profile, so a first start asks nothing (#366). */
function leadHere(repo, team, passed, env, cwd = process.cwd()) {
  if (placeOf(env) === 'factory') {
    console.error('bin/factory: lead --here runs on the MacBook; on the Mac mini use factory lead without it');
    return 2;
  }
  const token = nodeGithubToken(env);
  const id = hostIdentity(env, token);
  if (!id) {
    console.error(token
      ? "bin/factory: lead --here: could not read the agents' GitHub identity; nothing was started"
      : "bin/factory: lead --here: could not read the factory host's git user.name and user.email; nothing was started");
    return 1;
  }
  const { state, agentProfiles } = contextOf(env);
  const account = readAccounts(state)[`factory/${repo}-${team}`];
  if (accountRefusal(account)) {
    console.error('bin/factory: lead --here: the team needs an account in this node’s accounts file');
    return 2;
  }
  const claudeToken = readTokenFile(join(tokenDir(agentProfiles), account));
  if (claudeToken.error) {
    console.error('bin/factory: lead --here: no usable local token; run factory account add on this node');
    return 2;
  }
  const config = join(agentProfiles, 'leads', `${repo}-${team}`, 'claude');
  try {
    mkdirSync(config, { recursive: true, mode: 0o700 });
    markOnboarded(config);
    markTrusted(config, realpathSync(cwd));
  } catch {
    console.error('bin/factory: lead --here: could not prepare the local profile');
    return 1;
  }
  const rolePath = resolve(fileURLToPath(import.meta.url), '../../../packs/pstack/lead.md');
  let roleText;
  try {
    const linear = onLinear(repo, state);
    roleText = existsSync(rolePath) ? roleOf(readFileSync(rolePath, 'utf8'), Boolean(linear))
      .replaceAll('{{TEAM}}', team).replaceAll('{{TEAMKEY}}', () => linear?.key ?? '') : '';
  } catch (e) {
    console.error(`bin/factory: lead --here: ${e.message}`);
    return 2;
  }
  if (!roleText.trim()) {
    console.error(`bin/factory: lead --here: ${rolePath} is missing or empty`);
    return 2;
  }
  const parent = join(state, 'lead-here');
  const empty = join(parent, 'gh-empty');
  try {
    mkdirSync(empty, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    chmodSync(empty, 0o700);
  } catch (e) {
    console.error(`bin/factory: lead --here: ${e.message}`);
    return 1;
  }
  if (readdirSync(empty).includes('hosts.yml')) {
    console.error(`bin/factory: lead --here: ${join(empty, 'hosts.yml')} exists; a login was written there, so nothing was started`);
    return 1;
  }
  // Keep the local wake socket and install the pack's transcript/state copier (#476). They run a copy of the script named by its
  // hash, so a pull that changes the installed one leaves a live Lead's hook as it was (#257, #390).
  let hook, transcriptHook, statusHook;
  const runDir = join(contextOf(env).runs, `${repo}-${team}`);
  try {
    hook = copyLibHook(join(state, 'hooks'), 'socket-hook');
    transcriptHook = copyHook({ root: resolve(fileURLToPath(import.meta.url), '../../..'), runDir });
    statusHook = copyLibHook(join(runDir, 'hooks'), 'statusline-hook');
    mkdirSync(join(contextOf(env).runs, `${repo}-${team}`), { recursive: true });
  } catch (e) {
    console.error(`bin/factory: lead --here: ${e.message}`);
    return 1;
  }
  const record = [{ hooks: [{ type: 'command', command: [process.execPath, hook, wakeFile(state, repo, team)].map(quote).join(' ') }] }];
  // The session writes its transcript under the profile it runs on, the only folder transcript-copy.mjs copies from.
  const copy = { hooks: [{ type: 'command', command: `CLAUDE_CONFIG_DIR=${quote(config)} ${[process.execPath, transcriptHook, join(runDir, 'transcripts')].map(quote).join(' ')}` }] };
  // With the node's agents token, git pushes to GitHub over HTTPS with it: one credential helper for https://github.com that reads
  // $GH_TOKEN from the session's environment, and GitHub's ssh addresses rewritten to HTTPS. Without it, pushes stay blocked (GIT_CONFIG).
  const gitConfig = token ? TOKEN_GIT : GIT_CONFIG;
  const settings = {
    autoMode: { environment: AUTO_MODE_ENVIRONMENT },
    hooks: { SessionStart: [...record, copy], SessionEnd: [...record, copy], Stop: [copy], UserPromptSubmit: [copy], Notification: [copy] },
    // The team's quota for `factory account list` on this node (#365 B5): the newest rate_limits Claude Code shows the status line.
    statusLine: { type: 'command', command: [process.execPath, statusHook, statusFile(contextOf(env).runs, repo, team)].map(quote).join(' ') },
    // The settings never hold the token: with it, GH_TOKEN comes from the process environment below and is not emptied here.
    env: {
      GH_CONFIG_DIR: empty, ...(token ? {} : { GH_TOKEN: '' }), GITHUB_TOKEN: '',
      GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email,
      ...(token ? { GIT_TERMINAL_PROMPT: '0', ...gitConfigEnv(gitConfig) } : noPushGitEnv()),
    },
    // defaultMode repeats the start mode, as agent-orchestrator does for an explicit mode, so Claude Code never offers to make auto the default.
    // env and printenv as for every role and seat (#181): the session's environment holds the team's Claude token and, with a stored
    // agents token, GH_TOKEN.
    permissions: { defaultMode: 'auto', deny: [...tokenStoreDeny, 'Read(~/.agent-profiles/**)', `Read(/${agentProfiles}/**)`, 'Bash(env:*)', 'Bash(printenv:*)', 'Bash(gh auth:*)', 'Bash(security:*)', 'Bash(/usr/bin/security:*)'] },
  };
  // Keep every session beside the wake socket so a restored pane can recover its team and working folder (#366).
  const sessionFlag = passed.includes('--resume') ? '--resume' : '--session-id';
  const index = passed.indexOf(sessionFlag);
  const session = index === -1 ? randomUUID() : passed[index + 1];
  if (!session || !/^[A-Za-z0-9-]+$/.test(session)) {
    console.error('bin/factory: lead --here: a session id is required');
    return 2;
  }
  try {
    writeFileSync(join(parent, `${session}.json`), `${JSON.stringify({ repo, team, cwd })}\n`, { mode: 0o600 });
  } catch (e) {
    console.error(`bin/factory: lead --here: ${e.message}`);
    return 1;
  }
  // Auto mode, as the Mac mini's Lead and the seats start (#273), unless what follows -- names a mode. A key or a plugin cache in the
  // caller's shell would override the team's token or point at another profile's plugins, so neither reaches claude.
  const mode = passed.some((a) => a === '--permission-mode' || a.startsWith('--permission-mode=')) ? [] : ['--permission-mode', 'auto'];
  const childEnv = { ...env, ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: '' } : {}), CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_OAUTH_TOKEN: claudeToken.token };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) delete childEnv[key];
  const r = spawnSync('claude', ['--append-system-prompt', roleText, '--name', `${repo}-${team}`, ...mode, '--settings', JSON.stringify(settings),
    ...(index === -1 ? ['--session-id', session] : []), ...passed], { stdio: 'inherit', env: childEnv, cwd });
  if (r.error) {
    console.error(`bin/factory: lead --here: claude did not run (${r.error.code ?? 'error'})`);
    return 1;
  }
  return r.status ?? 1;
}

/** Colly's current-pane launch (#365): the pack supplies the approved role; GitHub writes go through `factory gh`.
 * INN-30 permits use and lead; account and store remain denied. INN-31 3A: Colly runs on its own factory profile, <state>/colly/profile,
 * signed in once by /login, with no token or key from the caller's shell, in auto mode with the Mac mini inside the classifier's boundary. */
async function colly(args, env) {
  if (args.includes('--line') || args.includes('--brief')) return collyStatus(args, env);
  if (args.length) {
    console.error(USAGE);
    return 2;
  }
  if (placeOf(env) === 'factory') {
    console.error('bin/factory: colly runs on the MacBook');
    return 2;
  }
  const { state, agentProfiles } = contextOf(env);
  const parent = join(state, 'colly');
  const socket = join(parent, 'socket');
  // Connect without writing to the recorded inbox. A stale record is not a live session.
  if (await alive(socket)) {
    let pane = '';
    try { pane = readFileSync(join(parent, 'pane'), 'utf8').trim(); } catch {}
    console.log(`Colly is already running in ${pane ? `pane ${pane}` : 'a pane (not recorded)'}`);
    if (pane) {
      for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
        const herdr = join(dir, 'herdr');
        try { accessSync(herdr, constants.X_OK); } catch { continue; }
        spawnSync(herdr, ['agent', 'focus', pane], { stdio: 'ignore', env });
        break;
      }
    }
    return 0;
  }
  const rolePath = resolve(fileURLToPath(import.meta.url), '../../../packs/colly/colly.md');
  let roleText;
  try {
    roleText = existsSync(rolePath) ? readFileSync(rolePath, 'utf8') : '';
  } catch (e) {
    console.error(`bin/factory: colly: ${e.message}`);
    return 2;
  }
  if (!roleText.trim()) {
    console.error(`bin/factory: colly: ${rolePath} is missing or empty`);
    return 2;
  }
  const empty = join(parent, 'gh-empty');
  const config = collyProfile(state);
  try {
    mkdirSync(empty, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    chmodSync(empty, 0o700);
  } catch (e) {
    console.error(`bin/factory: colly: ${e.message}`);
    return 1;
  }
  if (readdirSync(empty).includes('hosts.yml')) {
    console.error(`bin/factory: colly: ${join(empty, 'hosts.yml')} exists; a login was written there, so nothing was started`);
    return 1;
  }
  // Its own profile, never the caller's (INN-31 3A): a link could lead into his personal ~/.claude. On a profile with no login, an
  // onboarded profile opens at the prompt with "Not logged in · Run /login", where the onboarding would first ask for a theme; the folder
  // Colly starts in is trusted (2.1.319, 2026-11-06).
  try {
    let link = false;
    try { link = lstatSync(config).isSymbolicLink(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (link) throw new Error(`${config} is a symlink; Colly's profile must be a plain folder, so nothing was started`);
    mkdirSync(config, { recursive: true, mode: 0o700 });
    chmodSync(config, 0o700);
    markOnboarded(config);
    markTrusted(config, realpathSync(process.cwd()));
  } catch (e) {
    console.error(`bin/factory: colly: ${e.message}`);
    return 1;
  }
  let hook;
  try {
    hook = copyLibHook(join(state, 'hooks'), 'socket-hook');
    writeFileSync(join(parent, 'pane'), `${env.HERDR_PANE_ID ?? ''}\n`, { mode: 0o600 });
  } catch (e) {
    console.error(`bin/factory: colly: ${e.message}`);
    return 1;
  }
  const record = { type: 'command', command: [process.execPath, hook, socket].map(quote).join(' ') };
  // The wrapper is carried in the settings, so its bytes stay with this session, like the hash-named socket hook.
  // SessionStart additionalContext is the documented hook output (code.claude.com/docs/en/hooks).
  // bin/factory is a Bash wrapper; run its Node entry point directly with this session's Node.
  const factory = fileURLToPath(import.meta.url);
  const brief = `const {spawnSync}=require('node:child_process');
const r=spawnSync(process.execPath,[${JSON.stringify(factory)},'colly','--brief'],{encoding:'utf8'});
if(r.status===0) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:r.stdout}}));
else process.stderr.write(r.stderr || 'factory colly --brief failed\\n');`;
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [record, { type: 'command', command: [process.execPath, '-e', brief].map(quote).join(' ') }] }],
      SessionEnd: [{ hooks: [record] }],
    },
    // Claude Code status line docs, captured 2026-11-03, line 67: refreshInterval re-runs the command every N seconds.
    statusLine: { type: 'command', command: [process.execPath, factory, 'colly', '--line'].map(quote).join(' '), refreshInterval: 60 },
    // Colly reaches the Mac mini by ssh (factory gh, bin/factory-events --follow), as a MacBook Lead does, but pushes nothing (#365 B8).
    autoMode: { environment: COLLY_AUTO_MODE_ENVIRONMENT },
    // No gh login of the Human's, and the git fence of a MacBook Lead with no agents' token: a push from Colly's pane never uses his
    // credential helper or SSH key (#365 B8, H9 rule 3).
    env: { GH_CONFIG_DIR: empty, GH_TOKEN: '', GITHUB_TOKEN: '', ...noPushGitEnv() },
    permissions: {
      defaultMode: 'auto',
      // Colly sees the accounts table on every node, which prints no token (#365, his requirement of 2026-11-06).
      allow: ['Bash(factory use:*)', 'Bash(bin/factory use:*)', 'Bash(factory lead:*)', 'Bash(bin/factory lead:*)', 'Bash(factory account list:*)', 'Bash(bin/factory account list:*)'],
      // The token store holds the teams' Claude tokens and the agents' GitHub token: Colly never reads one (INN-31 3A), nor adds,
      // removes or stores one. Not tokenStoreDeny as a whole, which denies factory use, a command INN-30 allows Colly.
      deny: [
        'Read(~/.agent-profiles/**)', `Read(/${agentProfiles}/**)`,
        'Bash(gh auth:*)', 'Bash(security:*)', 'Bash(/usr/bin/security:*)',
        'Bash(*factory account add*)', 'Bash(*factory account remove*)', 'Bash(*factory store*)',
        'Bash(*lib/factory.mjs account add*)', 'Bash(*lib/factory.mjs account remove*)', 'Bash(*lib/factory.mjs store*)',
      ],
    },
  };
  // /login is the only sign-in: no token or key from the caller's shell, and no other profile's plugin cache.
  const childEnv = { ...env, CLAUDE_CONFIG_DIR: config };
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) delete childEnv[key];
  const r = spawnSync('claude', ['--append-system-prompt', roleText, '--name', 'colly', '--permission-mode', 'auto', '--settings', JSON.stringify(settings)], { stdio: 'inherit', env: childEnv });
  if (r.error) {
    console.error(`bin/factory: colly: claude did not run (${r.error.code ?? 'error'})`);
    return 1;
  }
  return r.status ?? 1;
}

// A word that starts with `=` is never bare: zsh would read it as a command's path.
const SAFE_WORD = /^[A-Za-z0-9_.,:/@%+-][A-Za-z0-9_.,:/=@%+-]*$/;

/** The reason `gh <args>` may not go to the Mac mini, or null. Refused: `gh auth` but `status`, and `gh auth status` with
 * `-t` or `--show-token`, which print a token; `--recover`; and a file given with `--body-file`, `--notes-file`, `--env-file`,
 * `--input`, `--field` or `-F` (alone or in a cluster of short flags), which names a file on this Mac and not on the Mac mini, so
 * the file must come on stdin (`-`, `@-`). With local true (gh runs on this node with its agents token, #366), only the two auth rules
 * apply: a local file is there. */
function ghRefusal(args, local = false) {
  if (args[0] === 'auth' && args[1] !== 'status') return 'gh auth is refused here; only gh auth status runs';
  if (args[0] === 'auth' && args.slice(2).some((a) => /^--show-token(=.*)?$/s.test(a) || /^-[A-Za-z]*t[A-Za-z]*(=.*)?$/s.test(a))) return 'gh auth status -t / --show-token is refused here; it prints a token';
  if (local) return null;
  const api = args[0] === 'api';
  const stdinHint = 'the Mac mini cannot read a file on this Mac; pass it on stdin with - (--body-file -, --input -) or @- (-F name=@-)';
  const fieldFile = (v) => {
    const path = /^[^=]+=@(.*)$/s.exec(v)?.[1];
    return path !== undefined && path !== '-';
  };
  const longFlags = ['--body-file', '--notes-file', '--env-file', '--input', '--field', '--recover'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let flag = null;
    let value;
    const long = new RegExp(`^(${longFlags.join('|')})=(.*)$`, 's').exec(a);
    const cluster = /^-[A-Za-z]*F(.*)$/s.exec(a);
    if (long) [, flag, value] = long;
    else if (cluster) [flag, value] = ['-F', cluster[1] === '' ? args[++i] : cluster[1].replace(/^=/, '')];
    else if (longFlags.includes(a)) [flag, value] = [a, args[++i]];
    if (flag === null || value === undefined) continue;
    const field = flag === '-F' || flag === '--field';
    const file = flag === '--recover' || (field ? (api || value.includes('=') ? fieldFile(value) : value !== '-') : value !== '-');
    if (file) return `${flag} ${value} names a file on this Mac; ${stdinHint}`;
  }
  return null;
}

/** `factory gh <args>` (#349): on the MacBook, `gh <args>` on the factory host, in the host user's login shell over ssh, under the
 * agents' login; stdin passes through, the exit code is gh's. The command first makes a new temporary folder on the host with
 * `mktemp -d` and enters it, so that a relative path in an argument names nothing, and removes it after gh, keeping gh's exit
 * code. Each argument is quoted for `zsh -lc`, and the whole line once
 * more for the remote login shell. With the agents' token in this node's own token store, gh runs here instead, the token in its
 * GH_TOKEN alone (#366), so it works with the Mac mini off and a local file works. On the factory host it runs gh itself, unchanged,
 * whatever the token store holds. */
function ghCmd(args, env) {
  const token = nodeGithubToken(env);
  if (token) {
    const refused = ghRefusal(args, true);
    if (refused) {
      console.error(`bin/factory: gh: ${refused}`);
      return 2;
    }
  }
  if (token || placeOf(env) === 'factory') {
    const r = spawnSync('gh', args, { stdio: 'inherit', env: token ? { ...env, GH_TOKEN: token, GITHUB_TOKEN: '' } : env });
    if (r.error) {
      console.error(`bin/factory: gh: ${r.error.code ?? 'error'}`);
      return 1;
    }
    return r.status ?? 1;
  }
  const refused = ghRefusal(args);
  if (refused) {
    console.error(`bin/factory: gh: ${refused}`);
    return 2;
  }
  const word = (a) => (SAFE_WORD.test(a) ? a : quote(a));
  const script = `d=$(mktemp -d) && cd "$d" || exit 2; ${['gh', ...args.map(word)].join(' ')}; c=$?; cd /; rm -rf "$d"; exit $c`;
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', `factory@${HOST}`, `zsh -lc ${quote(script)}`], { stdio: 'inherit', env });
  if (r.error) {
    console.error(`bin/factory: gh: ssh did not run (${r.error.code ?? 'error'})`);
    return 1;
  }
  return r.status ?? 1;
}

/** `factory linear <verb> ...` (#404): a Lead's steps on a repository on Linear (bin/lib/linear-cli.mjs). On the factory host it runs there and
 * reads the Factory app's token in its own process. On another node it runs there too when the node's own token store holds the app's
 * client id and secret (FAC-38, #490's shape for `factory gh`): the node mints its own token, which leaves the host's alive, and reads its
 * own registry. Otherwise, and always for the verbs that act as Colly, it runs the same command on the host, in the host user's login shell
 * over ssh, with stdin passed through. A body comes on stdin (`--body-file -`); the arguments are checked here first, so no token or file of
 * this Mac is involved. One JSON object on stdout; exit 0, 1 (Linear refused or failed) or 2 (usage). */
async function linearCmd(args, env) {
  const cli = await import('./linear-cli.mjs');
  const { appStored } = await import('./linear.mjs');
  const here = !cli.COLLY_VERBS.includes(args[0]) && appStored(env.AGENT_PROFILES ?? join(env.HOME, '.agent-profiles'));
  if (placeOf(env) === 'factory' || here) return cli.main(args, env);
  try {
    cli.parse(args);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    return 2;
  }
  const word = (a) => (SAFE_WORD.test(a) ? a : quote(a));
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', `factory@${HOST}`, `zsh -lc ${quote(['~/WORKSPACES/bin/factory', 'linear', ...args.map(word)].join(' '))}`], { stdio: 'inherit', env });
  if (r.error) {
    console.error(`bin/factory: linear: ssh did not run (${r.error.code ?? 'error'})`);
    return 1;
  }
  return r.status ?? 1;
}

/** `factory codex --role <role> ...` (#182): a pstack step that asks for another model family, on Codex (packs/pstack/bin/codex-step.mjs
 * has the options, the profile and the wait). On the factory host it runs there, on the verifier's Codex profile; on the MacBook the same
 * command runs on the host over ssh, stdin kept, in a new temporary folder there that is removed after, so Codex reads the brief alone: a
 * step that writes (--write) is refused here, and this folder's repository goes along as --repo for the wait log. The step gets the
 * arguments alone: it takes nothing of the caller's environment (#182), and its second argument is a seam for its tests only. */
async function codexCmd(args, env) {
  const step = await import('../../packs/pstack/bin/codex-step.mjs');
  if (placeOf(env) === 'factory') return step.main(args);
  let o;
  try {
    o = step.parse(args);
  } catch (e) {
    console.error(`bin/factory: codex: ${e.message}`);
    return 2;
  }
  if (o.write !== undefined || o.briefFile !== undefined) {
    console.error(`bin/factory: codex: ${o.write !== undefined ? '--write' : '--brief-file'} runs only on the factory host, where its file is; here, pass the brief on stdin`);
    return 2;
  }
  const repo = o.repo ?? step.repoOf(process.cwd());
  const word = (a) => (SAFE_WORD.test(a) ? a : quote(a));
  const line = ['~/WORKSPACES/bin/factory', 'codex', ...[...args, ...(o.repo || !repo ? [] : ['--repo', repo])].map(word)].join(' ');
  const script = `d=$(mktemp -d) && cd "$d" || exit 2; ${line}; c=$?; cd /; rm -rf "$d"; exit $c`;
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', `factory@${HOST}`, `zsh -lc ${quote(script)}`], { stdio: 'inherit', env });
  // ssh's own failure is 255: the step waits, as it does for Codex, and never runs on Claude.
  if (r.error || r.status === 255) {
    console.log(`codex: ${o.role} waits for Codex: the factory host could not be reached by ssh. This step does not run on Claude; say so, and go on with other work.`);
    return 3;
  }
  return r.status ?? 3;
}

/** The line told once seat 1's account has a token: the old file moved aside, never deleted. */
function movedOld(agentProfiles, state) {
  const to = retireSeat1File(agentProfiles, state);
  return to ? `moved seat 1's old token file to ${to}` : null;
}

/** Colly's status line and start-hook text, locally or on the factory host. */
async function collyStatus(args, env) {
  const textOk = (flag, opt) => args.filter((a) => a === flag).length === 1 && (args.length === 1 || (args.length === 3 && args[0] === flag && args[1] === opt && /^\d+$/.test(args[2])));
  if (!(textOk('--line', '--width') || textOk('--brief', '--after'))) {
    console.error(USAGE);
    return 2;
  }
  if (placeOf(env) === 'factory') {
    try {
      await (await import('./colly-status.mjs')).main(args);
      return 0;
    } catch (e) {
      console.error(`bin/factory: colly: ${String(e.message).split('\n')[0]}`);
      return 1;
    }
  }
  return onHostBySsh('colly', args, false, env);
}

/** `factory account add <account>`: checks the name, runs `claude setup-token` on the terminal's own streams (so what it prints goes to
 * the Human's screen and is never captured), reads the token from a hidden prompt, then stores it on this node by default, or by
 * ssh to `factory store` on the named node, the token on ssh's stdin and in no argument. */
async function login(args, env) {
  const here = placeOf(env) === 'factory' ? HOST : 'macbook';
  const at = args.indexOf('--node');
  const node = at === -1 ? here : args[at + 1];
  if (![HOST, 'macbook'].includes(node) || args.filter((a) => a === '--node').length > 1) {
    console.error(`bin/factory: --node must name macbook or ${HOST}`);
    return 2;
  }
  const words = args.filter((a, i) => a !== '--no-setup' && (at === -1 || (i !== at && i !== at + 1)));
  const app = appSlot(words);
  if (!app && words.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const [account] = words;
  const refused = app ? null : accountRefusal(account);
  if (refused) {
    console.error(`bin/factory: ${refused}`);
    return 2;
  }
  if (!app && !args.includes('--no-setup')) {
    const r = spawnSync('claude', ['setup-token'], { stdio: 'inherit', env });
    if (r.error || r.status !== 0) {
      console.error('bin/factory: claude setup-token did not finish; nothing was stored');
      return 1;
    }
  }
  let text;
  try {
    text = await readSecret();
  } catch (e) {
    console.error(`bin/factory: ${e.message}; nothing was stored`);
    return 1;
  }
  const t = tokenOf(text);
  if (t.error) {
    console.error(`bin/factory: ${t.error}; nothing was stored`);
    return 1;
  }
  if (node === here) {
    const { agentProfiles, state } = contextOf(env);
    let moved;
    try {
      if (app) writeAppFile(agentProfiles, app.app, app.file, t.token);
      else writeToken(agentProfiles, account, t.token);
      moved = app ? null : movedOld(agentProfiles, state);
    } catch (e) {
      console.error(`bin/factory: ${e.message}`);
      return 1;
    }
    console.log(app ? `stored the ${app.file} of ${app.app}` : `stored the token of ${account} in ${join(tokenDir(agentProfiles), account)}`);
    if (moved) console.log(moved);
    return 0;
  }
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `factory@${node}`, `zsh -lc '~/WORKSPACES/bin/factory store ${words.join(' ')}'`], { input: `${t.token}\n`, encoding: 'utf8', env, timeout: 60000, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT' || r.status !== 0) {
    const why = r.error?.code === 'ETIMEDOUT' ? 'timed out' : lastLine(`${r.stderr ?? ''}${r.stdout ?? ''}`);
    console.error(`bin/factory: the token was not stored on ${node}: ${why.split(t.token).join('[token]')}`);
    return 1;
  }
  console.log(app ? `stored the ${app.file} of ${app.app} on ${node}` : `stored the token of ${account} on ${node}`);
  return 0;
}

/** `account add`/`store` words that name a file of an app's folder (#403): `linear-app client-id` or `linear-app client-secret`, else null. */
function appSlot(words) {
  return words.length === 2 && APP_FOLDERS.includes(words[0]) && ['client-id', 'client-secret'].includes(words[1]) ? { app: words[0], file: words[1] } : null;
}

/** `factory store <account>`, on each node: one token from stdin, never from a terminal, written to the store. */
async function store(args, env) {
  const app = appSlot(args);
  if (!app && args.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const refused = app ? null : accountRefusal(args[0]);
  if (refused) {
    console.error(`bin/factory: ${refused}`);
    return 2;
  }
  if (process.stdin.isTTY) {
    console.error('bin/factory: store reads the token from a pipe, not a terminal');
    return 2;
  }
  const t = tokenOf(await readSecret());
  if (t.error) {
    console.error(`bin/factory: ${t.error}; nothing was stored`);
    return 1;
  }
  let moved;
  try {
    const { agentProfiles, state } = contextOf(env);
    if (app) writeAppFile(agentProfiles, app.app, app.file, t.token);
    else writeToken(agentProfiles, args[0], t.token);
    moved = app ? null : movedOld(agentProfiles, state);
  } catch (e) {
    console.error(`bin/factory: ${e.message}`);
    return 1;
  }
  console.log(app ? `stored the ${app.file} of ${app.app}` : `stored the token of ${args[0]}`);
  if (moved) console.log(moved);
  return 0;
}

/** How long ssh may run for a command: none for `use`, whose restart waits up to ten minutes for a busy Lead (`ConnectTimeout`
 * already covers a Mac mini that cannot be reached); 60 seconds for every other. */
export const remoteTimeout = (cmd) => (cmd === 'use' ? undefined : 60000);

/** `use` from the MacBook runs on the Mac mini: the arguments are checked here first (a row is a number,
 * a letter is a to z, an account matches the account pattern), then the host runs the command in a login shell over ssh, on the
 * terminal's own streams. With an argument of `use` missing, ssh gets -t so the host's list and its question reach the Human. */
function remote(cmd, args, env) {
  const bad = cmd === 'wake'
    ? null // checked by wake() before it comes here
    : cmd === 'use'
    ? (args.length > 2 ? 'use takes a row and a letter' : args[0] !== undefined && !/^[1-9][0-9]*$/.test(args[0]) && !parseTeam(args[0]) ? 'the row is a number or <repo>-<team>' : args[1] !== undefined && !/^[a-z]+$/.test(args[1]) ? 'the account is a letter, a to z' : null)
    : (args.length === 1 ? accountRefusal(args[0]) : 'account remove takes one account');
  if (bad) {
    console.error(`bin/factory: ${bad}\n${USAGE}`);
    return 2;
  }
  const tty = cmd === 'use' && args.length < 2;
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(tty ? ['-t'] : []), `factory@${HOST}`, `zsh -lc '~/WORKSPACES/bin/factory ${[cmd, ...args].join(' ')}'`], { stdio: 'inherit', env, timeout: remoteTimeout(cmd), killSignal: 'SIGKILL' });
  if (r.error) {
    console.error(`bin/factory: ${cmd} did not reach the Mac mini: ${r.error.code === 'ETIMEDOUT' ? 'timed out' : (r.error.code ?? 'failed')}`);
    return 1;
  }
  return r.status ?? 1;
}

/** The Mac mini's list as text: the numbered rows and the lettered accounts, and the line about seat 1's old file while it is there. */
function listing(ctx, env) {
  const rows = readPlace('factory', ctx);
  finish(rows, expectedAccounts(env, ctx.state));
  const text = tableText(rows, { accounts: accountsText(rows, accountList(ctx), ctx) });
  return { rows, text: existsSync(seat1File(ctx.agentProfiles)) ? `${text}\n\nseats/1/oauth-token (seat 1's old token file) is still there; it moves aside, never deleted, at the next factory account add or factory use once seat 1's account has a token.` : text };
}

const defaultAsk = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

const herdr = (args, timeout) => spawnSync('herdr', args, { encoding: 'utf8', timeout });
const stateOf = (r) => {
  const find = (v) => (v && typeof v === 'object' ? Object.entries(v).reduce((found, [k, x]) => found ?? (k === 'agent_status' && typeof x === 'string' ? x : find(x)), null) : null);
  try {
    return r.status === 0 ? find(JSON.parse(r.stdout)) : null;
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The command that starts a team's Lead, in brackets, or nothing for the factory itself: the launcher refuses `factory`, which is the
 * checkout's root and not a folder under it. */
const startNote = (repo, flag) => (repo === FACTORY_REPO ? '' : ` (factory lead ${repo}${flag})`);

/** The second half of `use` on a team's row (#179, #196, #311), after the accounts file changed: that team's Lead alone, by
 * `restartTeam`, if it runs; the other teams of the repository are not touched. 0 when it was restarted or does not run, else 1. */
async function restartLead(repo, team, account, ctx, oldAccount) {
  const hasToken = tokenState(ctx.agentProfiles, account).ok;
  const flag = ` --team ${team}`;
  // The Lead process rule: a claude process with --name <repo>-<team>. A recorded pane may hold something else by now.
  if (!leadTeams(repo).includes(team)) {
    console.log(`the Lead of ${repo} (team ${team}) is not running; it takes ${account} at its next start${startNote(repo, flag)}`);
    if (!hasToken) console.log(`${account} has no token file yet: that next start is refused until factory account add ${account}`);
    return 0;
  }
  if (!hasToken) {
    console.log(`${account} has no token file yet: factory account add ${account}; the Lead keeps running and was not restarted, and its next start is refused until then`);
    return 1;
  }
  return restartTeam(repo, team, account, ctx, oldAccount);
}

/** One team's Lead: through `herdr` on PATH, waits for its pane (<runs>/<repo>-<team>/pane, written by bin/lead inside Herdr) to
 * settle, restarts it only if idle or done (`/exit`, then until Herdr reports no agent there, then
 * `packs/pstack/bin/lead <repo> [--team <team>]` in the pane, which resumes the conversation), and otherwise leaves it running. When
 * /exit leaves the pane `blocked`, Claude Code's exit dialog for background work (#315), it sends Esc, so that Claude Code stays, starts
 * nothing, and says the Lead keeps running on `oldAccount` while its new workers take `account`. 0 once the start was sent, else 1
 * with the reason. */
async function restartTeam(repo, team, account, ctx, oldAccount) {
  const flag = ` --team ${team}`;
  const who = `the Lead of ${repo} (team ${team})`;
  const next = `${who} takes it at its next start${startNote(repo, flag)}`;
  let pane = '';
  try {
    pane = readFileSync(join(ctx.runs, `${repo}-${team}`, 'pane'), 'utf8').trim();
  } catch {
    // no pane file: the Lead did not start inside Herdr
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(pane)) {
    console.log(`no Herdr pane is recorded for ${who}; ${next}`);
    return 1;
  }
  console.log(`waiting for ${who} in pane ${pane} to settle (up to 10 minutes)`);
  const waited = herdr(['agent', 'wait', pane, '--timeout', '600000'], 610000);
  if (waited.status !== 0) {
    console.log(`${who} is not idle after the wait (or herdr failed); it keeps running and was not restarted; ${next}`);
    return 1;
  }
  const seen = stateOf(herdr(['agent', 'get', pane], 10000));
  if (seen !== 'idle' && seen !== 'done') {
    console.log(`${who} is ${seen ?? 'in a state herdr did not report'}, not idle; it keeps running and was not restarted; ${next}`);
    return 1;
  }
  console.log(`${who} is ${seen}; sending /exit`);
  if (herdr(['agent', 'prompt', pane, '/exit'], 10000).status !== 0) {
    console.log(`herdr did not take /exit; ${who} keeps running; ${next}`);
    return 1;
  }
  const until = Date.now() + (Number(ctx.env.FACTORY_GONE_MS) || 30000);
  for (let at = stateOf(herdr(['agent', 'get', pane], 10000)); at !== null; at = stateOf(herdr(['agent', 'get', pane], 10000))) {
    if (at === 'blocked') {
      // Claude Code's exit dialog ("Background work is running"): Esc stays, and nothing is started in the pane (#315).
      if (herdr(['agent', 'send-keys', pane, 'esc'], 10000).status !== 0) {
        console.log(`herdr did not take Esc at the dialog ${who} was left at after /exit; it may still be waiting there; it was not started again; ${next}`);
        return 1;
      }
      console.log(`${who} has background work running and was not restarted; the Lead keeps running on ${oldAccount ?? 'its old account'} until its next start; its new workers start on ${account} now`);
      return 1;
    }
    if (Date.now() > until) {
      console.log(`herdr still reports an agent in pane ${pane} after /exit; it was not started again; ${next}`);
      return 1;
    }
    await sleep(200);
  }
  const lead = resolve(fileURLToPath(import.meta.url), '../../../packs/pstack/bin/lead');
  if (herdr(['pane', 'run', pane, `${quote(lead)} ${repo}${flag}`], 10000).status !== 0) {
    console.log(`herdr did not run the start in pane ${pane}; ${next}`);
    return 1;
  }
  console.log(`started ${who} again in pane ${pane}; it resumes its conversation on ${account}`);
  return 0;
}

/** `factory use [--node macbook|<HOST>] <row> <letter>` (#366): it acts on the node a team runs on, which is the node whose accounts file
 * has the team's row. On the MacBook a `<repo>-<team>` of its own file is written there and any other row goes to the Mac mini, as
 * before; `--node` names the node either way, and `--node macbook` is how a MacBook team gets its first line. On the Mac mini it acts
 * there; `--node macbook` is refused, since accounts are changed from the Human's own machine (INN-31 2A). */
async function use(args, env, io) {
  const onHost = placeOf(env) === 'factory';
  const at = args.indexOf('--node');
  const named = at === -1 ? null : args[at + 1];
  if (at !== -1 && (![HOST, 'macbook'].includes(named) || args.filter((a) => a === '--node').length > 1)) {
    console.error(`bin/factory: --node must name macbook or ${HOST}`);
    return 2;
  }
  const words = at === -1 ? args : args.filter((a, i) => i !== at && i !== at + 1);
  if (onHost) {
    if (named !== 'macbook') return useOnHost(words, env, io);
    console.error('bin/factory: use --node macbook runs on the MacBook, not on the Mac mini');
    return 2;
  }
  const local = parseTeam(words[0]) && readAccounts(contextOf(env).state)[`factory/${words[0]}`];
  return (named ?? (local ? 'macbook' : HOST)) === 'macbook' ? useHere(words, env, io) : remote('use', words, env);
}

/** The MacBook's list for `use`: the team rows of its accounts file, numbered in name order, and its accounts, lettered from its own
 * token store (INN-31 1B: one token for each node and account). */
function hereListing(ctx) {
  const rows = Object.entries(readAccounts(ctx.state))
    .filter(([profile]) => profile.startsWith('factory/') && parseTeam(profile.slice('factory/'.length)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([profile, account], i) => ({ n: i + 1, profile, account }));
  const accounts = nodeAccountList(ctx.agentProfiles);
  const letters = new Map(accounts.map((a) => [a.name, a.letter]));
  const w = Math.max(0, ...rows.map((r) => r.profile.length));
  const lines = ['ROWS ON macbook', ...rows.map((r) => `  ${r.n}  ${pad(r.profile, w)}  ${r.account}${letters.has(r.account) ? ` (${letters.get(r.account)})` : ' (no token here)'}`)];
  return { rows, accounts, text: [...lines, '', ...accountsText(rows, accounts, ctx)].join('\n') };
}

/** `use` on the MacBook (#366): the line `factory/<repo>-<team>=<account>` of its own accounts file, which `factory lead <repo> --team
 * <team> --here` reads at its start. Nothing is restarted. The row is a `<repo>-<team>`, or the number of a row of its list. */
async function useHere(args, env, io) {
  if (args.length > 2) {
    console.error(USAGE);
    return 2;
  }
  const ctx = contextOf(env);
  const { rows, accounts, text } = hereListing(ctx);
  let [row, letter] = args;
  if (row === undefined || letter === undefined) {
    console.log(text);
    if (!io.isTTY) {
      console.error('bin/factory: use needs a row and an account letter');
      return 2;
    }
    if (row === undefined) row = (await io.ask('Row number or <repo>-<team>: ')).trim();
    if (letter === undefined) letter = (await io.ask('Account letter: ')).trim();
  }
  const profile = /^[1-9][0-9]*$/.test(row) ? rows.find((r) => r.n === Number(row))?.profile : parseTeam(row) && `factory/${row}`;
  if (!profile) {
    console.error(`bin/factory: there is no row ${row} on macbook; a row is <repo>-<team> or a number from 1 to ${rows.length}`);
    return 2;
  }
  const account = accounts.find((a) => a.letter === letter);
  if (!account) {
    console.error(`bin/factory: there is no account ${letter} on macbook; the letters are ${accounts.map((a) => a.letter).join(', ') || 'none: factory account add <account> stores one'}`);
    return 2;
  }
  try {
    setAccount(ctx.state, profile, account.name);
  } catch (e) {
    console.error(`bin/factory: ${e.message}`);
    return 1;
  }
  const t = parseTeam(profile.slice('factory/'.length));
  console.log(`${profile} now uses ${account.name} (${account.letter}) on macbook; nothing restarts here: the --here Lead takes it at its next start (factory lead ${t.repo} --team ${t.team} --here)`);
  return 0;
}

/** `use` on the Mac mini: the row's account in the accounts file becomes the letter's. The verifier's row is read-only; a
 * team's next seat session takes its new account and nothing else running is touched; the row also restarts that team's Lead alone,
 * if it runs (#179, #311). The row is a number, or `<repo>-<team>` for an onboarded repository or the factory, which makes the row when the file has none. */
async function useOnHost(args, env, io) {
  if (args.length > 2) {
    console.error(USAGE);
    return 2;
  }
  const ctx = contextOf(env);
  const { rows, text } = listing(ctx, env);
  let [row, letter] = args;
  if (row === undefined || letter === undefined) {
    console.log(text);
    if (!io.isTTY) {
      console.error('bin/factory: use needs a row number and an account letter');
      return 2;
    }
    if (row === undefined) row = (await io.ask('Row number: ')).trim();
    if (letter === undefined) letter = (await io.ask('Account letter: ')).trim();
  }
  let target = /^[1-9][0-9]*$/.test(row) ? rows.find((r) => r.n === Number(row)) : null;
  const named = /^[1-9][0-9]*$/.test(row) ? null : parseTeam(row);
  if (named) {
    // `<repo>-<team>` names a team of an onboarded repository or of the factory, and makes its row when the file has none (#311).
    if (!repoOk(named.repo, ctx.root)) {
      console.error(`bin/factory: ${named.repo} is not an onboarded repository or the factory; nothing was changed`);
      return 2;
    }
    target = rows.find((r) => r.profile === `factory/${row}`) ?? { profile: `factory/${row}` };
  }
  if (!target) {
    console.error(`bin/factory: there is no row ${row}; the rows are numbered 1 to ${rows.filter((r) => r.n).length}`);
    return 2;
  }
  const account = accountList(ctx).find((a) => a.letter === letter);
  if (!account) {
    console.error(`bin/factory: there is no account ${letter}; the letters are ${accountList(ctx).map((a) => a.letter).join(', ') || 'none'}`);
    return 2;
  }
  if (target.profile === 'factory/verifier') {
    console.error('bin/factory: the verifier\'s row is read-only: Codex has no token file, so use does not apply to it');
    return 2;
  }
  let moved;
  // The row's account before this rewrite: what a Lead that is not restarted keeps running on.
  const oldAccount = readAccounts(ctx.state)[target.profile];
  try {
    setAccount(ctx.state, target.profile, account.name);
    moved = movedOld(ctx.agentProfiles, ctx.state);
  } catch (e) {
    console.error(`bin/factory: ${e.message}`);
    return 1;
  }
  console.log(`${target.profile} now uses ${account.name} (${account.letter}) on ${HOST}; its next seat session takes it, and nothing else running is touched.`);
  if (moved) console.log(moved);
  const t = parseTeam(target.profile.slice('factory/'.length));
  return t ? restartLead(t.repo, t.team, account.name, ctx, oldAccount) : 0;
}

/** `factory account remove <account>`: the account's token file moves into archive/tokens, never deleted. The rows that name it stay in the
 * accounts file and start nothing until `factory account add <account>` or `factory use` gives them another. */
function logout(args, env) {
  const refused = args.length === 1 ? accountRefusal(args[0]) : 'account remove takes one account';
  if (refused) {
    console.error(`bin/factory: ${refused}\n${USAGE}`);
    return 2;
  }
  const { agentProfiles } = contextOf(env);
  try {
    const to = archiveToken(agentProfiles, args[0]);
    console.log(`moved the token of ${args[0]} to ${to}; every row that names it starts nothing until factory account add ${args[0]} or factory use`);
  } catch (e) {
    console.error(`bin/factory: ${e.message}`);
    return 1;
  }
  return 0;
}

export async function main(argv, env = process.env, io = { isTTY: Boolean(process.stdin.isTTY), ask: defaultAsk }) {
  const [cmd, ...rest] = argv;
  if (cmd === 'login' || cmd === 'logout') {
    console.error(`factory ${cmd} was renamed to factory account ${cmd === 'login' ? 'add' : 'remove'}`);
    return 2;
  }
  if (cmd === 'account') {
    if (rest[0] === 'add') return login(rest.slice(1), env);
    if (rest[0] === 'remove') return logout(rest.slice(1), env);
    if (rest[0] !== 'list') { console.error(USAGE); return 2; }
    argv = rest.slice(1);
  } else if (!cmd || ['--all', '--json'].includes(cmd)) {
    console.error('the table moved to factory account list');
    return 2;
  }
  if (cmd === 'store') return store(rest, env);
  if (cmd === 'use') return use(rest, env, io);
  if (cmd === 'top') {
    console.error("factory top was removed. Use Linear's project 'Factory release 1'.");
    return 2;
  }
  if (cmd === 'colly') return colly(rest, env);
  if (cmd === 'lead') return lead(rest, env);
  if (cmd === 'gh') return ghCmd(rest, env);
  if (cmd === 'linear') return linearCmd(rest, env);
  if (cmd === 'codex') return codexCmd(rest, env);
  if (cmd === 'wake') return wake(rest, env);
  if (argv.some((a) => a !== '--all' && a !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const ctx = contextOf(env);
  const place = placeOf(env);
  if (argv.includes('--all') && place !== 'macbook') {
    console.error('bin/factory: --all runs on the MacBook');
    return 2;
  }
  // On the MacBook a plain run is --all (the Human, 2026-10-31); --all stays accepted.
  const all = place === 'macbook';
  if (place === 'factory' && !all) {
    const { rows, text } = listing(ctx, env);
    console.log(argv.includes('--json') ? JSON.stringify(rows) : text);
    return 0;
  }
  const rows = readPlace(place, ctx);
  // The MacBook's own lettered accounts, with the quota its teams' Leads reported, before the other places' rows join (#365 B5).
  const lettered = nodeAccountList(ctx.agentProfiles);
  const accounts = lettered.length ? accountsText(rows.filter((r) => r.place === 'macbook'), lettered, { ...ctx, title: 'ACCOUNTS ON macbook' }) : null;
  if (all) rows.push(...readFactory(ctx), ...readPiggery(ctx));
  finish(rows, expectedAccounts(env, ctx.state));
  console.log(argv.includes('--json') ? JSON.stringify(rows) : tableText(rows, { accounts }));
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
