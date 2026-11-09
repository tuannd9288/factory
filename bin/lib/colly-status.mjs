// Colly status text and shared session readers (#429).
// --line and --brief share top-github.json, preserving the existing cache and deadlines.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stateOf as claimStateOf } from '../../kit/.gate/bin/lib/claim.mjs';
import { readMarkers } from './status.mjs';
import { writeAtomic } from './files.mjs';
import { hookStateOf, parseLog } from './claude-code.mjs';
import { REQUIRED } from './ledger.mjs';
import { readSessions } from './records.mjs';
import { byName, cloneRepo, clonesUnder } from './repos.mjs';
import { PS } from './ps.mjs';
import { PRESETS, resetPassed, runLive } from './seat.mjs';
import { TEAM, parseTeam } from './names.mjs';

// Moved to claude-code.mjs (INN-39 item 3) and exported here too while callers still import it from here.
export { parseLog };

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const GH_MS = 60_000;
const CALL_MS = 15_000;
const WORKING_MS = 120_000;
const GONE_MS = 24 * 3600_000;
const LOGIN_MS = 60_000;
const ROLE_ORDER = ['lead', 'worker', 'reviewer', 'researcher'];

/** The Lead's state from state.json's event and its process: { state, stateAt, waitNote? }, or null to leave it to the log. An event
 * older than the process belongs to an earlier session. A process that carries the new SessionStart hook, is over a minute old and
 * has run none of its hooks waits at the login or the folder trust. That is an inference: whether SessionStart fires only after the
 * trust dialog has not been seen yet; it is seen at zalo-gateway's first Lead start. A Lead started before the hook existed never
 * gets this line. */
export function leadStateOf({ event, command, ageMs, now }) {
  const at = event ? Date.parse(event.at) : NaN;
  if (Number.isFinite(at) && (ageMs == null || at >= now - ageMs)) {
    const state = hookStateOf(event);
    return state ? { state, stateAt: at } : null;
  }
  return /"SessionStart"/.test(command) && ageMs > LOGIN_MS ? { state: 'waiting', waitNote: 'login or folder trust?' } : null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
  return cloneRepo(cwd, 5000);
}

/** ps's elapsed time ([[dd-]hh:]mm:ss) in milliseconds; null for anything else. */
export function etimeMs(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text ?? '');
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000 : null;
}

/** The processes as { pid, ageMs, command }, from ps; throws when ps is not here or cannot run (the events step needs to tell that
 * from no process). */
