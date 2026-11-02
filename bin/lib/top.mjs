// `factory top` (#174): one terminal view of every session the factory runs and the state of every repository it works on,
// repo -> issue -> session, modelled on `piggery top`. It changes nothing and keeps no store: it reads the run folders'
// stream-json logs and pid files, bin/seat's sessions.jsonl, the state folder's queue and *.failed files, the claim refs,
// and gh porcelain (never `gh api`). A field the data does not give is shown as `?`.
// #286: what waits on the Human first, one block per repository (the Lead of each team in it), the accounts (factory.mjs's list, each account's quota) and Today.
// It runs as `factory top [--once] [--width N] [--full]` (bin/lib/factory.mjs); `node bin/lib/top.mjs --once` prints one frame as well.
// `c` (or --full) adds #174's engineering columns. Layout (#174): what waits on the Human first, then each repository by team (the Lead's
// row, its issues, the sessions under each), then the accounts and Today; a state is a mark and a word, with basic SGR colour on a
// terminal that has it (`render`'s `color` option; `main` reads it from the terminal once); a row too wide drops whole columns (S_STEPS).
// What waits on the Human comes first (pull requests to approve, a Lead at a prompt or a login, alerts), then one block per
// repository with the Lead of each team, issues and workers, the accounts with local reset times, and Today; it is live on a
// terminal; on the MacBook it runs on the Mac mini by ssh. Every session has an animal name from Ubuntu's release code names (bin/lib/names.mjs): bin/seat writes
// run-<tag>.name, a Lead keeps ~/factory-runs/<repo>-<team>/name and its Herdr pane carries it. A Lead's state is its newest hook
// event in <repo>-<team>/state.json (packs/pstack/bin/transcript-copy.mjs).
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stateOf as claimStateOf } from '../../kit/.gate/bin/lib/claim.mjs';
import { REQUIRED, clonesUnder, costOf, lastRecords as lastOfSession, readSessions } from './ledger.mjs';
import { quotaRows, windowsOf } from './quota.mjs';
import { PRESETS, SEATS, liveCount, resetPassed, runLive } from './seat.mjs';
import { TEAM, parseTeam } from './names.mjs';
import { accountList, seatAccounts } from './token.mjs';
import { teamRows } from './teams.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const LOCAL_MS = 2000;
const GH_MS = 60_000;
const CALL_MS = 15_000;
const WORKING_MS = 120_000;
const GONE_MS = 24 * 3600_000;
const LOGIN_MS = 60_000;
const DONE_MAX = 40;
const ROLE_ORDER = ['lead', 'worker', 'reviewer', 'researcher'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What one stream-json log (or a Lead's transcript copy) says, from its events alone; null where it says nothing. Tokens
 * add each assistant message once (by id): `tokensIn` is input, cache-creation and cache-read tokens, `tokensOut` output;
 * `ctx` is the last message's input side. A resumed log holds several results: turns add up, the cost is the last total. */
export function parseLog(text) {
  const messages = new Map();
  const results = [];
  let init = null;
  let rate = null;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e?.type === 'system' && e.subtype === 'init') init = e;
    else if (e?.type === 'assistant' && e.message?.usage) messages.set(e.message.id ?? e.uuid ?? messages.size, e.message);
    else if (e?.type === 'result') results.push(e);
    else if (e?.type === 'rate_limit_event' && e.rate_limit_info) rate = e.rate_limit_info;
  }
  const usages = [...messages.values()];
  const side = (u) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const last = results.at(-1) ?? null;
  // A <synthetic> message (Claude Code's own, with no usage) says nothing of the model, the context or the price.
  const real = usages.filter((m) => m.model !== '<synthetic>');
  const priced = real.map((m) => costOf(m.model, m.usage));
  const turnSum = results.some((r) => num(r.num_turns) !== null) ? results.reduce((s, r) => s + (num(r.num_turns) ?? 0), 0) : null;
  return {
    model: init?.model ?? real.at(-1)?.model ?? null,
    cwd: init?.cwd ?? null,
    turns: turnSum ?? (usages.length ? usages.length : null),
    ctx: real.length ? side(real.at(-1).usage) : null,
    tokensIn: usages.length ? usages.reduce((s, m) => s + side(m.usage), 0) : null,
    tokensOut: usages.length ? usages.reduce((s, m) => s + (m.usage.output_tokens ?? 0), 0) : null,
    cost: num(last?.total_cost_usd),
    estCost: real.length && priced.every((c) => c !== null) ? priced.reduce((s, c) => s + c, 0) : null,
    isError: typeof last?.is_error === 'boolean' ? last.is_error : null,
    apiStatus: last?.api_error_status ?? null,
    rate: rate ? { ...windowsOf(rate), resetsAt: num(rate.resetsAt) } : null,
  };
}

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** The role of a run: its record's, else the tag's (build/fix a worker, review a reviewer, research a researcher, or a
 * preset's own name), else `?`. */
export function roleOf(tag, record) {
  if (record?.role) return record.role;
  if (Object.hasOwn(PRESETS, tag)) return tag;
  const t = tag.replace(/^BRIEF-/i, '');
  if (/^(build|fix)/i.test(t)) return 'worker';
  if (/review/i.test(t)) return 'reviewer';
  if (/^research/i.test(t)) return 'researcher';
  return '?';
}

/** owner/name of a work folder's origin, read with git alone; null where git cannot tell. */
function originIn(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** ps's elapsed time ([[dd-]hh:]mm:ss) in milliseconds; null for anything else. */
export function etimeMs(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text ?? '');
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000 : null;
}

/** The processes as { pid, ageMs, command }, from ps; [] when ps cannot run. */
function psList() {
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    if (!existsSync(ps)) continue;
    try {
      return execFileSync(ps, ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .flatMap((l) => {
          const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l);
          return m ? [{ pid: Number(m[1]), ageMs: etimeMs(m[2]), command: m[3] }] : [];
        });
    } catch {
      return [];
    }
  }
  return [];
}

/** The repository and team a process is the Lead of, or null: a `claude` command with `--name <repo>-<team>` (packs/pstack/bin/lead),
 * split at the last `-`, the team in the grammar (#196). */
export function leadOf(command) {
  const m = /(?:^|\s)--name\s+(\S+)-([^-\s]+)(?:\s|$)/.exec(command);
  return m && TEAM.test(m[2]) && /\bclaude\b/.test(command) ? { repo: m[1], team: m[2] } : null;
}

/** The teams whose Lead runs on a repository, sorted. */
export const leadTeams = (repo, processes = psList) => [...new Set(processes().map((p) => leadOf(p.command)).filter((l) => l?.repo === repo).map((l) => l.team))].sort();

/** Whether a Lead of a repository runs: the one rule `top` and `factory use` share (#179). */
export const leadRunning = (repo, processes = psList) => leadTeams(repo, processes).length > 0;

