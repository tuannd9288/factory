// bin/factory (#173, #177, #178): the list of every agent profile in a table with the seats' quota in a second one, and `login`,
// `store`, `use` and `logout`. On the Mac mini the rows are numbered (seat 1, seat 2, each Lead the accounts file names, the
// verifier) and the accounts lettered; `use` rewrites the accounts file and `logout` moves a token into the archive; `login` and
// `store` put a token in the factory's token store. The list runs only the vendors' own status commands (codex login status,
// gh auth status; on the MacBook claude auth status too), reads quota through quotaRows() and liveCount(), and keeps from each answer
// only the logged-in flag, the local part of the account and the plan. It reads no token (a token file shows its mode and date).
// The committed profile list below holds no account name: the factory repository is public, and an account is an email local
// part. On the Mac mini the account of a row is in $FACTORY_STATE/accounts, local to a machine, the one source of it.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quotaRows } from './quota.mjs';
import { liveCount } from './seat.mjs';
import { accountRefusal, archiveToken, readAccounts, readSecret, retireSeat1File, seat1File, setAccount, tokenAccounts, tokenDir, tokenOf, writeToken } from './token.mjs';

const HOST = 'tuans-mac-mini';
const KINDS = { claude: 'Claude', codex: 'Codex', gh: 'gh' };

const claude = (profile, role, env, login) => ({ profile, role, kind: 'claude', check: { cmd: 'claude', args: ['auth', 'status'], env }, login });

/** The profiles of a place, from the committed list. On the Mac mini the Lead rows are the ones the accounts file names. A row with
 * `byFile` has its account from that file, and its login state is the token file of that account. */