export function readProcesses() {
  return execFileSync(PS, ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .flatMap((l) => {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      return m ? [{ pid: Number(m[1]), ageMs: etimeMs(m[2]), command: m[3] }] : [];
    });
}

/** The same, with [] when ps cannot run: what the view shows. */
function psList() {
  try {
    return readProcesses();
  } catch {
    return [];
  }
}

/** The repository and team a process is the Lead of, or null: a `claude` command with `--name <repo>-<team>` (packs/pstack/bin/lead),
 * split at the last `-`, the team in the grammar (#196). */
export function leadOf(command) {
  const m = /(?:^|\s)--name\s+(\S+)-([^-\s]+)(?:\s|$)/.exec(command);
  return m && TEAM.test(m[2]) && /\bclaude\b/.test(command) ? { repo: m[1], team: m[2] } : null;
}

/** The teams whose Lead runs on a repository, sorted: the rule `factory use` restarts a Lead by (#179). */
export const leadTeams = (repo, processes = psList) => [...new Set(processes().map((p) => leadOf(p.command)).filter((l) => l?.repo === repo).map((l) => l.team))].sort();

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

/** A time as local HH:MM, or MM-DD HH:MM when it is not on the day of now; ? for none. */
export function local(ms, now) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '?';
  const d = new Date(ms);
  return startOfDay(ms) === startOfDay(now) ? hm(ms) : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm(ms)}`;
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

/** parseLog of a log, reused while its size and modification time are those of the last read. `st` is its stat, taken before the
 * read, so a log that grew meanwhile reads again next time. `seen` collects the entries this pass used; the caller keeps only those. */
function parsedLog(file, st, old, seen) {
  const was = old?.get(file);
  const entry = was && was.size === st.size && was.mtimeMs === st.mtimeMs ? was : { size: st.size, mtimeMs: st.mtimeMs, parsed: parseLog(readText(file)) };
  seen?.set(file, entry);
  return entry.parsed;
}

/** sessions.jsonl's records; with a cache, the last read while the file's size and modification time are unchanged. */
export function sessionRecords(state, cache = null) {
  if (!cache) return readSessions(state);
  let st;
  try {
    st = statSync(join(state, 'sessions.jsonl'));
  } catch {
    cache.records = null;
    return [];
  }
  if (!cache.records || cache.records.size !== st.size || cache.records.mtimeMs !== st.mtimeMs) cache.records = { size: st.size, mtimeMs: st.mtimeMs, list: readSessions(state) };
  return cache.records.list;
}

/** Every session: the run folders' logs, and each Lead's process with its transcript copies. `cache` (snapshot's) keeps each log's
 * parse and the records between calls; a log that is gone is dropped from it at the end of the pass. */
export function gatherSessions({ runs, state, now, root = null, clones = new Map(), live = runLive, processes = psList, branchOf = branchIn, originOf = originIn, origins = new Map(), cache = null }) {
  const oldLogs = cache?.logs ?? null;
  const seenLogs = cache ? new Map() : null;
  // A work folder's origin, asked of git once for as long as `origins` lives (the caller clears it at each GitHub refresh).
  const originCached = (cwd) => {
    if (!origins.has(cwd)) origins.set(cwd, originOf(cwd));
    return origins.get(cwd);
  };
  const records = lastRecords(sessionRecords(state, cache));
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
      if (!m) continue;
      const tag = m[1];
      const file = join(dir, n);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const record = records.get(`${dir}#${tag}`) ?? null;
      const p = parsedLog(file, st, oldLogs, seenLogs);
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
      if (!newest || s.mtimeMs > newest.mtimeMs) newest = { file: join(dir, n), mtimeMs: s.mtimeMs, st: s };
    }
    const repo = byName(clones.keys(), repoName);
    const cwd = repo ? clones.get(repo) : null;
    let event = null;
    try {
      event = JSON.parse(readText(join(leadDir, 'state.json')));
    } catch {
      // no state yet: the log gives the state
    }
    out.push(shape(newest ? parsedLog(newest.file, newest.st, oldLogs, seenLogs) : parseLog(''), {
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
    s.repo = m?.[1] === 'issue' ? (root ? originCached(root) : null) : byName(names, m?.[1]);
  }
  if (cache) cache.logs = seenLogs;
  const rank = (s) => ROLE_ORDER.indexOf(s.role) === -1 ? ROLE_ORDER.length : ROLE_ORDER.indexOf(s.role);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** The conditions of #309 that began and still hold and that this view does not list itself (a check that never started, an issue
 * labelled needs-human, a refused gh), as the sweep keeps them in events-active.json (bin/lib/events.mjs, which writes it). */
export function eventsOf(state) {
  try {
    const a = JSON.parse(readText(join(state, 'events-active.json')));
    return Object.values(a.conditions ?? {}).filter((c) => c.started && c.top).map((c) => ({ kind: c.kind, text: String(c.text), url: c.url ?? null }));
  } catch {
    return [];
  }
}

/** The queue's and the alerts' state: the time in the newest `queue-*.ok`, the `queue-*.failed` files, every `*.failed` file. */
export function queueOf(dir) {
  const markers = readMarkers(dir) ?? [];
  const oks = markers.filter((m) => m.kind === 'ok' && m.name.startsWith('queue-')).map((m) => m.line).filter(Boolean).sort();
  const failed = markers.filter((m) => m.kind === 'failed').map((m) => ({ file: m.file, text: m.line }));
  return { lastSweep: oks.at(-1) ?? null, queueFailed: failed.filter((f) => f.file.startsWith('queue-')).length, failed };
}

const ghJson = async (args) => JSON.parse((await run('gh', args, { encoding: 'utf8', timeout: CALL_MS, maxBuffer: 64 << 20 })).stdout);
const firstLine = (e) => String(e.stderr || e.message || e).trim().split('\n')[0].slice(0, 80);

// The git options of the trusted jobs (kit/.gate/bin/lib/claim.mjs JOB_NET): gh's helper carries the agents' login.
const NET = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

/** The claims on a repository as `claim --list` reads them: the tip of each refs/heads/claim/<n>, by its subject. The URL is
 * built from the repository's name alone, never asked of a clone, whose config a worker can write; a test points it at a local
 * folder with git's own url.<folder>.insteadOf. Every git call runs in a bare repository of the view's own,
 * `<state>/top/<owner>-<name>.git`, made on first use, so that only its config applies and nothing is written into a clone or the
 * folder the view runs from; `--` ends the options before the URL. */
export async function readClaims(repo, state) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not owner/name: ${JSON.stringify(repo)}`);
  const url = `https://github.com/${repo}.git`;
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

// GitHub's last read, shared by every process that runs a view (#365): `--line` is a new process each minute, and two views open at
// once would each call GitHub. It is one JSON file in the state folder, written through a temporary file and a rename; a Map (the
// claims) is kept as { $map: [[k, v]...] }.
const GH_FILE = 'top-github.json';
const mapOut = (_, v) => (v instanceof Map ? { $map: [...v] } : v);
const mapIn = (_, v) => (v && typeof v === 'object' && Array.isArray(v.$map) ? new Map(v.$map) : v);

function readSharedGithub(state) {
  try {
    const f = JSON.parse(readText(join(state, GH_FILE)), mapIn);
    return f?.data && Number.isFinite(f.data.at) && f.data.repos ? { data: f.data, good: f.good ?? {} } : null;
  } catch {
    return null;
  }
}

function writeSharedGithub(state, data, good) {
  try {
    mkdirSync(state, { recursive: true });
    writeAtomic(join(state, GH_FILE), JSON.stringify({ data, good }, mapOut), { mode: 0o600 });
  } catch {
    // a view that cannot write the file reads GitHub again next time
  }
}

/** The in-flight claim of one GitHub read: a folder `top-github.lock` made with mkdir (one process wins), as events.mjs's lock is. A read
 * ends within a few CALL_MS, so a claim older than 2 × CALL_MS is a dead reader's and is taken over. Returns its release, or null while
 * another process holds it. */
function takeRead(state) {
  try {
    mkdirSync(state, { recursive: true });
    const lock = join(state, 'top-github.lock');
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        mkdirSync(lock);
        return () => rmSync(lock, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'EEXIST') return () => {};
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs <= 2 * CALL_MS) return null;
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // the holder just finished: try the claim again
      }
    }
  } catch {
    return () => {};
  }
  return null;
}