function branchIn(cwd) {
  if (!cwd) return null;
  try {
    const b = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

/** The repository whose clone holds cwd, or null. */
function repoOfCwd(cwd, clones) {
  if (!cwd) return null;
  for (const [repo, dir] of clones) if (cwd === dir || cwd.startsWith(dir + sep)) return repo;
  return null;
}

const lastRecords = (records) => {
  const last = new Map();
  for (const r of [...records].sort((a, b) => Date.parse(a.end) - Date.parse(b.end))) last.set(`${r.run}#${r.tag}`, r);
  return last;
};

/** Where a session stands, from facts: a live pid with a log written lately is working, else idle; one the limit cut off is
 * stopped (the last rate_limit_event rejected and not yet reset, or a 429 result); an error result is failed; a result without
 * one done; a session with no process and no result, or one that ended over a day ago, is gone. */
function stateOf(p, { live, ageMs, record, now }) {
  if (live) return { state: ageMs < WORKING_MS ? 'working' : 'idle' };
  let state = 'gone';
  if (p.isError === true) state = 'failed';
  else if (p.isError === false) state = 'done';
  else if (record) state = record.error || record.ended === 'no-result' || String(record.ended).startsWith('error') ? 'failed' : 'done';
  if (state === 'gone') return { state };
  const w = p.rate;
  const resets = w ? (w[w.type]?.resetsAt ?? w.resetsAt) : null;
  if (p.isError === true && ((w?.rejected && resets != null && !resetPassed(resets, now)) || p.apiStatus === 429)) {
    return { state: 'stopped', until: resets != null ? resets * 1000 : null };
  }
  return ageMs > GONE_MS ? { state: 'gone' } : { state };
}

const pad2 = (n) => String(n).padStart(2, '0');
const startOfDay = (ms) => new Date(ms).setHours(0, 0, 0, 0);
const hm = (ms) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;

/** Whether a session is listed in a frame: it is not gone, and it is live or last wrote on the local day that starts at `day`. */
const isListed = (s, day) => s.state !== 'gone' && (s.live || s.lastAt >= day);

/** When an issue is listed while open, with `busy` for a claim or an open pull request: `active` on All, where a session counts only
 * if it is listed today; `recent` on a repository's tab, where #174's rule holds and a session of the last 24 hours counts. */
const shownOf = (sessions, day, busy) => ({ active: busy || sessions.some((s) => isListed(s, day)), recent: busy || sessions.some((s) => s.state !== 'gone') });

/** A time as local HH:MM, or MM-DD HH:MM when it is not on the day of now; ? for none. */
export function local(ms, now) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '?';
  const d = new Date(ms);
  return startOfDay(ms) === startOfDay(now) ? hm(ms) : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm(ms)}`;
}

// The Lead's state from its newest hook event (packs/pstack/bin/transcript-copy.mjs writes state.json): Claude Code's Notification
// types and the hooks the launcher sets. It is data, to be adjusted from what real Leads send; an event it does not name leaves the
// state the Lead's log gives.
const LEAD_STATES = {
  'Notification:permission_prompt': 'waiting',
  'Notification:elicitation_dialog': 'waiting',
  'Notification:idle_prompt': 'idle',
  Stop: 'idle',
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
};

/** The Lead's state from state.json's event and its process: { state, stateAt, waitNote? }, or null to leave it to the log. An event
 * older than the process belongs to an earlier session. A process that carries the new SessionStart hook, is over a minute old and
 * has run none of its hooks waits at the login or the folder trust. That is an inference: whether SessionStart fires only after the
 * trust dialog has not been seen yet; it is seen at zalo-gateway's first Lead start. A Lead started before the hook existed never
 * gets this line. */
function leadStateOf({ event, command, ageMs, now }) {
  const at = event ? Date.parse(event.at) : NaN;
  if (Number.isFinite(at) && (ageMs == null || at >= now - ageMs)) {
    const state = LEAD_STATES[event.type ? `${event.event}:${event.type}` : event.event];
    return state ? { state, stateAt: at } : null;
  }
  return /"SessionStart"/.test(command) && ageMs > LOGIN_MS ? { state: 'waiting', waitNote: 'login or folder trust?' } : null;
}

function shape(p, { record, role, name, issue, folder, seat, live, mtime, start, cwd, repo, branch, harness, now, override = null, pane = null, team = null }) {
  const ageMs = now - mtime;
  return {
    name, role, team, recordTeam: record?.team ?? null, issue, folder, repo, seat, harness, live, pane,
    ...(override ?? stateOf(p, { live, ageMs, record, now })),
    model: p.model ?? record?.model?.split(',')[0] ?? null,
    effort: PRESETS[role]?.effort ?? (role === 'lead' ? 'high' : null),
    ctx: p.ctx, turns: p.turns ?? num(record?.turns), tokensIn: p.tokensIn, tokensOut: p.tokensOut,
    cost: p.cost ?? num(record?.total_cost_usd), estCost: p.cost === null ? p.estCost : null,
    startedAt: start, lastAt: mtime, cwd: cwd ?? null, branch: branch ?? null,
  };
}

/** Every session: the run folders' logs, and each Lead's process with its transcript copies. */
export function gatherSessions({ runs, state, now, root = null, clones = new Map(), live = runLive, processes = psList, branchOf = branchIn, originOf = originIn, origins = new Map() }) {
  // A work folder's origin, asked of git once for as long as `origins` lives (the caller clears it at each GitHub refresh).
  const originCached = (cwd) => {
    if (!origins.has(cwd)) origins.set(cwd, originOf(cwd));
    return origins.get(cwd);
  };
  const records = lastRecords(readSessions(state));
  const out = [];
  for (const folder of existsSync(runs) ? readdirSync(runs).sort() : []) {
    const dir = join(runs, folder);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^run-(.+)\.jsonl$/.exec(n);
      if (!m || m[1].endsWith('.claim')) continue;
      const tag = m[1];
      const file = join(dir, n);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const record = records.get(`${dir}#${tag}`) ?? null;
      const p = parseLog(readText(file));
      const role = roleOf(tag, record);
      const issue = /^issue-(\d+)/.exec(folder)?.[1] ?? null;
      const seat = readText(join(dir, `run-${tag}.seat`)).trim() || (record?.seat != null ? String(record.seat) : null);
      const isLive = live(join(dir, `run-${tag}.pid`));
      const cwd = p.cwd;
      out.push(shape(p, {
        record, role, name: readText(join(dir, `run-${tag}.name`)).trim() || `${issue ?? folder}-${tag}`, issue: issue ? Number(issue) : null, folder, seat, live: isLive,
        mtime: st.mtimeMs, start: record?.start ? Date.parse(record.start) : st.birthtimeMs, cwd,
        repo: record?.repo ?? (cwd ? originCached(cwd) : null) ?? repoOfCwd(cwd, clones), branch: record?.branch ?? (isLive ? branchOf(cwd) : null), harness: 'claude -p', now,
      }));
    }
  }
  for (const proc of processes()) {
    const found = leadOf(proc.command);
    if (!found) continue;
    const { repo: repoName, team } = found;
    const leadDir = join(runs, `${repoName}-${team}`);
    const dir = join(leadDir, 'transcripts');
    let newest = null;
    for (const n of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.jsonl')) : []) {
      const s = statSync(join(dir, n));
      if (!newest || s.mtimeMs > newest.mtimeMs) newest = { file: join(dir, n), mtimeMs: s.mtimeMs };
    }
    const repo = [...clones.keys()].find((r) => r.split('/')[1] === repoName) ?? null;
    const cwd = repo ? clones.get(repo) : null;
    let event = null;
    try {
      event = JSON.parse(readText(join(leadDir, 'state.json')));
    } catch {
      // no state yet: the log gives the state
    }
    out.push(shape(newest ? parseLog(readText(newest.file)) : parseLog(''), {
      record: null, role: 'lead', name: readText(join(leadDir, 'name')).trim() || `${repoName}-${team}`, team, issue: null, folder: null, seat: null, live: true,
      mtime: newest?.mtimeMs ?? now, start: null, cwd, repo, branch: branchOf(cwd), harness: 'claude', now,
      override: leadStateOf({ event, command: proc.command, ageMs: proc.ageMs, now }), pane: readText(join(leadDir, 'pane')).trim() || null,
    }));
  }
  // One run folder is one issue, and one issue sits under one repository: a run with none takes the one its folder's other runs have.
  for (const s of out) {
    if (s.repo || !s.folder) continue;
    const known = new Set(out.filter((o) => o.folder === s.folder && o.repo).map((o) => o.repo));
    if (known.size === 1) s.repo = [...known][0];
  }
  // Still none: the run folder's name says. `issue-<n>` is a factory run, the checkout's own repository; `<short>-<n>` is a pstack
  // Lead's (packs/pstack/lead.md), where <short> is the name of a known repository.
  const names = new Set([...clones.keys(), ...out.map((o) => o.repo).filter(Boolean)]);
  for (const s of out) {
    if (s.repo || !s.folder) continue;
    const m = /^(.+)-\d+$/.exec(s.folder);
    s.repo = m?.[1] === 'issue' ? (root ? originCached(root) : null) : ([...names].find((r) => r.split('/')[1] === m?.[1]) ?? null);
  }
  const rank = (s) => ROLE_ORDER.indexOf(s.role) === -1 ? ROLE_ORDER.length : ROLE_ORDER.indexOf(s.role);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** The queue's and the alerts' state: the time in the newest `queue-*.ok`, the `queue-*.failed` files, every `*.failed` file. */
