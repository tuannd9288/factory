// `factory top` (#174): one terminal view of every session the factory runs and the state of every repository it works on,
// repo -> issue -> session, modelled on `piggery top`. It changes nothing and keeps no store: it reads the run folders'
// stream-json logs and pid files, bin/seat's sessions.jsonl, the state folder's queue and *.failed files, the claim refs,
// and gh porcelain (never `gh api`). A field the data does not give is shown as `?`. The accounts panel waits for #178.
// `node bin/lib/top.mjs --once [--width N]` prints one frame; `factory top` wires it in once #177 lands.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stateOf as claimStateOf } from '../../kit/.gate/bin/lib/claim.mjs';
import { REQUIRED, clonesUnder, costOf, readSessions } from './ledger.mjs';
import { windowsOf } from './quota.mjs';
import { PRESETS, SEATS, liveCount, resetPassed, runLive } from './seat.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const LOCAL_MS = 2000;
const GH_MS = 60_000;
const CALL_MS = 15_000;
const WORKING_MS = 120_000;
const GONE_MS = 24 * 3600_000;
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

/** The processes as { pid, command }, from ps; [] when ps cannot run. */
function psList() {
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    if (!existsSync(ps)) continue;
    try {
      return execFileSync(ps, ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .flatMap((l) => {
          const m = /^\s*(\d+)\s+(.*)$/.exec(l);
          return m ? [{ pid: Number(m[1]), command: m[2] }] : [];
        });
    } catch {
      return [];
    }
  }
  return [];
}

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
    const window = w?.type === 'seven_day' ? '7d' : '5h';
    return { state: 'stopped', stopped: `${window} limit, resets ${resets != null ? `${hhmm(resets * 1000)}Z` : '?'}` };
  }
  return ageMs > GONE_MS ? { state: 'gone' } : { state };
}

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;

function shape(p, { record, role, name, issue, folder, seat, live, mtime, start, cwd, repo, branch, harness, now }) {
  const ageMs = now - mtime;
  return {
    name, role, issue, folder, repo, seat, harness, live,
    ...stateOf(p, { live, ageMs, record, now }),
    model: p.model ?? record?.model?.split(',')[0] ?? null,
    effort: PRESETS[role]?.effort ?? (role === 'lead' ? 'high' : null),
    ctx: p.ctx, turns: p.turns ?? num(record?.turns), tokensIn: p.tokensIn, tokensOut: p.tokensOut,
    cost: p.cost ?? num(record?.total_cost_usd), estCost: p.cost === null ? p.estCost : null,
    startedAt: start, lastAt: mtime, cwd: cwd ?? null, branch: branch ?? null,
  };
}

/** Every session: the run folders' logs, and each Lead's process with its transcript copies. */
export function gatherSessions({ runs, state, now, clones = new Map(), live = runLive, processes = psList, branchOf = branchIn, originOf = originIn, origins = new Map() }) {
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
        record, role, name: `${issue ?? folder}-${tag}`, issue: issue ? Number(issue) : null, folder, seat, live: isLive,
        mtime: st.mtimeMs, start: record?.start ? Date.parse(record.start) : st.birthtimeMs, cwd,
        repo: record?.repo ?? (cwd ? originCached(cwd) : null) ?? repoOfCwd(cwd, clones), branch: record?.branch ?? (isLive ? branchOf(cwd) : null), harness: 'claude -p', now,
      }));
    }
  }
  for (const proc of processes()) {
    const m = /(?:^|\s)--name\s+(\S+)-lead(?:\s|$)/.exec(proc.command);
    if (!m || !/\bclaude\b/.test(proc.command)) continue;
    const dir = join(runs, `${m[1]}-lead`, 'transcripts');
    let newest = null;
    for (const n of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.jsonl')) : []) {
      const s = statSync(join(dir, n));
      if (!newest || s.mtimeMs > newest.mtimeMs) newest = { file: join(dir, n), mtimeMs: s.mtimeMs };
    }
    const repo = [...clones.keys()].find((r) => r.split('/')[1] === m[1]) ?? null;
    const cwd = repo ? clones.get(repo) : null;
    out.push(shape(newest ? parseLog(readText(newest.file)) : parseLog(''), {
      record: null, role: 'lead', name: `${m[1]}-lead`, issue: null, folder: null, seat: null, live: true,
      mtime: newest?.mtimeMs ?? now, start: null, cwd, repo, branch: branchOf(cwd), harness: 'claude', now,
    }));
  }
  // One run folder is one issue, and one issue sits under one repository: a run with none takes the one its folder's other runs have.
  for (const s of out) {
    if (s.repo || !s.folder) continue;
    const known = new Set(out.filter((o) => o.folder === s.folder && o.repo).map((o) => o.repo));
    if (known.size === 1) s.repo = [...known][0];
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
function groupOf(repo, number, gh, sessions) {
  // No GitHub data at all for this repository: nothing is filled in.
  if (!gh || gh.unknown) {
    return {
      number, title: '?', done: false, active: sessions.some((s) => s.state !== 'gone'), team: null, step: '?', pr: null, unknown: true,
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
    // Shown on All while it has a live session, a claim, an open pull request or a session that ended in the last day.
    active: sessions.some((s) => s.state !== 'gone') || Boolean(held) || Boolean(pr && !merged),
    team: held ?? /^Team: (\S+)/m.exec(pr?.body ?? '')?.[1] ?? null,
    step, pr: pr ? { number: pr.number, checks: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, MARK(c)])) } : null,
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
  const sessions = gatherSessions({ runs, state, now, clones, live: opts.live, processes: opts.processes, branchOf: opts.branchOf, originOf: opts.originOf, origins: cache.origins.map });
  // Every repository a session names has its issues read too, not only the clones.
  const repos = [...new Set([...(opts.repos ?? clones.keys()), ...sessions.map((s) => s.repo).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r ?? ''))])];
  const github = await gatherGithub({ repos, clones, state, claims: opts.claims, now, cache });
  const names = [...new Set([...repos, ...sessions.map((s) => s.repo ?? '?')])];
  const byRepo = names.map((repo) => {
    const mine = sessions.filter((s) => (s.repo ?? '?') === repo);
    const gh = github.repos[repo];
    const numbers = new Set([...(gh?.issues ?? []).map((i) => i.number), ...mine.map((s) => s.issue).filter((n) => n !== null)]);
    const groups = [...numbers].sort((a, b) => a - b).map((n) => groupOf(repo, n, gh, mine.filter((s) => s.issue === n)));
    return { repo, groups, other: mine.filter((s) => s.issue === null), ghStatus: gh?.failedAt ? { failedAt: gh.failedAt, goodAt: gh.goodAt } : null };
  });
  return { now, load: opts.load ?? loadavg(), sessions, repos: byRepo, github, queue: queueOf(state), seats: opts.live ? seatCounts(sessions) : seatsLive(runs) };
}