export function profilesOf(place, { home, agentProfiles, state }) {
  if (place === 'macbook') {
    return [
      claude('macbook/claude', 'Colly', {}, 'claude auth login'),
      ...[2, 3, 4, 5].map((n) => claude(`macbook/claude-acc${n}`, 'spare Claude', { CLAUDE_CONFIG_DIR: join(home, `.claude-acc${n}`) }, `claude-use login ${n}`)),
      { profile: 'macbook/codex', role: 'Colly Codex', kind: 'codex', check: { cmd: 'codex', args: ['login', 'status'], env: {} }, login: 'codex-use login <N>' },
      { profile: 'macbook/gh', role: 'Colly gh', kind: 'gh', check: { cmd: 'gh', args: ['auth', 'status'], env: {} }, login: 'gh auth login' },
    ];
  }
  if (place === 'factory') {
    const byFile = (profile, role) => ({ profile, role, kind: 'claude', byFile: true, numbered: true });
    // No folder scan and no direnv (#205): a Lead is a row because the file names it.
    const leads = Object.keys(readAccounts(state)).filter((p) => /^factory\/lead-.+/.test(p)).sort();
    return [
      byFile('factory/seat-1', 'seat 1 (bin/seat)'),
      byFile('factory/seat-2', 'seat 2 (bin/seat)'),
      ...leads.map((p) => byFile(p, `Lead of ${p.slice('factory/lead-'.length)}`)),
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
    state: env.FACTORY_STATE ?? join(home, '.local/state/factory'),
    agentProfiles: env.AGENT_PROFILES ?? join(home, '.agent-profiles'),
    runs: resolve(env.FACTORY_RUNS ?? join(home, 'factory-runs')),
    timeout: timeoutMs(env),
  };
}

/** The factory host is where the command runs as the host's user: FACTORY_HOST_USER, `factory` unless the setting names another. */
export const placeOf = (env = process.env) => (userInfo().username === (env.FACTORY_HOST_USER || 'factory') ? 'factory' : 'macbook');

const win = (w) => (w ? { use: w.use, resetsAt: w.resetsAt } : null);

/** The rows of one place: the profile list read through the vendors' commands. Quota and live sessions only for the seats. */
export function readPlace(place, ctx) {
  let quota = [];
  if (place === 'factory') {
    try {
      quota = quotaRows({ runs: ctx.runs });
    } catch {
      quota = [];
    }
  }
  const accounts = place === 'factory' ? readAccounts(ctx.state) : {};
  const letters = place === 'factory' ? new Map(accountList(ctx).map((a) => [a.name, a.letter])) : new Map();
  let numbered = 0;
  return profilesOf(place, ctx).map((p) => {
    const c = check(p, { ...ctx, accounts });
    const n = p.numbered ? (numbered += 1) : null;
    const seat = /^factory\/seat-(\d)$/.exec(p.profile)?.[1];
    const q = seat ? quota.find((x) => x.seat === Number(seat)) : null;
    let live = null;
    if (seat) {
      try {
        live = liveCount(ctx.runs, seat);
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

const letterOf = (i) => (i >= 26 ? letterOf(Math.floor(i / 26) - 1) : '') + String.fromCharCode(97 + (i % 26));

/** The lettered accounts, sorted: every account the accounts file names, and every token file's name. Names come from the file and
 * from readdir; no token file is read. */
export function accountList({ state, agentProfiles }) {
  const names = [...new Set([...Object.values(readAccounts(state)), ...tokenAccounts(agentProfiles)])].sort();
  return names.map((name, i) => ({ name, letter: letterOf(i) }));
}

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
 * rows that name it. The quota is the newest a seat of that account reported; "?" where none did. */
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
  const quota = normal.filter((r) => r.five_hour || r.seven_day || r.asOf);
  if (quota.length) {
    const qw = Math.max(7, ...quota.map((r) => r.profile.length));
    out.push('', `${pad('QUOTA', qw)}  ${pad('5H USE @RESET (UTC)', 21)}  ${pad('7D USE @RESET (UTC)', 21)}  AS OF (UTC)`);
    for (const r of quota) out.push(`${pad(r.profile, qw)}  ${pad(windowCell(r.five_hour, now), 21)}  ${pad(windowCell(r.seven_day, now), 21)}  ${r.asOf ? utc(r.asOf) : '–'}`);
  }
  out.push('', 'Quota is reported for the seats only, from their run logs; every other row: not reported.', '* = the expected account (a local file), not one read.');
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
       bin/factory use [<row> [<letter>]]   (on the Mac mini; the row's account becomes the letter's)
       bin/factory logout <account>   (on the Mac mini; moves the account's token into the archive)`;

/** The line told once seat 1's account has a token: the old file moved aside, never deleted. */
function movedOld(agentProfiles, state) {
  const to = retireSeat1File(agentProfiles, state);
  return to ? `moved seat 1's old token file to ${to}` : null;
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

/** `factory use <row> <letter>`: the row's account in the accounts file becomes the letter's. The verifier's row is read-only and a
 * Lead's waits for #179, which restarts the Lead; a seat takes its new account at its next session and nothing running is touched. */
async function use(args, env, io) {
  if (placeOf(env) !== 'factory') {
    console.error('bin/factory: use runs on the Mac mini, the factory host, as the factory user');
    return 2;
  }
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
  const target = /^[1-9][0-9]*$/.test(row) ? rows.find((r) => r.n === Number(row)) : null;
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
  if (!/^factory\/seat-[12]$/.test(target.profile)) {
    console.error(`bin/factory: ${target.profile} is a Lead's row; moving it restarts the Lead, which comes with #179. Nothing was changed.`);
    return 2;
  }
  let moved;
  try {
    setAccount(ctx.state, target.profile, account.name);
    moved = movedOld(ctx.agentProfiles, ctx.state);
  } catch (e) {
    console.error(`bin/factory: ${e.message}`);
    return 1;
  }
  console.log(`${target.profile.replace('factory/seat-', 'seat ')} now uses ${account.name} (${account.letter}); it takes effect at its next session, and nothing running is touched.`);
  if (!tokenState(ctx.agentProfiles, account.name).ok) console.log(`${account.name} has no token file yet: factory login ${account.name}`);
  if (moved) console.log(moved);
  return 0;
}

/** `factory logout <account>`: the account's token file moves into archive/tokens, never deleted. The rows that name it stay in the
 * accounts file and start nothing until `factory login <account>` or `factory use` gives them another. */
function logout(args, env) {
  if (placeOf(env) !== 'factory') {
    console.error('bin/factory: logout runs on the Mac mini, the factory host, as the factory user');
    return 2;
  }
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
  if (argv.some((a) => a !== '--all' && a !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const ctx = contextOf(env);
  const place = placeOf(env);
  const all = argv.includes('--all');
  if (all && place !== 'macbook') {
    console.error('bin/factory: --all runs on the MacBook');
    return 2;
  }
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