export function queueOf(dir) {
  let names = [];
  try {
    names = readdirSync(dir).sort();
  } catch {}
  const first = (f) => readText(join(dir, f)).split('\n')[0].trim();
  const oks = names.filter((f) => /^queue-.*\.ok$/.test(f)).map(first).filter(Boolean).sort();
  const failed = names.filter((f) => f.endsWith('.failed')).map((f) => ({ file: f, text: first(f) }));
  return { lastSweep: oks.at(-1) ?? null, queueFailed: failed.filter((f) => f.file.startsWith('queue-')).length, failed };
}

const ghJson = async (args) => JSON.parse((await run('gh', args, { encoding: 'utf8', timeout: CALL_MS, maxBuffer: 64 << 20 })).stdout);
const firstLine = (e) => String(e.stderr || e.message || e).trim().split('\n')[0].slice(0, 80);

// The git options of the trusted jobs (kit/.gate/bin/lib/claim.mjs JOB_NET): gh's helper carries the agents' login.
const NET = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

/** The claims on a repository as `claim --list` reads them: the tip of each refs/heads/claim/<n>, by its subject. The URL is
 * built from the repository's name alone (`url` is for tests), never asked of a clone, whose config a worker can write. Every
 * git call runs in a bare repository of the view's own, `<state>/top/<owner>-<name>.git`, made on first use, so that only its
 * config applies and nothing is written into a clone or the folder the view runs from; `--` ends the options before the URL. */
export async function readClaims(repo, state, { url = `https://github.com/${repo}.git` } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not owner/name: ${JSON.stringify(repo)}`);
  const git = async (cwd, ...a) => (await run('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: CALL_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  const top = join(state, 'top');
  const cache = join(top, `${repo.replace('/', '-')}.git`);
  if (!existsSync(cache)) {
    mkdirSync(top, { recursive: true });
    await git(top, 'init', '--bare', '--quiet', basename(cache));
  }
  const claims = new Map();
  for (const l of (await git(cache, ...NET, 'ls-remote', '--', url, 'refs/heads/claim/*')).split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]+)\trefs\/heads\/claim\/([1-9]\d*)$/.exec(l);
    if (!m) continue;
    const n = Number(m[2]);
    try {
      await git(cache, 'cat-file', '-e', `${m[1]}^{commit}`);
    } catch {
      await git(cache, ...NET, 'fetch', '--quiet', '--', url, `refs/heads/claim/${n}:refs/claims/${n}`);
    }
    claims.set(n, claimStateOf(n, await git(cache, 'log', '-1', '--format=%s', m[1])));
  }
  return claims;
}

/** Issues, pull requests and claims of the repositories, at most once a minute (cache holds the last read). A call that
 * fails gives its first line and the rest still shows. */
export async function gatherGithub({ repos, clones, state, claims = readClaims, now, cache = {} }) {
  if (cache.data && now - cache.at < GH_MS) return cache.data;
  const data = { ok: true, error: null, at: now, repos: {} };
  const good = (cache.good ??= {});
  await Promise.all(repos.map(async (repo) => {
    try {
      const [issues, prs] = await Promise.all([
        ghJson(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '300', '--json', 'number,state,title']),
        ghJson(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,state,headRefName,body,labels,mergedAt,reviewDecision,statusCheckRollup']),
      ]);
      let held = new Map();
      let claimsOk = true;
      try {
        held = await claims(repo, state);
      } catch {
        claimsOk = false;
      }
      // The checks `main` requires: the kit's for a repository whose clone holds the kit, `verify` alone for any other.
      const required = clones.get(repo) && existsSync(join(clones.get(repo), '.gate/bin')) ? REQUIRED : ['verify'];
      const entry = { issues, prs, claims: held, claimsOk, required };
      good[repo] = { entry, at: now };
      data.repos[repo] = entry;
    } catch (error) {
      data.ok = false;
      data.error = `${repo}: ${firstLine(error)}`;
      // A failed read replaces nothing: the last good one stays, marked with the two times; with none, every field is ?.
      data.repos[repo] = good[repo]
        ? { ...good[repo].entry, failedAt: now, goodAt: good[repo].at }
        : { unknown: true, issues: [], prs: [], claims: new Map(), claimsOk: false, required: ['verify'], failedAt: now, goodAt: null };
    }
  }));
  cache.data = data;
  cache.at = now;
  return data;
}

const MARK = (c) => {
  if (!c) return '–';
  if (c.status && c.status !== 'COMPLETED') return '…';
  if (c.conclusion === 'SUCCESS') return '✓';
  return c.conclusion ? '✗' : '…';
};

/** A group per issue: its claim, step, pull request with the required checks, and who it waits on. */
function groupOf(repo, number, gh, sessions, day) {
  // No GitHub data at all for this repository: nothing is filled in.
  if (!gh || gh.unknown) {
    return {
      number, title: '?', done: false, ...shownOf(sessions, day, false), team: null, step: '?', pr: null, unknown: true,
      waiting: sessions.some((s) => s.live) ? 'the team' : '?', sessions,
    };
  }
  const issue = gh.issues.find((i) => i.number === number) ?? null;
  const prs = (gh?.prs ?? []).filter((p) => new RegExp(`^Issue: #${number}\\b`, 'm').test(p.body ?? '') && p.state !== 'CLOSED');
  const pr = prs.find((p) => p.state === 'OPEN') ?? prs.filter((p) => p.mergedAt).sort((a, b) => b.number - a.number)[0] ?? null;
  const claim = gh?.claims.get(number);
  const held = claim && (claim.state === 'claimed' || claim.state === 'handed-off') ? claim.team : null;
  const checks = Object.fromEntries(gh.required.map((name) => [name, (pr?.statusCheckRollup ?? []).filter((c) => c.name === name).at(-1) ?? null]));
  const labels = (pr?.labels ?? []).map((l) => l.name);
  const merged = Boolean(pr?.mergedAt);
  const closed = issue?.state === 'CLOSED';
  const step = merged ? 'merged' : closed ? 'closed' : pr ? 'PR open' : held ? 'claimed' : gh?.claimsOk === false ? '?' : 'unclaimed';
  let waiting = '–';
  if (pr && !merged) {
    if (labels.some((l) => l === 'tier-3' || l === 'needs-human') && checks.tier && checks.tier.status === 'COMPLETED' && checks.tier.conclusion !== 'SUCCESS') waiting = 'the Human';
    else if (pr.reviewDecision === 'REVIEW_REQUIRED' && gh.required.every((n) => MARK(checks[n]) === '✓')) waiting = 'the Human';
    else if (checks.review && checks.review.status !== 'COMPLETED') waiting = 'the reviewer';
  }
  if (waiting === '–' && sessions.some((s) => s.live)) waiting = 'the team';
  return {
    number, title: issue?.title ?? '?',
    done: closed,
    ...shownOf(sessions, day, Boolean(held) || Boolean(pr && !merged)),
    team: held ?? /^Team: (\S+)/m.exec(pr?.body ?? '')?.[1] ?? null,
    step, pr: pr ? { number: pr.number, title: pr.title, checks: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, MARK(c)])) } : null,
    waiting, sessions,
  };
}