/** The seats' live sessions as bin/seat counts them for its cap (liveCount). */
const seatsLive = (runs) => Object.fromEntries(Object.entries(SEATS).map(([n, { cap }]) => [n, { live: liveCount(runs, Number(n)), cap }]));

const seatCounts = (sessions) => Object.fromEntries(Object.entries(SEATS).map(([n, { cap }]) => [n, { live: sessions.filter((s) => s.live && s.seat === n).length, cap }]));

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
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
const pad = (s, n) => clip(String(s), n).padEnd(n);

// COST is the session's total across resumes (the last result's total_cost_usd), while TOKENS and TURNS count this log's
// rounds only, so a resumed session's row mixes two spans; a live `~$` estimate counts this log alone.
const COLS = [['NAME', 16], ['ROLE', 10], ['STATE', 26], ['HARNESS', 9], ['MODEL', 18], ['SEAT', 5], ['CTX', 8], ['TURNS', 6], ['TOKENS ↓/↑', 14], ['COST', 8], ['AGE', 7], ['SINCE', 7]];
const tail = (cwd) => (cwd ? cwd.split(sep).filter(Boolean).slice(-2).join('/') : '?');

function sessionRow(s, now, indent, width) {
  const model = s.model ? `${s.model.replace(/^claude-/, '')} ${s.effort ?? '?'}` : '?';
  const cost = s.cost !== null ? `$${s.cost.toFixed(2)}` : s.estCost !== null && s.estCost !== undefined ? `~$${s.estCost.toFixed(2)}` : '?';
  const cells = [
    `${' '.repeat(indent)}${s.name}`, s.role, s.stopped ? `stopped ${s.stopped}` : s.state, s.harness, model, s.seat ?? '?', kilo(s.ctx), s.turns ?? '?',
    s.tokensIn === null ? '?' : `${kilo(s.tokensIn)}/${kilo(s.tokensOut)}`, cost, s.startedAt ? age(now - s.startedAt) : '?', age(now - s.lastAt),
  ];
  return clip(`${cells.map((c, i) => pad(c, COLS[i][1])).join(' ')} ${tail(s.cwd)} ${s.branch ?? '?'}`, width);
}

function groupRow(g, width) {
  const pr = g.pr ? `PR #${g.pr.number} ${Object.entries(g.pr.checks).map(([k, v]) => `${k}${v}`).join(' ')}` : g.unknown ? 'PR ?' : 'no PR';
  return clip(`  #${g.number} ${clip(g.title, 40)}  team ${g.unknown ? '?' : (g.team ?? '–')}  step ${g.step}  ${pr}  waiting on ${g.waiting}`, width);
}

/** The tabs: All, one for each repository (name and the sessions it shows), Done (the issues). */
export function tabsOf(snap) {
  const shown = (r) => r.groups.filter((g) => !g.done).flatMap((g) => g.sessions).concat(r.other).filter((s) => s.state !== 'gone');
  return [
    { label: 'All', kind: 'all' },
    ...snap.repos.filter((r) => r.repo !== '?' || r.other.length || r.groups.length).map((r) => ({ label: `${r.repo.split('/').pop()} ${shown(r).length}`, kind: 'repo', repo: r.repo })),
    { label: `Done ${snap.repos.reduce((n, r) => n + r.groups.filter((g) => g.done).length, 0)}`, kind: 'done' },
  ];
}

