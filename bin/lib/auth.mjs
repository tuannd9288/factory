// bin/factory-auth (#173): every agent profile's login, account and quota in one table. It runs only the vendors' own status
// commands (claude auth status, codex login status, gh auth status), reads quota through quotaRows() and liveCount(), and keeps
// from each answer only the logged-in flag, the local part of the account and the plan. It never logs in, reads a token or
// changes a profile. The committed profile list below holds no account name: the factory repository is public, and an
// account is an email local part. The account a profile is expected to have is in $FACTORY_STATE/accounts, local to a machine.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { accountsOf, quotaRows } from './quota.mjs';
import { liveCount } from './seat.mjs';

const HOST = 'tuans-mac-mini';
const KINDS = { claude: 'Claude', codex: 'Codex', gh: 'gh' };

const claude = (profile, role, env, login) => ({ profile, role, kind: 'claude', check: { cmd: 'claude', args: ['auth', 'status'], env }, login });

/** The profiles of a place, from the committed list. leads: the repository folders that hold .gate/ and .envrc. */
export function profilesOf(place, { home, agentProfiles, root }) {
  if (place === 'macbook') {
    return [
      claude('macbook/claude', 'Colly', {}, 'claude auth login'),
      ...[2, 3, 4, 5].map((n) => claude(`macbook/claude-acc${n}`, 'spare Claude', { CLAUDE_CONFIG_DIR: join(home, `.claude-acc${n}`) }, `claude-use login ${n}`)),
      { profile: 'macbook/codex', role: 'Colly Codex', kind: 'codex', check: { cmd: 'codex', args: ['login', 'status'], env: {} }, login: 'codex-use login <N>' },
      { profile: 'macbook/gh', role: 'Colly gh', kind: 'gh', check: { cmd: 'gh', args: ['auth', 'status'], env: {} }, login: 'gh auth login' },
    ];
  }
  if (place === 'factory') {
    const seat2 = join(agentProfiles, 'seats/2/claude');
    const leads = (existsSync(root) ? readdirSync(root).sort() : [])
      .filter((n) => !n.startsWith('.') && existsSync(join(root, n, '.gate')) && existsSync(join(root, n, '.envrc')))
      .map((n) => ({ profile: `factory/lead-${n}`, role: 'Lead', kind: 'claude', check: { cmd: 'direnv', args: ['exec', '.', 'claude', 'auth', 'status'], env: {}, cwd: join(root, n) }, login: leadLogin(n) }));
    return [
      { profile: 'factory/seat-1', role: 'seat 1 (bin/seat)', kind: 'claude', tokenFile: join(agentProfiles, 'seats/1/oauth-token'), login: 'claude setup-token (on the MacBook), then omk-provider-key set CLAUDE_CODE_OAUTH_TOKEN, then copy it to ~/.agent-profiles/seats/1/oauth-token with mode 600 (#91)' },
      claude('factory/seat-2', 'seat 2 (bin/seat)', { CLAUDE_CONFIG_DIR: seat2 }, `ssh -t factory@${HOST}\nCLAUDE_CONFIG_DIR=~/.agent-profiles/seats/2/claude claude auth login`),
      ...leads,
      { profile: 'factory/verifier', role: 'live verifier', kind: 'codex', check: { cmd: 'codex', args: ['login', 'status'], env: { CODEX_HOME: join(agentProfiles, 'verifier/codex') } }, login: 'CODEX_HOME=~/.agent-profiles/verifier/codex codex login --device-auth' },
      { profile: 'factory/gh', role: 'agents gh', kind: 'gh', check: { cmd: 'gh', args: ['auth', 'status'], env: {} }, login: 'gh auth login --insecure-storage' },
    ];
  }
  return [
    { profile: 'piggery/claude', role: 'piggery teams', kind: 'claude', check: { cmd: 'pig', args: ['claude', 'auth', 'status'], env: {} }, login: `ssh -t tuannguyen@${HOST}\npig claude auth login` },
    { profile: 'piggery/codex', role: 'piggery teams', kind: 'codex', check: { cmd: 'pig', args: ['codex', 'login', 'status'], env: {} }, login: `ssh -t tuannguyen@${HOST}\npig codex login --device-auth` },
  ];
}

const leadLogin = (repo) => `cd ~/WORKSPACES/${repo} && direnv exec . claude auth login`;


const timeoutMs = (env) => Number(env.FACTORY_AUTH_TIMEOUT_MS) || 15000;