/** Everything one frame shows, read now. `cache` keeps GitHub's last read between calls. */
export async function snapshot(opts = {}) {
  const home = process.env.HOME ?? homedir();
  const now = opts.now ?? Date.now();
  const runs = opts.runs ?? process.env.FACTORY_RUNS ?? join(home, 'factory-runs');
  const state = opts.state ?? process.env.FACTORY_STATE ?? join(home, '.local/state/factory');
  const root = opts.root ?? process.env.FACTORY_ROOT ?? join(here, '..', '..');
  const clones = opts.clones ?? clonesUnder(root);
  const cache = opts.cache ?? {};
  if (!cache.origins || now - cache.origins.at >= GH_MS) cache.origins = { at: now, map: new Map() };
  const sessions = gatherSessions({ runs, state, now, root, clones, live: opts.live, processes: opts.processes, branchOf: opts.branchOf, originOf: opts.originOf, origins: cache.origins.map });
  // Every repository a session names has its issues read too, not only the clones.
  const repos = [...new Set([...(opts.repos ?? clones.keys()), ...sessions.map((s) => s.repo).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r ?? ''))])];
  const github = await gatherGithub({ repos, clones, state, claims: opts.claims, now, cache });
  const byRepo = [...new Set([...repos, ...sessions.map((s) => s.repo).filter(Boolean)])].map((repo) => {
    const mine = sessions.filter((s) => s.repo === repo);
    const gh = github.repos[repo];
    const numbers = new Set([...(gh?.issues ?? []).map((i) => i.number), ...mine.map((s) => s.issue).filter((n) => n !== null)]);
    const groups = [...numbers].sort((a, b) => a - b).map((n) => groupOf(repo, n, gh, mine.filter((s) => s.issue === n), startOfDay(now)));
    return { repo, groups, other: mine.filter((s) => s.issue === null), ghStatus: gh?.failedAt ? { failedAt: gh.failedAt, goodAt: gh.goodAt } : null };
  });
  const agentProfiles = opts.agentProfiles ?? process.env.AGENT_PROFILES ?? join(home, '.agent-profiles');
  const accounts = accountRows({ state, runs, agentProfiles, root });
  return {
    now, load: opts.load ?? loadavg(), cores: opts.cores ?? cpus().length, sessions, repos: byRepo, github, queue: queueOf(state), accounts,
    seats: opts.live ? seatCounts(sessions) : seatsLive(runs), today: todayOf({ now, repos: byRepo, github, records: readSessions(state), accounts, seatRows: seatAccounts(state) }),
  };
}

/** The seats' live sessions as bin/seat counts them (liveCount). */
const seatsLive = (runs) => Object.fromEntries(Object.keys(SEATS).map((n) => [n, { live: liveCount(runs, Number(n)) }]));

const seatCounts = (sessions) => Object.fromEntries(Object.keys(SEATS).map((n) => [n, { live: sessions.filter((s) => s.live && s.seat === n).length }]));

/** The lettered accounts (token.mjs's accountList, which `bin/factory` lists too) with the quota of each from its own newest event
 * (quotaRows, one row for each account, #311), and who uses each: its teams, `<repo>-<team>`. */
function accountRows({ state, runs, agentProfiles, root }) {
  const teams = teamRows(state, root);
  let quota = [];
  try {
    quota = quotaRows({ runs, state, root });
  } catch {
    // no quota to show: every window is ?
  }
  return accountList({ state, agentProfiles }).map(({ name, letter }) => {
    const q = quota.find((x) => x.account === name && x.asOf);
    const users = teams.filter((t) => t.account === name).map((t) => t.name);
    return { letter, name, five_hour: q?.windows?.five_hour ?? null, seven_day: q?.windows?.seven_day ?? null, users };
  });
}

const HUMAN_LABELS = new Set(['tier-3', 'needs-human']);

/** Today (the local day of now): the pull requests merged, the cost of the sessions.jsonl records that ended today for each account
 * letter (a Lead's cost is in no record), and the time pull requests waited on the Human, clipped to today. A pull request waited
 * from the newest finish of its required checks other than `tier` until it merged, or until now while it waits. */