/** One frame as text, no colour, each line at most width characters. tab indexes tabsOf(snap). */
export function render(snap, { width = 120, tab = 0, rows = null } = {}) {
  const { sessions, queue, github, now } = snap;
  const count = (st) => sessions.filter((s) => s.state === st).length;
  const seats = Object.entries(snap.seats).map(([n, s]) => `${n}:${Number.isFinite(s.live) ? s.live : '?'}/${s.cap}`).join(' ');
  const q = queue.lastSweep ? `${queue.queueFailed ? 'failed, last ok' : 'ok'} ${stamp(Date.parse(queue.lastSweep))}` : '?';
  const ghText = github.ok ? `gh ok ${age(now - github.at)} ago` : `gh failed (${github.error})`;
  const lines = [
    clip(`factory top  load ${snap.load.map((x) => x.toFixed(2)).join(' ')}  ${count('working')} working ${count('idle')} idle ${count('stopped')} stopped  seats ${seats}  queue ${q}  alerts ${queue.failed.length}  ${ghText}`, width),
  ];
  const tabs = tabsOf(snap);
  lines.push(clip(tabs.map((t, i) => `${i === tab ? '▸' : ''}[${i + 1} ${t.label}]`).join(' '), width));
  lines.push(clip('accounts: not shown yet; it waits for #178\'s accounts file', width));
  lines.push(clip(COLS.map(([h, w]) => h.padEnd(w)).join(' ') + ' CWD BRANCH', width));
  const t = tabs[tab] ?? tabs[0];
  for (const r of snap.repos) {
    if (t.kind === 'repo' && r.repo !== t.repo) continue;
    const done = t.kind === 'done';
    // The newest DONE_MAX closed issues; the rest, and on the other tabs the issues with nothing going on, fold into "N older".
    const listed = done ? r.groups.filter((g) => g.done).sort((a, b) => b.number - a.number) : r.groups.filter((g) => !g.done && g.active);
    const groups = listed.slice(0, done ? DONE_MAX : listed.length);
    const older = done ? listed.length - groups.length : r.groups.filter((g) => !g.done && !g.active).length;
    const own = done ? [] : r.other;
    if (!groups.length && !own.length && !older) continue;
    const st = r.ghStatus;
    lines.push(clip(st ? `${r.repo}  gh failed ${hhmm(st.failedAt)}, ${st.goodAt ? `showing ${hhmm(st.goodAt)}` : 'nothing read yet'}` : r.repo, width));
    const fold = (all, indent) => {
      const gone = all.filter((s) => s.state === 'gone').length;
      if (gone) lines.push(`${' '.repeat(indent)}${gone} gone`);
    };
    for (const s of own.filter((x) => x.state !== 'gone')) lines.push(sessionRow(s, now, 2, width));
    fold(own, 2);
    for (const g of groups) {
      lines.push(groupRow(g, width));
      for (const s of g.sessions.filter((x) => x.state !== 'gone')) lines.push(sessionRow(s, now, 4, width));
      fold(g.sessions, 4);
    }
    if (older) lines.push(`  ${older} older`);
  }
  // With the terminal's rows, the header, tabs, accounts line and column header stay and the tree is cut to fit, the last row
  // saying how much was left out; without them (--once) the whole frame is printed.
  const fixed = 4;
  if (rows && lines.length + 1 > rows) {
    const room = Math.max(0, rows - fixed - 1);
    const left = lines.length - fixed - room;
    return [...lines.slice(0, fixed + room), clip(`… ${left} more rows (a repository's tab shows fewer); 1-9 or Tab tabs, q quits`, width)].map(clean).join('\n');
  }
  lines.push(clip('keys: 1-9 or Tab switch tabs, q quits', width));
  return lines.map(clean).join('\n');
}

/** A string from a log, a folder or GitHub, less its control characters, so none can reach the terminal as an escape sequence. */
const clean = (s) => s.replace(/[\x00-\x1f\x7f]/g, '');

async function loop(opts) {
  const out = process.stdout;
  const cache = {};
  let snap = null;
  let tab = 0;
  let busy = false;
  const draw = () => {
    if (!snap) return;
    const text = render(snap, { width: out.columns ?? 120, tab, rows: out.rows ?? null }).split('\n').map((l) => `${l}\x1b[K`).join('\n');
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
    if (key === '\t') tab = (tab + 1) % count;
    else if (/^[1-9]$/.test(key) && Number(key) <= count) tab = Number(key) - 1;
    draw();
  });
  await tick();
}

export async function main(argv) {
  const width = argv.includes('--width') ? Number(argv[argv.indexOf('--width') + 1]) : null;
  if (argv.includes('--once')) {
    const snap = await snapshot({});
    process.stdout.write(`${render(snap, { width: width ?? process.stdout.columns ?? 200 })}\n`);
    return;
  }
  if (!process.stdin.isTTY) throw new Error('needs a terminal; use --once for one frame');
  await loop({});
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`factory top: ${firstLine(error)}`);
    process.exitCode = 1;
  });
}