/** The shared file's last read, whatever its age, with `?` for a repository it lacks: what a process shows that must not call GitHub. */
function lastRead(state, repos, now) {
  const data = readSharedGithub(state)?.data ?? { ok: false, error: 'GitHub was not read in time', at: now, repos: {} };
  for (const repo of repos) data.repos[repo] ??= { unknown: true, issues: [], prs: [], claims: new Map(), claimsOk: false, required: ['verify'], failedAt: now, goodAt: null };
  return data;
}

/** A pull request's body kept to the lines this view reads (`Issue:` and `Team:`), so that the shared file holds no more. */
const keptBody = (body) => String(body ?? '').split('\n').filter((l) => /^(Issue|Team): /.test(l)).join('\n');

/** Per repository, the last good read that is newer. */
const newerGood = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((r) => [r, (a[r]?.at ?? -1) >= (b[r]?.at ?? -1) ? a[r] : b[r]]));

/** Issues, pull requests and claims of the repositories, at most once a minute (cache holds the last read). A call that
 * fails gives its first line and the rest still shows. With `shared`, the last read is also kept in the state folder, so that
 * another process within the minute reuses it, and a failed read there keeps the last good one too. */
export async function gatherGithub({ repos, clones, state, claims = readClaims, now, cache = {}, shared = false, offline = false }) {
  // The deadline passed (#365): no GitHub call.
  if (offline) return lastRead(state, repos, now);
  if (cache.data && now - cache.at < GH_MS) return cache.data;
  let release = null;
  if (shared) {
    const adopt = () => {
      const file = readSharedGithub(state);
      if (!file) return null;
      cache.good = newerGood(file.good, cache.good);
      if (now >= file.data.at && now - file.data.at < GH_MS && repos.every((r) => file.data.repos[r])) {
        cache.data = file.data;
        cache.at = file.data.at;
        return file.data;
      }
      return null;
    };
    const fresh = adopt();
    if (fresh) return fresh;
    // One read in flight for all processes: while another holds the claim, show the last read and call nothing.
    release = takeRead(state);
    if (!release) return lastRead(state, repos, now);
    const meanwhile = adopt();
    if (meanwhile) {
      release();
      return meanwhile;
    }
  }
  try {
    return await readGithub({ repos, clones, state, claims, now, cache, shared });
  } finally {
    release?.();
  }
}