export function todayOf({ now, repos, github, records, accounts, seatRows = {} }) {
  const day = startOfDay(now);
  let merged = 0;
  let waitedMs = 0;
  for (const r of repos) {
    const gh = github.repos[r.repo];
    for (const pr of gh && !gh.unknown ? gh.prs : []) {
      if (pr.mergedAt && Date.parse(pr.mergedAt) >= day) merged += 1;
      const open = pr.state === 'OPEN';
      const human = open ? r.groups.some((g) => g.pr?.number === pr.number && g.waiting === 'the Human') : Boolean(pr.mergedAt) && (pr.labels ?? []).some((l) => HUMAN_LABELS.has(l.name));
      const finished = gh.required.filter((n) => n !== 'tier').flatMap((n) => (pr.statusCheckRollup ?? []).filter((c) => c.name === n).map((c) => Date.parse(c.completedAt))).filter(Number.isFinite);
      if (!human || !finished.length) continue;
      waitedMs += Math.max(0, Math.min(now, open ? now : Date.parse(pr.mergedAt)) - Math.max(day, ...finished));
    }
  }
  const cost = new Map();
  for (const x of lastOfSession(records)) {
    if (!(Date.parse(x.end) >= day) || typeof x.total_cost_usd !== 'number') continue;
    const account = x.account ?? seatRows[x.seat]; // a record from before #311 has no account: its seat's old row
    const letter = accounts.find((a) => a.name === account)?.letter ?? '?';
    cost.set(letter, (cost.get(letter) ?? 0) + x.total_cost_usd);
  }
  return { merged, cost: [...cost].sort(([a], [b]) => a.localeCompare(b)).map(([letter, usd]) => [letter, Math.round(usd * 100) / 100]), waitedMs };
}

/** A span as 45s, 12m, 3h05 or 5d; a negative one (a log written after the snapshot's clock) is 0s; not a number is ?. */
export const age = (ms) => {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '?';
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d`;
};
const kilo = (n) => (n === null || n === undefined ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// Widths are counted in terminal cells (#174): a wide character is two, a combining or zero-width one none, an SGR sequence none.
// Text is walked by code point, so a surrogate pair is never cut.
const WIDE = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]];
const NONE = [[0, 0x1f], [0x7f, 0x9f], [0x300, 0x36f], [0x200b, 0x200f], [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef]];
const within = (ranges, c) => ranges.some(([a, b]) => c >= a && c <= b);
const cellW = (c) => (within(NONE, c) ? 0 : within(WIDE, c) ? 2 : 1);
const SGR = /\x1b\[[0-9;]*m/g;

/** The width of a string in terminal cells. */
export function cells(s) {
  let n = 0;
  for (const ch of String(s).replace(SGR, '')) n += cellW(ch.codePointAt(0));
  return n;
}

/** Plain text cut to n cells, with … where it was cut. It is given data, never a finished line with colour in it. */
export function clip(s, n) {
  const text = String(s);
  if (cells(text) <= n) return text;
  if (n < 1) return '';
  let out = '';
  let w = 0;
  for (const ch of text) {
    const c = cellW(ch.codePointAt(0));
    if (w + c > n - 1) break;
    out += ch;
    w += c;
  }
  return `${out}…`;
}

/** Plain text cut to n cells at a word boundary, when what is kept holds one. */
export function cutWord(s, n) {
  const text = String(s);
  if (cells(text) <= n) return text;
  if (n < 1) return '';
  const body = clip(text, n).slice(0, -1);
  const kept = text[body.length] === ' ' || !body.includes(' ') ? body : body.slice(0, body.lastIndexOf(' '));
  return `${kept.trimEnd()}…`;
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - cells(s)));

// Colour is basic SGR only, so the terminal's theme picks the hues (#174): yellow means only "waits on you".
const BOLD = '1';
const YELLOW = '1;33';
const GREEN = '32';
const RED = '31';
const DIM = '2';

// A session's state is a mark and a word, so the word carries it without colour; `rank` orders a block: waiting on the Human,
// stuck, working, idle, done.
const SESSION_STATES = {
  waiting: { mark: '!', word: 'waiting', code: YELLOW, rank: 0 },
  failed: { mark: '×', word: 'failed', code: RED, rank: 1 },
  stopped: { mark: '×', word: 'out of quota', code: RED, rank: 1 },
  working: { mark: '●', word: 'working', code: GREEN, rank: 2 },
  idle: { mark: '○', word: 'idle', code: null, rank: 3 },
  done: { mark: '✓', word: 'done', code: DIM, rank: 4 },
  gone: { mark: '✓', word: 'gone', code: DIM, rank: 4 },
};
const stateOfRow = (s) => SESSION_STATES[s.state] ?? { mark: '○', word: String(s.state), code: null, rank: 3 };

// COST is the session's total across resumes (the last result's total_cost_usd), while TOKENS and TURNS count this log's
// rounds only, so a resumed session's row mixes two spans; a live `~$` estimate counts this log alone.
// The columns of a session row: key, header, widest. NOTE is the free-text cell that ends the row; the others, #174's
// engineering columns, come with `c` or --full. When a row does not fit, columns go whole in the order of S_STEPS.
const S_BASE = [['name', 'NAME', 18], ['role', 'ROLE', 10], ['state', 'STATE', 14], ['for', 'FOR', 17], ['cost', 'COST', 8], ['note', 'NOTE', 40]];
const S_FULL = [['harness', 'HARNESS', 9], ['model', 'MODEL', 18], ['seat', 'SEAT', 5], ['ctx', 'CTX', 8], ['turns', 'TURNS', 6], ['tokens', 'TOKENS ↓/↑', 14], ['cwd', 'CWD', 24], ['branch', 'BRANCH', 40]];
const S_STEPS = ['branch', 'cwd', 'tokens', 'turns', 'ctx', 'seat', 'model', 'harness', 'cost', 'role', 'for', ['name', 8], ['name', 4]];
// The columns of an issue row, and what goes first: the title is the free-text cell and is cut; the state and #n stay.
const I_COLS = [['state', '', 13], ['num', '', 6], ['team', '', 12], ['step', '', 9], ['pr', '', 9], ['checks', '', 34], ['title', '', 80]];
const I_STEPS = ['team', 'step', 'checks', 'pr'];
const GAP = 1;
const MIN_FREE = 12;
const tail = (cwd) => (cwd ? cwd.split(sep).filter(Boolean).slice(-2).join('/') : '?');

/** The columns a row set keeps in `room` cells. `natural` is each column's widest cell (0: nothing to show). Columns go whole in the
 * order of `steps` (a [key, n] step shrinks one to n cells) until the last column, which takes what is left and is cut, has
 * min(its width, MIN_FREE); the `keep` columns are never dropped. */
function planCols(cols, natural, steps, room, keep) {
  let kept = cols.filter(([key]) => natural[key] > 0).map(([key, head]) => ({ key, head, w: natural[key] }));
  const used = () => kept.slice(0, -1).reduce((n, c) => n + c.w + GAP, 0);
  for (const step of steps) {
    if (room - used() >= Math.min(kept.at(-1).w, MIN_FREE)) break;
    if (typeof step === 'string') kept = kept.filter((c) => c.key !== step);
    else for (const c of kept) if (c.key === step[0]) c.w = Math.min(c.w, step[1]);
  }
  for (let i = kept.findLastIndex((c) => !keep.includes(c.key)); room - used() < 2 && i > 0; i = kept.findLastIndex((c) => !keep.includes(c.key))) kept.splice(i, 1);
  const last = kept.at(-1);
  last.w = Math.max(0, Math.min(last.w, room - used()));
  return kept;
}

const naturalOf = (cols, all, heads) => Object.fromEntries(cols.map(([key, head, cap]) => [key, Math.min(cap, Math.max(heads ? cells(head) : 0, ...all.map((c) => cells(c[key] ?? ''))))]));

/** One row: the kept columns padded to their widths, the last one cut at a word boundary; `style` colours a cell by its key. */
function rowOf(kept, cell, style = {}, indent = 0) {
  const parts = kept.map((c, i) => {
    const last = i === kept.length - 1;
    const text = last ? cutWord(cell[c.key] ?? '', c.w) : clip(cell[c.key] ?? '', c.w);
    const painted = style[c.key] && text ? style[c.key](text) : text;
    return last ? painted : pad(painted, c.w);
  });
  return ' '.repeat(indent) + parts.join(' '.repeat(GAP)).trimEnd();
}

/** The cells of a session row, as plain text. The name cell holds the row's indent, so that a header sits over every level. */
function sessionCells(s, now, indent) {
  const model = s.model ? `${s.model.replace(/^claude-/, '')} ${s.effort ?? '?'}` : '?';
  const cost = s.cost !== null ? `$${s.cost.toFixed(2)}` : s.estCost !== null && s.estCost !== undefined ? `~$${s.estCost.toFixed(2)}` : '?';
  // A Lead is shown since its newest hook event; any other session by how long it has run (or ran).
  const span = s.role === 'lead' ? (s.stateAt ? `since ${local(s.stateAt, now)}` : '?') : s.startedAt ? age((s.live ? now : s.lastAt) - s.startedAt) : '?';
  const st = stateOfRow(s);
  return {
    name: `${' '.repeat(indent)}${s.name}`, role: s.role === 'lead' ? `Lead ${s.team}` : s.role, state: `${st.mark} ${st.word}`, for: span, cost,
    note: [s.state === 'stopped' ? `until ${local(s.until, now)}` : null, s.waitNote, s.rounds > 1 ? `${s.rounds} rounds` : null].filter(Boolean).join(', '),
    harness: s.harness, model, seat: s.seat ?? '?', ctx: kilo(s.ctx), turns: String(s.turns ?? '?'),
    tokens: s.tokensIn === null ? '?' : `${kilo(s.tokensIn)}/${kilo(s.tokensOut)}`, cwd: tail(s.cwd), branch: s.branch ?? '?',
  };
}

/** The sessions of one run folder as the rows they show: a worker's fix rounds resume one session, so the worker rounds of one
 * name in one folder are one row, counted in `rounds`, with the newest round's state (a live one first) and the first start. */
function mergeRounds(list) {
  const out = [];
  const seen = new Map();
  for (const s of list) {
    const prior = s.role === 'worker' ? seen.get(`${s.folder}\0${s.name}`) : null;
    if (!prior) {
      const row = { ...s, rounds: 1 };
      out.push(row);
      if (s.role === 'worker') seen.set(`${s.folder}\0${s.name}`, row);
      continue;
    }
    const newer = s.live !== prior.live ? s.live : s.lastAt >= prior.lastAt;
    const starts = [prior.startedAt, s.startedAt].filter(Number.isFinite);
    Object.assign(prior, newer ? s : {}, { rounds: prior.rounds + 1, startedAt: starts.length ? Math.min(...starts) : null });
  }
  return out;
}

const roleRank = (s) => (ROLE_ORDER.includes(s.role) ? ROLE_ORDER.indexOf(s.role) : ROLE_ORDER.length);
/** A block's order: waiting on the Human, stuck, working, idle, done; then by role and name. */
const byState = (a, b) => stateOfRow(a).rank - stateOfRow(b).rank || roleRank(a) - roleRank(b) || a.name.localeCompare(b.name, 'en', { numeric: true });

/** An issue's state, with its mark and word: who it waits on, or that it is stuck, or done. `all` is its session rows. */
function issueState(g, all) {
  if (g.done) return { mark: '✓', word: g.step === 'merged' ? 'merged' : 'closed', code: DIM, rank: 4 };
  if (g.waiting === 'the Human') return { mark: '!', word: 'on you', code: YELLOW, rank: 0 };
  const newest = all.filter((v) => v.state !== 'gone').sort((a, b) => b.lastAt - a.lastAt)[0];
  if (!g.pr && newest && !all.some((v) => v.live) && (newest.state === 'failed' || newest.state === 'stopped')) return { mark: '×', word: 'stuck', code: RED, rank: 1 };
  if (g.waiting === 'the reviewer') return { mark: '●', word: 'on reviewer', code: GREEN, rank: 2 };
  if (g.waiting === 'the team') return { mark: '●', word: 'on team', code: GREEN, rank: 2 };
  if (g.waiting === '?') return { mark: '○', word: '?', code: null, rank: 3 };
  return { mark: '○', word: 'idle', code: null, rank: 3 };
}

/** The cells of an issue row: its state first, then #n, team, step, the pull request with its checks, and the title last. */
function issueCells(g, st) {
  return {
    state: `${st.mark} ${st.word}`, num: `#${g.number}`, team: g.unknown ? '?' : (g.team ?? '–'), step: g.step,
    pr: g.pr ? `PR #${g.pr.number}` : g.unknown ? 'PR ?' : 'no PR',
    checks: g.pr ? Object.entries(g.pr.checks).map(([k, v]) => `${k}${v}`).join(' ') : '',
    title: g.title,
  };
}

