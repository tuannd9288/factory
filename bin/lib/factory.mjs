// bin/factory (#173, #177, #178, #311): the list of every agent profile in a table with each account's quota in a second one, and `login`,
// `store`, `use` and `logout`. On the Mac mini the rows are numbered (each team the accounts file names, the verifier) and the accounts
// lettered; `use` rewrites the accounts file (`use <repo>-<team>` makes a team's row; that team's running Lead alone is restarted once
// Herdr reports it idle, #179, #196; `lead <repo> [--team <name>]` starts one team's) and `logout` moves a token into the archive; `login` and
// `store` put a token in the factory's token store. The list runs only the vendors' own status commands (codex login status,
// gh auth status; on the MacBook claude auth status too), reads quota through quotaRows(), and keeps from each answer
// only the logged-in flag, the local part of the account and the plan. It reads no token (a token file shows its mode and date).
// The committed profile list below holds no account name: the factory repository is public, and an account is an email local
// part. On the Mac mini the account of a row is in $FACTORY_STATE/accounts, local to a machine, the one source of it.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quotaRows } from './quota.mjs';
import { post, wakeLine } from './wake.mjs';
import { liveOfAccount } from './seat.mjs';
import { quote } from '../../packs/pstack/bin/lead.mjs';
import { DEFAULT_TEAM, TEAM, parseTeam } from './names.mjs';
import { FACTORY_REPO, repoOk, teamRows } from './teams.mjs';
import { leadTeams } from './top.mjs';
import { accountList, accountRefusal, archiveToken, readAccounts, readSecret, retireSeat1File, seat1File, seatAccounts, setAccount, tokenAccounts, tokenDir, tokenOf, writeToken } from './token.mjs';

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

/** The profiles of a place, from the committed list. On the Mac mini the Lead rows are the ones the accounts file names. A row with
 * `byFile` has its account from that file, and its login state is the token file of that account. */