/** One vendor command with a time limit. { code, out, error } where error is 'timed out' or the spawn error's code. */
function call(cmd, args, { extra = {}, cwd, env, timeout }) {
  const childEnv = { ...env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN']) delete childEnv[k];
  const r = spawnSync(cmd, args, { cwd, env: { ...childEnv, ...extra }, encoding: 'utf8', timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  const error = r.error ? (r.error.code === 'ETIMEDOUT' ? 'timed out' : `${cmd}: ${r.error.code ?? 'failed'}`) : null;
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error };
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

/** The profile's login state by its own vendor command: { loggedIn: true|false|null, account, plan, note }. */
function check(p, ctx) {
  if (p.tokenFile) {
    let s;
    try {
      s = statSync(p.tokenFile);
    } catch {
      return { loggedIn: false, account: null, plan: null, note: 'no token file' };
    }
    const mode = (s.mode & 0o777).toString(8);
    return { loggedIn: true, account: null, plan: null, note: `token file, mode ${mode}${mode === '600' ? '' : ' (should be 600)'}, modified ${s.mtime.toISOString().slice(0, 10)}` };
  }
  const r = call(p.check.cmd, p.check.args, { extra: p.check.env, cwd: p.check.cwd, env: ctx.env, timeout: ctx.timeout });
  if (r.error) return { loggedIn: null, account: null, plan: null, note: r.error };
  if (p.kind === 'codex') return { loggedIn: r.code === 0, account: null, plan: null, note: '' };
  const read = p.kind === 'gh' ? readGh(r.out) : readClaude(r.out);
  return read ? { ...read, note: '' } : { loggedIn: null, account: null, plan: null, note: `${p.check.cmd} printed nothing readable` };
}

/** The expected account of each profile: $FACTORY_STATE/accounts ("<profile>=<name>" a line), then FACTORY_SEAT_ACCOUNTS for the seats. */
export function expectedAccounts(env, state) {
  const out = {};
  for (const [n, name] of Object.entries(accountsOf(env.FACTORY_SEAT_ACCOUNTS))) out[`factory/seat-${n}`] = name;
  let text = '';
  try {
    text = readFileSync(join(state, 'accounts'), 'utf8');
  } catch {
    // no file: every account not read is unknown
  }
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#') && line.slice(i + 1).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function contextOf(env = process.env) {
  const home = env.HOME;
  return {
    env,
    home,
    state: env.FACTORY_STATE ?? join(home, '.local/state/factory'),
    agentProfiles: env.AGENT_PROFILES ?? join(home, '.agent-profiles'),
    root: resolve(env.FACTORY_ROOT ?? join(home, 'WORKSPACES')),
    runs: resolve(env.FACTORY_RUNS ?? join(home, 'factory-runs')),
    timeout: timeoutMs(env),
  };
}

export const placeOf = (env = process.env) => ((env.FACTORY_AUTH_USER ?? userInfo().username) === 'factory' ? 'factory' : 'macbook');

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
  return profilesOf(place, ctx).map((p) => {
    const c = check(p, ctx);
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
    return {
      place, profile: p.profile, role: p.role, kind: KINDS[p.kind], loggedIn: c.loggedIn, account: c.account, accountFrom: c.account ? 'read' : null, plan: c.plan,
      five_hour: win(q?.windows?.five_hour), seven_day: win(q?.windows?.seven_day), asOf: q?.asOf ?? null, live, shared: [], login: p.login, note: c.note,
    };
  });
}

/** Rows of piggery's two profiles through pig on the Mac mini, by ssh. */
export function readPiggery(ctx) {
  const ssh = (cmd) => call('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `tuannguyen@${HOST}`, `zsh -lc '${cmd}'`], { env: ctx.env, timeout: ctx.timeout * 4 });
  const probes = profilesOf('piggery', ctx).map((p) => ({ p, r: ssh(`${p.check.cmd} ${p.check.args.join(' ')}`) }));
  const down = probes.find(({ r }) => r.code === 255 || r.error);
  if (down) return [unreachable('piggery', down.r)];
  return probes.map(({ p, r }) => {
    const read = p.kind === 'codex' ? { loggedIn: r.code === 0, account: null, plan: null } : readClaude(r.out);
    return blank('piggery', p, read ?? { loggedIn: null, account: null, plan: null }, read ? '' : 'pig printed nothing readable');
  });
}

const lastLine = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'no answer';

const unreachable = (place, r) => ({ place, profile: `${place} (unreachable)`, role: '', kind: '', loggedIn: null, account: null, accountFrom: null, plan: null, five_hour: null, seven_day: null, asOf: null, live: null, shared: [], login: null, note: r.error ?? lastLine(r.out), unreachable: true });

function blank(place, p, read, note) {
  return { place, profile: p.profile, role: p.role, kind: KINDS[p.kind], loggedIn: read.loggedIn, account: read.account, accountFrom: read.account ? 'read' : null, plan: read.plan, five_hour: null, seven_day: null, asOf: null, live: null, shared: [], login: p.login, note };
}

/** The factory rows from the Mac mini: its own `status --json`, run in a login shell over ssh. */
export function readFactory(ctx) {
  const r = call('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `factory@${HOST}`, "zsh -lc '~/WORKSPACES/bin/factory-auth status --json'"], { env: ctx.env, timeout: ctx.timeout * 4 });
  if (r.error || r.code !== 0) return [unreachable('factory', r)];
  try {
    const rows = JSON.parse(r.out.split('\n').reverse().find((l) => l.startsWith('[')));
    if (!Array.isArray(rows)) throw new Error('not a list');
    const s = (v) => (typeof v === 'string' ? v : null);
    const n = (v) => (typeof v === 'number' ? v : null);
    const w = (v) => (v && n(v.use) !== null ? { use: v.use, resetsAt: n(v.resetsAt) } : null);
    return rows.map((x) => ({
      place: 'factory', profile: s(x.profile) ?? '?', role: s(x.role) ?? '', kind: s(x.kind) ?? '', loggedIn: typeof x.loggedIn === 'boolean' ? x.loggedIn : null,
      account: s(x.account) && x.accountFrom === 'read' ? x.account : null, accountFrom: x.accountFrom === 'read' ? 'read' : null, plan: s(x.plan),
      five_hour: w(x.five_hour), seven_day: w(x.seven_day), asOf: n(x.asOf), live: n(x.live), shared: [], login: s(x.login), note: s(x.note) ?? '',
      ...(x.accountFrom === 'expected' && s(x.account) ? { expectedRemote: x.account } : {}),
    }));
  } catch {
    return [unreachable('factory', { out: 'ssh answered, but not with factory-auth status --json' })];
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

/** The text of the table: the profiles, then the quota of the rows that have one, then what to do and what to know. */
export function tableText(rows, { now = Date.now() } = {}) {
  const normal = rows.filter((r) => !r.unreachable);
  const heads = ['PROFILE', 'ROLE', 'KIND', 'IN', 'ACCOUNT', 'PLAN', 'LIVE', 'SHARED WITH / WHY NOT READ'];
  const cells = normal.map((r) => [r.profile, r.role, r.kind, r.loggedIn === null ? '?' : r.loggedIn ? 'yes' : 'NO', r.accountFrom === 'expected' ? `${r.account}*` : r.account, r.plan ?? '–', r.live ?? '–', r.loggedIn === null ? r.note : r.shared.join(', ') || '–']);
  const widths = heads.slice(0, -1).map((h, i) => Math.max(h.length, ...cells.map((c) => String(c[i]).length)));
  const line = (c) => [...c.slice(0, -1).map((x, i) => pad(x, widths[i])), c.at(-1)].join('  ').trimEnd();
  const out = [line(heads), ...cells.map(line)];
  for (const r of rows.filter((x) => x.unreachable)) out.push(`${r.profile}  ${r.note}`);
  const quota = normal.filter((r) => r.five_hour || r.seven_day || r.asOf);
  if (quota.length) {
    const qw = Math.max(7, ...quota.map((r) => r.profile.length));
    out.push('', `${pad('QUOTA', qw)}  ${pad('5H USE @RESET (UTC)', 21)}  ${pad('7D USE @RESET (UTC)', 21)}  AS OF (UTC)`);
    for (const r of quota) out.push(`${pad(r.profile, qw)}  ${pad(windowCell(r.five_hour, now), 21)}  ${pad(windowCell(r.seven_day, now), 21)}  ${r.asOf ? utc(r.asOf) : '–'}`);
  }
  out.push('', 'Quota is reported for the seats only, from their run logs; every other row: not reported. * = the expected account (a local file), not one read.');
  const out_ = normal.filter((r) => r.loggedIn !== true);
  if (out_.length) {
    out.push('', 'Not logged in or not readable:');
    for (const r of out_) out.push(`  ${r.profile}${r.note ? ` (${r.note})` : ''}`, ...(r.login ?? '').split('\n').map((l) => `    ${l}`));
  }
  const notes = normal.filter((r) => r.loggedIn === true && r.note);
  if (notes.length) out.push('', 'Notes:', ...notes.map((r) => `  ${r.profile}: ${r.note}`));
  return out.join('\n');
}

const USAGE = 'usage: bin/factory-auth status [--all] [--json]';

export function main(argv, env = process.env) {
  const ctx = contextOf(env);
  const [cmd, ...rest] = argv;
  if (cmd !== 'status' || rest.some((a) => a !== '--all' && a !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const place = placeOf(env);
  const all = rest.includes('--all');
  if (all && place !== 'macbook') {
    console.error('bin/factory-auth: --all runs on the MacBook');
    return 2;
  }
  const rows = readPlace(place, ctx);
  if (all) rows.push(...readFactory(ctx), ...readPiggery(ctx));
  finish(rows, expectedAccounts(env, ctx.state));
  console.log(rest.includes('--json') ? JSON.stringify(rows) : tableText(rows));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