/** Items packed into lines of at most `width` cells, never broken inside an item: an item that does not fit starts the next line, behind
 * `next`. An item is its text, or { text, lead, code }: `lead` joins it to the one before (` · ` unless said). An item alone wider
 * than the line is cut. */
function wrapItems(items, width, { first = '', next = first, lead: sep = ' · ', paint = (_, t) => t } = {}) {
  const lines = [];
  let line = first;
  let plain = first;
  let fresh = true;
  for (const it of items) {
    const { text, lead = sep, code = null } = typeof it === 'string' ? { text: it } : it;
    if (!fresh && cells(plain) + cells(lead) + cells(text) > width) {
      lines.push(line);
      line = next;
      plain = next;
      fresh = true;
    }
    const piece = (fresh ? '' : lead) + text;
    const shown = cells(plain) + cells(piece) > width ? cutWord(piece, Math.max(0, width - cells(plain))) : piece;
    line += code ? paint(code, shown) : shown;
    plain += shown;
    fresh = false;
  }
  lines.push(line);
  return lines;
}

/** The tabs: All, one for each repository (name and the sessions it shows), Done (the issues). */
export function tabsOf(snap) {
  const shown = (r) => mergeRounds(r.groups.filter((g) => !g.done).flatMap((g) => g.sessions).concat(r.other)).filter((s) => s.state !== 'gone');
  return [
    { label: 'All', kind: 'all' },
    ...snap.repos.map((r) => ({ label: `${r.repo.split('/').pop()} ${shown(r).length}`, kind: 'repo', repo: r.repo })),
    { label: `Done ${snap.repos.reduce((n, r) => n + r.groups.filter((g) => g.done).length, 0)}`, kind: 'done' },
  ];
}