async function readGithub({ repos, clones, state, claims, now, cache, shared }) {
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
      const entry = { issues, prs: prs.map((p) => ({ ...p, body: keptBody(p.body) })), claims: held, claimsOk, required };
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
  if (shared) writeSharedGithub(state, data, good);
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
      number, title: '?', done: false, team: null, step: '?', pr: null, unknown: true,
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
  // The kit runs no review job since FAC-100; a repository still on the kit before it runs its own until FAC-102 moves it, and that job
  // is not among the kit's required checks, so it is read from the rollup.
  const oldReview = (pr?.statusCheckRollup ?? []).filter((c) => c.name === 'review').at(-1);
  let waiting = '–';
  if (pr && !merged) {
    if (labels.some((l) => l === 'tier-3' || l === 'needs-human') && checks.tier && checks.tier.status === 'COMPLETED' && checks.tier.conclusion !== 'SUCCESS') waiting = 'the Human';
    else if (pr.reviewDecision === 'REVIEW_REQUIRED' && gh.required.every((n) => MARK(checks[n]) === '✓')) waiting = 'the Human';
    else if (oldReview && oldReview.status !== 'COMPLETED') waiting = 'the reviewer';
  }
  if (waiting === '–' && sessions.some((s) => s.live)) waiting = 'the team';
  return {
    number, title: issue?.title ?? '?',
    done: closed,
    team: held ?? /^Team: (\S+)/m.exec(pr?.body ?? '')?.[1] ?? null,
    step, pr: pr ? { number: pr.number, title: pr.title, checks: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, MARK(c)])) } : null,
    waiting, sessions,
  };
}