export function profilesOf(place, { home, agentProfiles, state, root }) {
  if (place === 'macbook') {
    return [
      claude('macbook/claude', 'Colly', {}, 'claude auth login'),
      ...spareFolders(home).map((n) => claude(`macbook/claude-acc${n}`, 'spare Claude', { CLAUDE_CONFIG_DIR: join(home, `.claude-acc${n}`) }, `claude-use login ${n}`)),
      { profile: 'macbook/codex', role: 'Colly Codex', kind: 'codex', check: { cmd: 'codex', args: ['login', 'status'], env: {} }, login: 'codex-use login <N>' },
      { profile: 'macbook/gh', role: 'Colly gh', kind: 'gh', check: { cmd: 'gh', args: ['auth', 'status'], env: {} }, login: 'gh auth login' },
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

/** An account's token file by its stat alone: { ok, note }; the content is never read. */
function tokenState(agentProfiles, account) {
  let s;
  try {
    s = statSync(join(tokenDir(agentProfiles), account));
  } catch {
    return { ok: false, note: 'no token file' };
  }
  const mode = (s.mode & 0o777).toString(8);
  return { ok: true, note: `token file, mode ${mode}${mode === '600' ? '' : ' (should be 600)'}, modified ${s.mtime.toISOString().slice(0, 10)}` };
}

/** The profile's login state by its own vendor command: { loggedIn: true|false|null, account, plan, note }. A row of the accounts
 * file is logged in when its account has a token file; it runs no command. */
function check(p, ctx) {
  if (p.byFile) {
    const account = ctx.accounts[p.profile] ?? null;
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

/** The factory host is where the command runs as the host's user: FACTORY_HOST_USER, `factory` unless the setting names another. */
export const placeOf = (env = process.env) => (userInfo().username === (env.FACTORY_HOST_USER || 'factory') ? 'factory' : 'macbook');

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
  const accounts = place === 'factory' ? readAccounts(ctx.state) : {};
  const seatRows = place === 'factory' ? seatAccounts(ctx.state) : {};
  const letters = place === 'factory' ? new Map(accountList(ctx).map((a) => [a.name, a.letter])) : new Map();
  let numbered = 0;
  return profilesOf(place, ctx).map((p) => {
    const c = check(p, { ...ctx, accounts });
    const n = p.numbered ? (numbered += 1) : null;
    const q = c.account ? quota.find((x) => x.account === c.account) : null;
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
    const login = p.byFile && c.loggedIn === false ? [...(c.account ? [`factory login ${c.account}`] : []), `factory use ${n} <letter>`].join('\n') : p.login;
    return {
      place, profile: p.profile, role: p.role, kind: KINDS[p.kind], loggedIn: c.loggedIn, account: c.account, accountFrom: c.account ? 'read' : null, plan: c.plan,
      five_hour: win(q?.windows?.five_hour), seven_day: win(q?.windows?.seven_day), asOf: q?.asOf ?? null, live, shared: [], login, note: c.note,
      n, letter: (c.account && letters.get(c.account)) || null,
    };
  });
}

// accountList moved to token.mjs, so that top.mjs can use it without importing this file, which `bin/factory` runs as its main module.
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

/** The factory rows from the Mac mini: its own `factory --json`, run in a login shell over ssh. */
export function readFactory(ctx) {
  const r = call('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `factory@${HOST}`, "zsh -lc '~/WORKSPACES/bin/factory --json'"], { env: ctx.env, timeout: ctx.timeout * 4 });
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
    return [unreachable('factory', { out: 'ssh answered, but not with factory --json' })];
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
  for (const r of rows) r.shared = r.account && r.account !== 'unknown' && !r.unreachable ? rows.filter((o) => o !== r && o.kind === r.kind && o.account === r.account).map((o) => o.profile) : [];
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
export function accountsText(rows, accounts, { now = Date.now(), agentProfiles }) {
  const win = (w) => (w ? windowCell(w, now) : '?');
  const heads = accounts.map(({ name, letter }) => {
    const members = rows.filter((r) => r.n && r.account === name);
    const q = members.filter((r) => r.asOf).sort((a, b) => b.asOf - a.asOf)[0];
    const t = tokenState(agentProfiles, name);
    return { name, letter, members, q, t };
  });
  const nameW = Math.max(0, ...heads.map((h) => h.name.length));
  const rowsOf = (h) => (h.members.length ? `rows ${h.members.map((r) => r.n).join(', ')}` : 'no row');
  const rowsW = Math.max(0, ...heads.map((h) => rowsOf(h).length));
  const lines = ['ACCOUNTS'];
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
  const normal = rows.filter((r) => !r.unreachable);
  const numbered = normal.some((r) => r.n);
  const heads = [...(numbered ? ['#'] : []), 'PROFILE', 'ROLE', 'KIND', 'IN', 'ACCOUNT', 'PLAN', 'LIVE', 'SHARED WITH / WHY NOT READ'];
  const cells = normal.map((r) => [...(numbered ? [r.n ?? '–'] : []), r.profile, r.role, r.kind, r.loggedIn === null ? '?' : r.loggedIn ? 'yes' : 'NO', `${r.accountFrom === 'expected' ? `${r.account}*` : r.account}${r.letter ? ` (${r.letter})` : ''}`, r.plan ?? '–', r.live ?? '–', r.loggedIn === null ? r.note : sharedCell(r.shared)]);
  const widths = heads.slice(0, -1).map((h, i) => Math.max(h.length, ...cells.map((c) => String(c[i]).length)));
  const line = (c) => [...c.slice(0, -1).map((x, i) => pad(x, widths[i])), c.at(-1)].join('  ').trimEnd();
  const out = [line(heads), ...cells.map((c, i) => (numbered && normal[i].loggedIn === false && normal[i].n ? red(line(c)) : line(c)))];
  for (const r of rows.filter((x) => x.unreachable)) out.push(`${r.profile}  ${r.note}`);
  if (accounts?.length) out.push('', ...accounts);
  // One row for each account, not for each team: teams on one account share it.
  const quota = normal.filter((r) => (r.five_hour || r.seven_day || r.asOf) && r.account && r.account !== 'unknown').filter((r, i, all) => all.findIndex((o) => o.account === r.account) === i);
  if (quota.length) {
    const names = quota.map((r) => `account ${r.account}`);
    const qw = Math.max(7, ...names.map((n) => n.length));
    out.push('', `${pad('QUOTA', qw)}  ${pad('5H USE @RESET (UTC)', 21)}  ${pad('7D USE @RESET (UTC)', 21)}  AS OF (UTC)`);
    for (const [i, r] of quota.entries()) out.push(`${pad(names[i], qw)}  ${pad(windowCell(r.five_hour, now), 21)}  ${pad(windowCell(r.seven_day, now), 21)}  ${r.asOf ? utc(r.asOf) : '–'}`);
  }
  out.push('', 'Quota is reported for each account that has run a session, from the run logs; every other row: not reported.', '* = the expected account (a local file), not one read.');
  const out_ = normal.filter((r) => r.loggedIn !== true);
  if (out_.length) {
    out.push('', 'Not logged in or not readable:');
    for (const r of out_) out.push(`  ${r.profile}${r.note ? ` (${r.note})` : ''}`, ...(r.login ?? '').split('\n').map((l) => `    ${l}`));
  }
  const notes = normal.filter((r) => r.loggedIn === true && r.note);
  if (notes.length) out.push('', 'Notes:', ...notes.map((r) => `  ${r.profile}: ${r.note}`));
  return out.join('\n');
}

const USAGE = `usage: bin/factory [--all] [--json]
       bin/factory login <account> [--no-setup]
       bin/factory store <account>   (on the Mac mini; reads the token from stdin)
       bin/factory use [<row|repo-team> [<letter>]]   (the row's account becomes the letter's; <repo>-<team> makes a team's row, and that team's running Lead restarts when idle; on the Mac mini, by ssh from the MacBook)
       bin/factory logout <account>   (moves the account's token into the archive; on the Mac mini, by ssh from the MacBook)
       bin/factory top [--once] [--width N] [--full]
       bin/factory lead <repo> [--team <name>] [--new] [--dry-run]
       bin/factory lead <repo> [--team <name>] --here [-- <claude arguments>]   (on the MacBook: a Lead with no GitHub login of the Human's)
       bin/factory gh <gh arguments>   (on the MacBook: gh on the Mac mini, under the agents' login)
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

/** `factory lead <repo> [--team <name>] [--new] [--dry-run]` (#166, #196): starts the pstack Lead of one team of a repository. On
 * the factory host it runs this clone's packs/pstack/bin/lead; on the MacBook it runs the same command there by ssh. The name, the
 * team (the grammar of bin/lib/names.mjs) and the flags are checked before anything runs. */
function lead(all, env) {
  // What follows `--` is for claude, and only `--here` takes it.
  const dd = all.indexOf('--');
  const args = dd === -1 ? all : all.slice(0, dd);
  const passed = dd === -1 ? null : all.slice(dd + 1);
  const [repo, ...more] = args;
  const flags = [];
  let teams = 0;
  let okTeam = true;
  let team = DEFAULT_TEAM;
  for (let i = 0; i < more.length; i++) {
    if (more[i] === '--team') {
      teams += 1;
      team = more[++i] ?? '';
      okTeam = okTeam && TEAM.test(team);
    } else flags.push(more[i]);
  }
  const here = flags.includes('--here');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo ?? '') || teams > 1 || !okTeam || flags.some((f) => f !== '--new' && f !== '--dry-run' && f !== '--here') || new Set(flags).size !== flags.length || (here ? flags.length > 1 : passed !== null)) {
    console.error(USAGE);
    return 2;
  }
  if (here) return leadHere(repo, team, passed ?? [], env);
  if (placeOf(env) !== 'factory') return onHostBySsh('lead', args, true, env);
  const r = spawnSync(resolve(fileURLToPath(import.meta.url), '../../../packs/pstack/bin/lead'), args, { stdio: 'inherit', env });
  if (r.error) {
    console.error(`bin/factory: lead: ${r.error.code ?? 'error'}`);
    return 1;
  }
  return r.status ?? 1;
}

/** The agents' git name and e-mail, read on the factory host as the host's user, from its own git settings: no account is named in
 * this repository (#349). { name, email }, or null when ssh fails or either is empty. */
function hostIdentity(env) {
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

/** Where the socket of the MacBook Lead of a repository's team is recorded (#351), beside `lead-here`'s other files. */
const wakeFile = (state, repo, team) => join(state, 'lead-here', `${repo}-${team}.socket`);

/** `factory wake <repo> --issue <n> [--team <name>]` (#351): posts one line into the Lead's Claude Code inbox socket, which says to re-read
 * the issue and carries nothing else (bin/lib/wake.mjs); the message itself is a comment on the issue. On the factory host the socket is the
 * one `<runs>/<repo>-<team>/socket` records; on the MacBook it is the one `factory lead --here` recorded when the Lead of that team runs there,
 * and otherwise the same command runs on the factory host by ssh. One line is printed. Exit 0 posted, 1 not posted (the reason; the comment
 * waits on GitHub), 2 usage. */
async function wake(args, env) {
  const [repo, ...more] = args;
  let issue = null;
  let team = DEFAULT_TEAM;
  let ok = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo ?? '');
  const seen = new Set();
  for (let i = 0; i < more.length && ok; i++) {
    const flag = more[i];
    if (seen.has(flag)) ok = false;
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

/** `factory lead <repo> --here [--team <name>] [-- <claude arguments>]` (#349), on the MacBook: `claude` in this terminal and folder
 * as the Lead of the repository, with the Human's GitHub login out of its reach. Through `--settings`, whose `env` reaches every
 * command the Lead runs whatever its shell profile does to PATH: an empty GH_CONFIG_DIR and empty GH_TOKEN and GITHUB_TOKEN (gh has
 * no login here; `factory gh` runs it on the Mac mini), the agents' git identity, an emptied credential.helper list, no git password
 * prompt, a push URL that cannot be reached for GitHub's HTTPS addresses, and an ssh command that only fails (a push goes from the
 * Mac mini); `gh auth` and `security` (the Keychain) are denied. It refuses to start when the gh folder holds hosts.yml, the file a gh login writes. */
function leadHere(repo, team, passed, env) {
  if (placeOf(env) === 'factory') {
    console.error('bin/factory: lead --here runs on the MacBook; on the Mac mini use factory lead without it');
    return 2;
  }
  const id = hostIdentity(env);
  if (!id) {
    console.error("bin/factory: lead --here: could not read the factory host's git user.name and user.email; nothing was started");
    return 1;
  }
  const { state } = contextOf(env);
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
  // Two hooks record this Lead's inbox socket for `factory wake` (#351), and do nothing else.
  const record = [{ hooks: [{ type: 'command', command: [process.execPath, resolve(fileURLToPath(import.meta.url), '../socket-hook.mjs'), wakeFile(state, repo, team)].map(quote).join(' ') }] }];
  const settings = {
    hooks: { SessionStart: record, SessionEnd: record },
    env: {
      GH_CONFIG_DIR: empty, GH_TOKEN: '', GITHUB_TOKEN: '',
      GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email,
      GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND,
      GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
      ...Object.fromEntries(GIT_CONFIG.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
    },
    permissions: { deny: ['Bash(gh auth:*)', 'Bash(security:*)', 'Bash(/usr/bin/security:*)'] },
  };
  const r = spawnSync('claude', ['--name', `${repo}-${team}`, '--settings', JSON.stringify(settings), ...passed], { stdio: 'inherit', env });
  if (r.error) {
    console.error(`bin/factory: lead --here: claude did not run (${r.error.code ?? 'error'})`);
    return 1;
  }
  return r.status ?? 1;
}

// A word that starts with `=` is never bare: zsh would read it as a command's path.
const SAFE_WORD = /^[A-Za-z0-9_.,:/@%+-][A-Za-z0-9_.,:/=@%+-]*$/;

/** The reason `gh <args>` may not go to the Mac mini, or null. Refused: `gh auth` but `status`, and `gh auth status` with
 * `-t` or `--show-token`, which print a token; `--recover`; and a file given with `--body-file`, `--notes-file`, `--env-file`,
 * `--input`, `--field` or `-F` (alone or in a cluster of short flags), which names a file on this Mac and not on the Mac mini, so
 * the file must come on stdin (`-`, `@-`). */
function ghRefusal(args) {
  if (args[0] === 'auth' && args[1] !== 'status') return 'gh auth is refused here; only gh auth status runs';
  if (args[0] === 'auth' && args.slice(2).some((a) => /^--show-token(=.*)?$/s.test(a) || /^-[A-Za-z]*t[A-Za-z]*(=.*)?$/s.test(a))) return 'gh auth status -t / --show-token is refused here; it prints a token';
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
 * more for the remote login shell. On the factory host it runs gh itself. */
function ghCmd(args, env) {
  if (placeOf(env) === 'factory') {
    const r = spawnSync('gh', args, { stdio: 'inherit', env });
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

/** The line told once seat 1's account has a token: the old file moved aside, never deleted. */
function movedOld(agentProfiles, state) {
  const to = retireSeat1File(agentProfiles, state);
  return to ? `moved seat 1's old token file to ${to}` : null;
}

/** `factory top` (#174): the read-only view of every session and repository (bin/lib/top.mjs). On the factory host it runs
 * here; on the MacBook it runs the same command there by ssh, with a terminal (-t) for the live view only. Only `--once` and
 * `--full` (each at most once) and `--width N` (digits) are taken, checked before any ssh. `--once` prints one frame with no keys
 * line, and in colour only when its output is a terminal that has colours (NO_COLOR, NODE_DISABLE_COLORS and FORCE_COLOR apply). */
async function top(args, env) {
  const live = !args.includes('--once');
  const rest = args.filter((a) => a !== '--once' && a !== '--full');
  const width = rest.length === 2 && rest[0] === '--width' && /^\d+$/.test(rest[1]);
  if (['--once', '--full'].some((f) => args.filter((a) => a === f).length > 1) || (rest.length && !width)) {
    console.error(USAGE);
    return 2;
  }
  if (placeOf(env) === 'factory') {
    try {
      await (await import('./top.mjs')).main(args);
      return 0;
    } catch (e) {
      console.error(`bin/factory: top: ${String(e.message).split('\n')[0]}`);
      return 1;
    }
  }
  return onHostBySsh('top', args, live, env);
}

/** `factory login <account>`: checks the name, runs `claude setup-token` on the terminal's own streams (so what it prints goes to
 * the Human's screen and is never captured), reads the token from a hidden prompt, then stores it: here on the Mac mini, else by
 * ssh to `factory store` there, the token on ssh's stdin and in no argument. */
async function login(args, env) {
  const words = args.filter((a) => a !== '--no-setup');
  if (words.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const [account] = words;
  const refused = accountRefusal(account);
  if (refused) {
    console.error(`bin/factory: ${refused}`);
    return 2;
  }
  if (!args.includes('--no-setup')) {
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
  if (placeOf(env) === 'factory') {
    const { agentProfiles, state } = contextOf(env);
    let moved;
    try {
      writeToken(agentProfiles, account, t.token);
      moved = movedOld(agentProfiles, state);
    } catch (e) {
      console.error(`bin/factory: ${e.message}`);
      return 1;
    }
    console.log(`stored the token of ${account} in ${join(tokenDir(agentProfiles), account)}`);
    if (moved) console.log(moved);
    return 0;
  }
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `factory@${HOST}`, `zsh -lc '~/WORKSPACES/bin/factory store ${account}'`], { input: `${t.token}\n`, encoding: 'utf8', env, timeout: 60000, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT' || r.status !== 0) {
    const why = r.error?.code === 'ETIMEDOUT' ? 'timed out' : lastLine(`${r.stderr ?? ''}${r.stdout ?? ''}`);
    console.error(`bin/factory: the token was not stored on the Mac mini: ${why.split(t.token).join('[token]')}`);
    return 1;
  }
  console.log(`stored the token of ${account} on the Mac mini`);
  return 0;
}

/** `factory store <account>`, on the Mac mini: one token from stdin, never from a terminal, written to the store. */
async function store(args, env) {
  if (args.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  const refused = accountRefusal(args[0]);
  if (refused) {
    console.error(`bin/factory: ${refused}`);
    return 2;
  }
  if (placeOf(env) !== 'factory') {
    console.error('bin/factory: store runs on the Mac mini, the factory host, as the factory user');
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
    writeToken(agentProfiles, args[0], t.token);
    moved = movedOld(agentProfiles, state);
  } catch (e) {
    console.error(`bin/factory: ${e.message}`);
    return 1;
  }
  console.log(`stored the token of ${args[0]}`);
  if (moved) console.log(moved);
  return 0;
}

/** How long ssh may run for a command: none for `use`, whose restart waits up to ten minutes for a busy Lead (`ConnectTimeout`
 * already covers a Mac mini that cannot be reached); 60 seconds for every other. */
export const remoteTimeout = (cmd) => (cmd === 'use' ? undefined : 60000);

/** `use` and `logout` from the MacBook run on the Mac mini, as `login` does: the arguments are checked here first (a row is a number,
 * a letter is a to z, an account matches the account pattern), then the host runs the command in a login shell over ssh, on the
 * terminal's own streams. With an argument of `use` missing, ssh gets -t so the host's list and its question reach the Human. */
function remote(cmd, args, env) {
  const bad = cmd === 'wake'
    ? null // checked by wake() before it comes here
    : cmd === 'use'
    ? (args.length > 2 ? 'use takes a row and a letter' : args[0] !== undefined && !/^[1-9][0-9]*$/.test(args[0]) && !parseTeam(args[0]) ? 'the row is a number or <repo>-<team>' : args[1] !== undefined && !/^[a-z]+$/.test(args[1]) ? 'the account is a letter, a to z' : null)
    : (args.length === 1 ? accountRefusal(args[0]) : 'logout takes one account');
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
  return { rows, text: existsSync(seat1File(ctx.agentProfiles)) ? `${text}\n\nseats/1/oauth-token (seat 1's old token file) is still there; it moves aside, never deleted, at the next factory login or factory use once seat 1's account has a token.` : text };
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
  const flag = team === DEFAULT_TEAM ? '' : ` --team ${team}`;
  // `factory top`'s rule: a claude process with --name <repo>-<team>. A recorded pane may hold something else by now.
  if (!leadTeams(repo).includes(team)) {
    console.log(`the Lead of ${repo} (team ${team}) is not running; it takes ${account} at its next start${startNote(repo, flag)}`);
    if (!hasToken) console.log(`${account} has no token file yet: that next start is refused until factory login ${account}`);
    return 0;
  }
  if (!hasToken) {
    console.log(`${account} has no token file yet: factory login ${account}; the Lead keeps running and was not restarted, and its next start is refused until then`);
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
  const flag = team === DEFAULT_TEAM ? '' : ` --team ${team}`;
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

/** `factory use <row> <letter>`: the row's account in the accounts file becomes the letter's. The verifier's row is read-only; a
 * team's next seat session takes its new account and nothing else running is touched; the row also restarts that team's Lead alone,
 * if it runs (#179, #311). The row is a number, or `<repo>-<team>` for an onboarded repository or the factory, which makes the row when the file has none. */
async function use(args, env, io) {
  if (placeOf(env) !== 'factory') return remote('use', args, env);
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
  console.log(`${target.profile} now uses ${account.name} (${account.letter}); its next seat session takes it, and nothing else running is touched.`);
  if (moved) console.log(moved);
  const t = parseTeam(target.profile.slice('factory/'.length));
  return t ? restartLead(t.repo, t.team, account.name, ctx, oldAccount) : 0;
}

/** `factory logout <account>`: the account's token file moves into archive/tokens, never deleted. The rows that name it stay in the
 * accounts file and start nothing until `factory login <account>` or `factory use` gives them another. */
function logout(args, env) {
  if (placeOf(env) !== 'factory') return remote('logout', args, env);
  const refused = args.length === 1 ? accountRefusal(args[0]) : 'logout takes one account';
  if (refused) {
    console.error(`bin/factory: ${refused}\n${USAGE}`);
    return 2;
  }
  const { agentProfiles } = contextOf(env);
  try {
    const to = archiveToken(agentProfiles, args[0]);
    console.log(`moved the token of ${args[0]} to ${to}; every row that names it starts nothing until factory login ${args[0]} or factory use`);
  } catch (e) {
    console.error(`bin/factory: ${e.message}`);
    return 1;
  }
  return 0;
}

export async function main(argv, env = process.env, io = { isTTY: Boolean(process.stdin.isTTY), ask: defaultAsk }) {
  const [cmd, ...rest] = argv;
  if (cmd === 'login') return login(rest, env);
  if (cmd === 'store') return store(rest, env);
  if (cmd === 'use') return use(rest, env, io);
  if (cmd === 'logout') return logout(rest, env);
  if (cmd === 'top') return top(rest, env);
  if (cmd === 'lead') return lead(rest, env);
  if (cmd === 'gh') return ghCmd(rest, env);
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
  if (all) rows.push(...readFactory(ctx), ...readPiggery(ctx));
  finish(rows, expectedAccounts(env, ctx.state));
  console.log(argv.includes('--json') ? JSON.stringify(rows) : tableText(rows));
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