/** A string from a log, a folder or GitHub, less its control characters, so none can reach the terminal as an escape sequence. */
const clean = (s) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const cleanDeep = (v) => (typeof v === 'string' ? clean(v) : Array.isArray(v) ? v.map(cleanDeep) : v && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)])) : v);

/** One frame as text, each line at most `width` cells. tab indexes tabsOf(snap). It is a pure function: `color` (basic SGR) and `keys`
 * (the keys line, which `--once` leaves out) are options, and every data field is cleaned of control characters before it is styled. */
export function render(input, { width = 120, tab = 0, rows = null, full = false, color = false, keys = false } = {}) {
  const paint = (code, text) => (color && code && text ? `\x1b[${code}m${text}\x1b[0m` : text);
  const tint = (code) => (code ? (text) => paint(code, text) : undefined);
  const snap = { ...input, sessions: cleanDeep(input.sessions), repos: cleanDeep(input.repos), accounts: cleanDeep(input.accounts), queue: cleanDeep(input.queue), github: { ...input.github, error: clean(input.github.error ?? '') } };
  const { sessions, queue, github, now } = snap;
  const day = startOfDay(now);
  const count = (st) => sessions.filter((s) => s.state === st).length;
  const q = queue.lastSweep ? `queue ${queue.queueFailed ? 'failed, last ok' : 'ok'} ${local(Date.parse(queue.lastSweep), now)}` : 'queue ?';
  const ghText = github.ok ? `gh ok ${age(now - github.at)} ago` : `gh failed (${github.error})`;
  const tabs = tabsOf(snap);
  const t = tabs[tab] ?? tabs[0];
  const wrapped = (items, opts) => wrapItems(items, width, { paint, ...opts });
  const lines = [
    ...wrapped([
      `Mac mini  load ${snap.load[0].toFixed(1)} of ${snap.cores} cores`, { text: `${count('working')} working`, lead: '  ·  ' }, { text: `${count('idle')} idle`, lead: ' · ' },
      { text: `${count('waiting')} agent${count('waiting') === 1 ? '' : 's'} waiting`, lead: ' · ' }, hm(now), q, `alerts ${queue.failed.length}`, ghText,
    ], { lead: '  ·  ' }),
    ...wrapped(tabs.map((x, i) => `${i === tab ? '▸' : ''}[${i + 1} ${x.label}]`), { lead: ' ' }),
  ];
  // What waits on the Human, one line each: what he does, and where. A line too wide loses its tail (the URL) first, then its text is cut.
  const item = (verb, text, url = '') => {
    const lead = `  ${verb.padEnd(7)}  `;
    const whole = `${lead}${text}${url ? `  ${url}` : ''}`;
    return paint(YELLOW, cells(whole) <= width ? whole : `${lead}${cutWord(text, Math.max(0, width - cells(lead)))}`);
  };
  const waits = [
    ...snap.repos.flatMap((r) => r.groups.filter((g) => !g.done && g.pr && g.waiting === 'the Human').map((g) => item('approve', `${r.repo}#${g.pr.number} ${g.pr.title}`, `https://github.com/${r.repo}/pull/${g.pr.number}`))),
    ...sessions.filter((s) => s.role === 'lead' && s.state === 'waiting').map((s) => item('answer', `${s.name} (${s.repo?.split('/')[1] ?? '?'} Lead, team ${s.team})  pane ${s.pane ?? s.name}${s.waitNote ? `  ${s.waitNote}` : ''}`)),
    ...queue.failed.map((f) => item('alert', `${f.file}  ${f.text.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z/, (iso) => local(Date.parse(iso), now))}`)),
  ];
  lines.push(...(waits.length ? [paint(YELLOW, 'Waiting on you'), ...waits] : ['Nothing waits on you']));

  // The columns are planned once for the frame, over every row that could print (the folded ones too), so they do not jump between
  // frames or tabs. A session row's name cell holds its indent: a Lead 2, a session under an issue 6, one under no issue 4.
  const everyone = mergeRounds(sessions);
  const sNatural = naturalOf([...S_BASE, ...(full ? S_FULL : [])], everyone.map((v) => sessionCells(v, now, v.role === 'lead' ? 2 : v.issue === null ? 4 : 6)), full);
  const sKept = planCols([...S_BASE, ...(full ? S_FULL : [])], sNatural, S_STEPS, width, ['name', 'state']);
  const allGroups = snap.repos.flatMap((r) => r.groups);
  const iKept = planCols(I_COLS, naturalOf(I_COLS, allGroups.map((g) => issueCells(g, issueState(g, mergeRounds(g.sessions)))), false), I_STEPS, width - 4, ['state', 'num']);
  const sLine = (v, indent) => rowOf(sKept, sessionCells(v, now, indent), { state: tint(stateOfRow(v).code) });
  const iLine = (g, st, indent) => rowOf(iKept, issueCells(g, st), { state: tint(st.code) }, indent);
  if (full) lines.push(rowOf(sKept, Object.fromEntries(sKept.map((c) => [c.key, c.head]))));
  const top = lines.length;
  const head = (repo, rest = '') => {
    const text = clip(rest ? `${repo}  ${rest}` : repo, width);
    return text.startsWith(repo) ? paint(BOLD, repo) + text.slice(repo.length) : paint(BOLD, text);
  };
  const foldedLines = (folded, older) => [...(folded ? [`  ${folded} ended before today`] : []), ...(older ? [`  ${older} older`] : [])];
  const quiet = [];
  for (const r of snap.repos) {
    if (t.kind === 'repo' && r.repo !== t.repo) continue;
    const st = r.ghStatus;
    const status = st ? `gh failed ${local(st.failedAt, now)}, ${st.goodAt ? `showing ${local(st.goodAt, now)}` : 'nothing read yet'}` : '';
    // A session that is live or last wrote today is listed; the others of the whole block fold into one line at its end.
    let folded = 0;
    const listedNow = (all) => {
      folded += all.filter((x) => !isListed(x, day)).length;
      return all.filter((x) => isListed(x, day)).sort(byState);
    };
    if (t.kind === 'done') {
      // The newest DONE_MAX closed issues; the rest fold into "N older".
      const closed = r.groups.filter((g) => g.done).sort((a, b) => b.number - a.number);
      const shownGroups = closed.slice(0, DONE_MAX);
      if (!closed.length) continue;
      lines.push(head(r.repo, status));
      for (const g of shownGroups) {
        const all = mergeRounds(g.sessions);
        lines.push(iLine(g, issueState(g, all), 2));
        for (const v of listedNow(all)) lines.push(sLine(v, 4));
      }
      lines.push(...foldedLines(folded, closed.length - shownGroups.length));
      continue;
    }
    // On the other tabs the issues with nothing going on fold into "N older".
    const shown = t.kind === 'repo' ? 'recent' : 'active';
    const older = r.groups.filter((g) => !g.done && !g[shown]).length;
    const entries = r.groups.filter((g) => !g.done && g[shown]).map((g) => {
      const all = mergeRounds(g.sessions);
      const teams = all.map((v) => parseTeam(v.recordTeam)?.team).filter(Boolean);
      return { g, st: issueState(g, all), rows: listedNow(all), team: g.team ?? teams[0] ?? null };
    });
    const leads = mergeRounds(r.other.filter((s) => s.role === 'lead')).sort(byState);
    const strays = listedNow(mergeRounds(r.other.filter((s) => s.role !== 'lead')));
    if (!leads.length && !entries.length && !strays.length && !st) {
      if (folded || older) quiet.push(head(r.repo, [folded ? `${folded} ended before today` : '', older ? `${older} older` : ''].filter(Boolean).join(', ')));
      continue;
    }
    lines.push(head(r.repo, status));
    // One block per team: its Lead row, then its issues, each with its sessions. An issue with no claim goes under the team of its
    // sessions' record, else under "no team".
    const byRank = (a, b) => a.st.rank - b.st.rank || a.g.number - b.g.number;
    const blocks = [...new Set([...leads.map((l) => l.team), ...entries.map((e) => e.team).filter(Boolean)])].map((team) => {
      const lead = leads.find((l) => l.team === team) ?? null;
      const mine = entries.filter((e) => e.team === team).sort(byRank);
      return { team, lead, mine, rank: Math.min(lead ? stateOfRow(lead).rank : 9, ...mine.map((e) => e.st.rank)) };
    }).sort((a, b) => a.rank - b.rank || a.team.localeCompare(b.team));
    const issues = (list) => {
      for (const e of list) {
        lines.push(iLine(e.g, e.st, 4));
        for (const v of e.rows) lines.push(sLine(v, 6));
      }
    };
    for (const b of blocks) {
      lines.push(b.lead ? sLine(b.lead, 2) : `  team ${b.team}`);
      issues(b.mine);
    }
    const unteamed = entries.filter((e) => !e.team).sort(byRank);
    if (unteamed.length) {
      lines.push('  no team');
      issues(unteamed);
    }
    if (strays.length) {
      lines.push('  no issue');
      for (const v of strays) lines.push(sLine(v, 4));
    }
    lines.push(...foldedLines(folded, older));
  }
  lines.push(...quiet);
  // A session no repository could be found for is no block and no tab: All counts it in one line.
  const unplaced = t.kind === 'all' ? sessions.filter((s) => !s.repo && s.state !== 'gone').length : 0;
  if (unplaced) lines.push(`  ${unplaced} ${unplaced === 1 ? 'session' : 'sessions'} with no repository`);
  const tree = lines.splice(top);
  const win = (label, w) => (w ? `${label} ${Math.round(w.use * 1000) / 10}%${w.resetsAt == null ? '' : resetPassed(w.resetsAt, now) ? ' (reset since)' : ` resets ${local(w.resetsAt * 1000, now)}`}` : `${label} ?`);
  const nameW = Math.max(0, ...snap.accounts.map((a) => a.name.length));
  const { merged, cost, waitedMs } = snap.today;
  const bottom = [
    ...(snap.accounts.length ? ['Accounts', ...snap.accounts.flatMap((a) => wrapped([win('5h', a.five_hour), win('7d', a.seven_day), a.users.join(', ') || 'no row'], { first: `  ${a.letter}  ${a.name.padEnd(nameW)}  `, next: '     ' }))] : []),
    ...wrapped([
      `${merged} pull request${merged === 1 ? '' : 's'} merged`,
      ...(cost.length ? cost.map(([letter, usd], i) => ({ text: `${i ? '' : 'workers and reviewers cost '}$${usd.toFixed(2)} on account ${letter}`, lead: i ? ', ' : ' · ' })) : ['workers and reviewers cost nothing yet']),
      `waited on you ${age(waitedMs)}`,
    ], { first: 'Today  ', next: '  ' }),
    ...(keys ? wrapped(['keys:', '1-9 or Tab switch tabs,', 'c full columns,', 'q quits'], { lead: ' ' }) : []),
  ];
  // With the terminal's rows, everything but the team blocks stays and the blocks are cut to fit, a row saying how much was left
  // out; without them (--once) the whole frame is printed.
  const room = rows ? rows - lines.length - bottom.length - 1 : tree.length;
  if (rows && tree.length > room) {
    return [...lines, ...tree.slice(0, Math.max(0, room)), cutWord(`… ${tree.length - Math.max(0, room)} more rows (a repository's tab shows fewer); 1-9 or Tab tabs, c full columns, q quits`, width), ...bottom].join('\n');
  }
  return [...lines, ...tree, ...bottom].join('\n');
}