/** The sessions, issues and waits for Colly, read now. `cache` keeps GitHub's last read between calls. */
export async function snapshot(opts = {}) {
  const home = process.env.HOME ?? homedir();
  const now = opts.now ?? Date.now();
  const runs = opts.runs ?? process.env.FACTORY_RUNS ?? join(home, 'factory-runs');
  const state = opts.state ?? process.env.FACTORY_STATE ?? join(home, '.local/state/factory');
  const root = opts.root ?? process.env.FACTORY_ROOT ?? join(here, '..', '..');
  const clones = opts.clones ?? clonesUnder(root);
  const cache = opts.cache ?? {};
  if (!cache.origins || now - cache.origins.at >= GH_MS) cache.origins = { at: now, map: new Map() };
  const sessions = gatherSessions({ runs, state, now, root, clones, live: opts.live, processes: opts.processes, branchOf: opts.branchOf, originOf: opts.originOf, origins: cache.origins.map, cache: opts.cache ? cache : null });
  // Every repository a session names has its issues read too, not only the clones.
  const repos = [...new Set([...(opts.repos ?? clones.keys()), ...sessions.map((s) => s.repo).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r ?? ''))])];
  const github = await gatherGithub({ repos, clones, state, claims: opts.claims, now, cache, shared: Boolean(opts.shared), offline: Boolean(opts.offline) });
  const byRepo = [...new Set([...repos, ...sessions.map((s) => s.repo).filter(Boolean)])].map((repo) => {
    const mine = sessions.filter((s) => s.repo === repo);
    const gh = github.repos[repo];
    const numbers = new Set([...(gh?.issues ?? []).map((i) => i.number), ...mine.map((s) => s.issue).filter((n) => n !== null)]);
    const groups = [...numbers].sort((a, b) => a - b).map((n) => groupOf(repo, n, gh, mine.filter((s) => s.issue === n)));
    return { repo, groups, other: mine.filter((s) => s.issue === null), ghStatus: gh?.failedAt ? { failedAt: gh.failedAt, goodAt: gh.goodAt } : null };
  });
  return {
    now, state, sessions, repos: byRepo, github, queue: queueOf(state), events: eventsOf(state),
  };
}

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

const EVENT_VERBS = { 'check-not-started': 'check', 'waiting-on-human': 'answer', 'gh-refused': 'alert', 'switch-moved': 'alert' };

/** A string from a log, a folder or GitHub, less its control characters, so none can reach the terminal as an escape sequence. */
const clean = (s) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const cleanDeep = (v) => (typeof v === 'string' ? clean(v) : Array.isArray(v) ? v.map(cleanDeep) : v && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)])) : v);

/** What waits on the Human, as { kind, verb, text, url } in display order: pull requests to approve, Leads at a prompt or a login,
 * the sweep's conditions, the `*.failed` files. Both `--line` and `--brief` read it after cleaning strings. */
export function waitsOf(snap) {
  const { sessions, queue, now } = snap;
  return [
    ...snap.repos.flatMap((r) => r.groups.filter((g) => !g.done && g.pr && g.waiting === 'the Human').map((g) => ({ kind: 'pr', verb: 'approve', text: `${r.repo}#${g.pr.number} ${g.pr.title}`, url: `https://github.com/${r.repo}/pull/${g.pr.number}` }))),
    ...sessions.filter((s) => s.role === 'lead' && s.state === 'waiting').map((s) => ({ kind: 'lead', verb: 'answer', text: `${s.name} (${s.repo?.split('/')[1] ?? '?'} Lead, team ${s.team})  pane ${s.pane ?? s.name}${s.waitNote ? `  ${s.waitNote}` : ''}`, url: '' })),
    ...(snap.events ?? []).map((c) => ({ kind: 'condition', verb: EVENT_VERBS[c.kind] ?? 'look', text: c.text, url: c.url ?? '' })),
    ...queue.failed.map((f) => ({ kind: 'failed', verb: 'alert', text: `${f.file}  ${f.text.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z/, (iso) => local(Date.parse(iso), now))}`, url: '' })),
  ];
}

/** `snap` with every data field cleaned of control characters. */
const cleanSnap = (input) => ({ ...input, sessions: cleanDeep(input.sessions), repos: cleanDeep(input.repos), queue: cleanDeep(input.queue), events: cleanDeep(input.events ?? []), github: { ...input.github, error: clean(input.github.error ?? '') } });

/** The teams that work now, as a set of `<repo>/<team>`: a Lead that runs, and a live session of a seat, under the team its record or
 * its issue's claim names (else its issue). */