async function loop(opts) {
  const out = process.stdout;
  const cache = {};
  let snap = null;
  let tab = 0;
  let full = Boolean(opts.full);
  let busy = false;
  const draw = () => {
    if (!snap) return;
    const text = render(snap, { width: out.columns ?? 120, tab, rows: out.rows ?? null, full, color: opts.color, keys: true }).split('\n').map((l) => `${l}\x1b[K`).join('\n');
    out.write(`\x1b[H${text}\x1b[J`);
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      snap = await snapshot({ ...opts, cache, now: Date.now() });
    } catch (error) {
      out.write(`\x1b[Hfactory top: ${firstLine(error)}\x1b[K`);
    } finally {
      busy = false;
    }
    draw();
  };
  const timer = setInterval(tick, LOCAL_MS);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  };
  process.on('exit', close);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  out.write('\x1b[?1049h\x1b[?25l');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === 'q' || key === '\x03') return process.exit(0);
    const count = snap ? tabsOf(snap).length : 1;
    if (key === 'c') full = !full;
    else if (key === '\t') tab = (tab + 1) % count;
    else if (/^[1-9]$/.test(key) && Number(key) <= count) tab = Number(key) - 1;
    draw();
  });
  await tick();
}

/** Colour is decided once: on a terminal that has colours, which hasColors reads from NO_COLOR, NODE_DISABLE_COLORS and FORCE_COLOR. */
const colorOf = () => Boolean(process.stdout.isTTY && typeof process.stdout.hasColors === 'function' && process.stdout.hasColors());

export async function main(argv) {
  const width = argv.includes('--width') ? Number(argv[argv.indexOf('--width') + 1]) : null;
  const color = colorOf();
  if (argv.includes('--once')) {
    const snap = await snapshot({});
    process.stdout.write(`${render(snap, { width: width ?? process.stdout.columns ?? 200, full: argv.includes('--full'), color })}\n`);
    return;
  }
  if (!process.stdin.isTTY) throw new Error('needs a terminal; use --once for one frame');
  await loop({ full: argv.includes('--full'), color });
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`factory top: ${firstLine(error)}`);
    process.exitCode = 1;
  });
}