function teamsWorking(snap) {
  const keys = new Set();
  const claimed = (repo, n) => snap.repos.find((r) => r.repo === repo)?.groups.find((g) => g.number === n)?.team ?? null;
  for (const s of snap.sessions) {
    if (!s.live) continue;
    if (s.role === 'lead') keys.add(`${s.repo ?? '?'}/${s.team}`);
    else keys.add(`${s.repo ?? '?'}/${parseTeam(s.recordTeam)?.team ?? claimed(s.repo, s.issue) ?? `#${s.issue ?? s.name}`}`);
  }
  return keys;
}

/** `factory colly --line` (#365): the one line under Colly's prompt, in at most `width` cells, plain text. Counts of what waits on the
 * Human (pull requests to approve, Leads at a prompt or a login, alerts) and of the teams at work; a part that is zero is left out, and
 * with GitHub unread and nothing cached the pull requests are `?`. A line too wide loses whole parts from the right. */
export function lineOf(input, { width = 80 } = {}) {
  const snap = cleanSnap(input);
  const waits = waitsOf(snap);
  // Counted by where a wait comes from, not by the frame's verb: a #309 condition (an issue labelled needs-human is `answer` there) is an alert.
  const count = (kind) => waits.filter((w) => w.kind === kind).length;
  const approve = Object.values(snap.github.repos).some((r) => r.unknown) ? '?' : count('pr');
  const prompts = count('lead');
  const alerts = waits.length - count('pr') - prompts;
  const teams = teamsWorking(snap).size;
  const parts = [
    approve === 0 && !prompts && !alerts ? 'Nothing waits on you' : null,
    approve ? `${approve} to approve` : null,
    prompts ? `${prompts} Lead${prompts === 1 ? '' : 's'} waiting` : null,
    alerts ? `${alerts} alert${alerts === 1 ? '' : 's'}` : null,
    teams ? `${teams} team${teams === 1 ? '' : 's'} working` : null,
  ].filter(Boolean);
  while (parts.length > 1 && cells(parts.join(' · ')) > width) parts.pop();
  return cutWord(parts.join(' · '), width);
}

// The most `--brief` prints for each block, its header and its "more" line included, so the whole text stays near 30 lines.
const BRIEF_MAX = { waits: 10, teams: 11, events: 8 };
const BRIEF_EVENTS = 5;

/** A block of lines cut to `max`, the last one saying how many were left out. */
const capped = (lines, max, what) => (lines.length <= max ? lines : [...lines.slice(0, max - 1), `  … ${lines.length - (max - 1)} more ${what}`]);

/** The teams of each repository for the brief: the Lead of each team with its state, and the issues the team holds (a claim, or an open
 * pull request that names it), one line each. */
function teamLines(snap) {
  const lines = [];
  for (const r of [...snap.repos].sort((a, b) => a.repo.localeCompare(b.repo))) {
    const leads = r.other.filter((s) => s.role === 'lead');
    const held = r.groups.filter((g) => !g.done && g.team && (g.step === 'claimed' || g.step === 'PR open'));
    for (const team of [...new Set([...leads.map((l) => l.team), ...held.map((g) => g.team)])].sort()) {
      const lead = leads.find((l) => l.team === team);
      const mine = held.filter((g) => g.team === team).sort((a, b) => a.number - b.number);
      const issues = mine.slice(0, 4).map((g) => `#${g.number} ${clip(g.title, 40)}`).join(', ') + (mine.length > 4 ? `, +${mine.length - 4}` : '');
      lines.push(`  ${r.repo.split('/')[1]} ${team}: ${lead ? `Lead ${({ waiting: 'waiting', failed: 'failed', stopped: 'out of quota', working: 'working', idle: 'idle', done: 'done', gone: 'gone' }[lead.state] ?? String(lead.state))}` : 'no Lead running'}${issues ? `; ${issues}` : '; no issue held'}`);
    }
  }
  return lines;
}

/** `factory colly --brief` (#365): the text of Colly's start hook. What waits on the Human, the teams of each
 * repository with the issues they hold, and the `start` events after `after` (the newest few with none), read as bin/factory-events does
 * without --follow and never touching its cursor. The last line is `seq <n>`, which the hook keeps so that Colly's
 * Monitor starts with `--after <n>`: the highest seq in the events file (0 with none), or, when the events block is cut, the seq of the
 * last event printed, so that the Monitor delivers the events left out. */
export async function briefOf(input, { after = null } = {}) {
  const { readLines } = await import('./events.mjs');
  const snap = cleanSnap(input);
  const all = readLines(input.state);
  const starts = all.filter((e) => e.type === 'start' && (after === null ? true : e.seq > after));
  let shown = after === null ? starts.slice(-BRIEF_EVENTS) : starts;
  // Events stay in seq order, oldest first. A block too long ends with how many come after, and `seq` is then the last one printed, so
  // that the Monitor Colly starts with `--after <seq>` delivers the rest; with none cut it is the highest.
  const fits = BRIEF_MAX.events - 1;
  const cut = shown.length > fits ? shown.length - (fits - 1) : 0;
  if (cut) shown = shown.slice(0, fits - 1);
  const seq = cut ? shown.at(-1).seq : Math.max(0, ...all.map((e) => e.seq));
  const eventLines = [...shown.map((e) => `  #${e.seq} ${local(Date.parse(e.at), snap.now)} ${e.kind}  ${clean(String(e.text))}`), ...(cut ? [`  … ${cut} more start events after seq ${seq}`] : [])];
  const waits = waitsOf(snap).map((w) => `  ${w.verb.padEnd(7)}  ${w.text}${w.url ? `  ${w.url}` : ''}`);
  const teams = teamLines(snap);
  return [
    ...(waits.length ? capped(['Waiting on you', ...waits], BRIEF_MAX.waits, 'waiting') : ['Nothing waits on you']),
    ...(teams.length ? capped(['Teams', ...teams], BRIEF_MAX.teams, 'teams') : ['No team at work']),
    ...(eventLines.length ? [after === null ? 'Newest events' : `Events after seq ${after}`, ...eventLines] : [after === null ? 'No events yet' : `No events after seq ${after}`]),
    `seq ${seq}`,
  ].join('\n');
}

// The overall deadlines of the two text modes (#365), in milliseconds; each GitHub call keeps CALL_MS.
export const LINE_MS = 10_000;
export const BRIEF_MS = 20_000;

/** The text of `--line` or `--brief` within a deadline. When the snapshot is not ready by then, the text is made from a second one that
 * calls no GitHub: the shared file's last read, or `?` where GitHub must give a count; `late` says so. The first read goes on and may
 * still write the file, but never delays the text. `opts` goes to snapshot (tests). */
export async function textOf(mode, { width = 80, after = null, deadlineMs = mode === 'line' ? LINE_MS : BRIEF_MS, opts = {} } = {}) {
  const make = (snap) => (mode === 'line' ? lineOf(snap, { width }) : briefOf(snap, { after }));
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  const reading = snapshot({ shared: true, ...opts });
  reading.catch(() => {});
  try {
    const snap = await Promise.race([reading, expired]);
    if (snap) return { text: await make(snap), late: false };
  } finally {
    clearTimeout(timer);
  }
  return { text: await make(await snapshot({ shared: true, ...opts, offline: true })), late: true };
}

export async function main(argv) {
  const width = argv.includes('--width') ? Number(argv[argv.indexOf('--width') + 1]) : null;
  if (argv.includes('--line') || argv.includes('--brief')) {
    const i = argv.indexOf('--after');
    const mode = argv.includes('--line') ? 'line' : 'brief';
    const { text, late } = await textOf(mode, { width: width ?? (Number(process.env.COLUMNS) || 80), after: i === -1 ? null : Number(argv[i + 1]) });
    // A GitHub read still running would hold the process open: the text is out, so end it (a read that finishes first has written the cache).
    process.stdout.write(`${text}\n`, () => late && process.exit(0));
    return;
  }
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`factory colly: ${firstLine(error)}`);
    process.exitCode = 1;
  });
}
