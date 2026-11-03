// The sweep's wake of a Lead on its news (#370), with no gh call of its own: the queue's one GraphQL query (QUERY in bin/lib/queue.mjs) also
// returns each open pull request's body and `mergeable` and a few merged pull requests, the most recently updated (MERGED_FIELDS). One-time `start`
// lines to the events (#309, appendStart, as the comment wake writes its `comment` line: no condition, never cleared) and one line into the
// Lead's inbox socket (bin/lib/wake.mjs, newsLine), whose path the Lead's hook recorded in <runs>/<folder>-<team>/socket. The kinds, each
// with its key:
//   seat-ended      a sessions.jsonl record ended with a structured result           run and tag
//   seat-no-result  a record ended with none, or a run-<tag>.pid whose process is    run and tag
//                   gone, with no record for it, for SEAT_GRACE_MS (runLive decides)
//   checks-red      the first required check of an open pull request's head to fail  pull request and head
//                   (`tier` is left out only while the pull request carries tier-3 or needs-human, when it waits on the Human)
//   checks-green    every required check of the head succeeded                       pull request and head
//   conflict        `mergeable` is CONFLICTING (UNKNOWN, which GitHub says for a while after a push, is none)   pull request and head
//   merged          the pull request merged                                          pull request
// The six lines are the Lead's, not Colly's: bin/factory-events leaves them out (NEWS_KINDS) and `--news` prints only them.
// A check-not-started condition's start (events.mjs) wakes the same pull request's Lead too (wakeStarted), once for a pull request in a sweep;
// there is no second detector.
// Which Lead: a seat's record names its team (`<repo>-<team>`); a pull request's is the team that holds its issue's claim (the claim refs
// QUERY reads, the first CLAIMS: a holder past them is not looked up), else the body's `Team:` line, else none, said in the line. A team
// with no socket file on this machine is not woken, and the line says so.
// The delivery is also data on the line (#370, slice 2), for the MacBook's relay (bin/factory-relay), which never parses `text`: `lead`
// (`<folder>-<team>`, or null when none was found), `woke` (whether this host's post went) and, when it did not, `why`, post's reason code
// ('no file', 'refused', 'timed out', 'not ours'...); `what` and `where` are the two parts newsLine is made of. The factory's own
// repository is read for these wakes alone (queue.mjs, leadOnly): its Lead is `factory-<team>`, found by the body's `Team:` line.
// The state is $state/queue-<owner>-<name>.news, { sent: [keys] } of the events that hold at the repository's last sweep, { reds: { key: { check:
// the run that failed } } } and { merged: { key: mergedAt } }, and $state/queue-seats.news, { count, gone: { key: ms first seen gone }, told:
// [keys] }. The first sweep that meets a repository or the seats records what is there and wakes nothing. The state is written, through a
// temporary file and a rename, before any wake, so an event never wakes twice; a post that fails is told in the event's line and not tried
// again. A key leaves `sent` when its event no longer holds, except a conflict while the same head reads UNKNOWN, and a merged one for 14
// days. A red event wakes again on the same head when a check told before fails in a run other than the one told (a re-run that failed again,
// though no sweep saw it not red); the old failed run still counts while a re-run is queued, and a second check failing is no news.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { failedCheck } from './checks.mjs';
import { holders } from './comment-wake.mjs';
import { appendStart, oneLine } from './events.mjs';
import { readSessions } from './records.mjs';
import { runFiles, runLive } from './seat.mjs';
import { newsLine, postSync, recordedPath } from './wake.mjs';

/** The kinds of line this module writes. They are for the Lead, so Colly's Monitor (bin/factory-events) leaves them out and `--news` prints
 * only them (the MacBook's relay reads them so). check-not-started and comment are Colly's and are not here. */
export const NEWS_KINDS = new Set(['seat-ended', 'seat-no-result', 'checks-red', 'checks-green', 'conflict', 'merged']);

/** How many merged pull requests QUERY asks for, the most recently updated: enough for a sweep a minute that is missed for a while. */
export const MERGED = 10;

/** How long a merged pull request's key is kept after the merge, so that it does not wake again if it comes back into the list. */
export const MERGED_KEEP_MS = 14 * 24 * 60 * 60_000;

/** The GraphQL field the sweep adds for the merged pull requests (an alias, since `pullRequests` is asked once already, for the open ones). */
export const MERGED_FIELDS = `merged: pullRequests(states:MERGED,first:${MERGED},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number headRefOid body mergedAt}}`;

/** How long a run's process may be gone, with no record, before the run counts as ended without a result: a supervisor's record is written
 * just before it exits, and a sweep that reads between the two must not call it lost. */
export const SEAT_GRACE_MS = 3 * 60_000;

const readJson = (file) => {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, file);
}

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** The check named `name` of a pull request, an Actions check or another App's. */
const checkOf = (p, name) => p.checks[name] ?? p.apps?.[name];

// What names one run of a check: its id and when it started, as the queue's keyOf does, so a re-run that kept the id is still told apart.
const runOf = (c) => `${c.id ?? ''}:${c.startedAt ?? ''}`;

const HUMAN = new Set(['tier-3', 'needs-human']);

/** The events of a repository from what the sweep read: [{ kind, key, what, where, body, pr, runs?, mergedAt? }] for each open pull
 * request (red, green, conflict) and each merged one the query listed. `required` is the checks main requires. A red event holds `runs`,
 * { check name: the run that failed }, which wakeOnNews compares with the sweep before. A red `tier` is left out only while the pull
 * request waits on the Human (the label tier-3 or needs-human, as pickUpdate and humanWaits decide): otherwise it is a failure the Lead fixes. */
export function detect({ repo, prs, merged = [], required }) {
  const found = [];
  const url = (n) => `https://github.com/${repo}/pull/${n}`;
  for (const p of prs) {
    const at = `${repo}#${p.number} head ${String(p.head).slice(0, 7)}`;
    const base = { body: p.body ?? '', pr: p.number, where: url(p.number) };
    const waits = (p.labels ?? []).some((l) => HUMAN.has(l));
    const red = required.filter((name) => !(name === 'tier' && waits) && failedCheck(p, name));
    if (red.length)
      found.push({ ...base, kind: 'checks-red', key: `checks-red ${repo}#${p.number} ${p.head}`, what: `${at}: required check ${red.join(', ')} failed`, runs: Object.fromEntries(red.map((name) => [name, runOf(checkOf(p, name))])) });
    if (required.length && required.every((name) => checkOf(p, name)?.state === 'SUCCESS'))
      found.push({ ...base, kind: 'checks-green', key: `checks-green ${repo}#${p.number} ${p.head}`, what: `${at}: every required check succeeded` });
    if (p.mergeable === 'CONFLICTING') found.push({ ...base, kind: 'conflict', key: `conflict ${repo}#${p.number} ${p.head}`, what: `${at} conflicts with its base` });
  }
  for (const p of merged)
    found.push({ kind: 'merged', key: `merged ${repo}#${p.number}`, pr: p.number, body: p.body ?? '', where: url(p.number), what: `${repo}#${p.number} merged`, mergedAt: p.mergedAt });
  return found;
}

/** The team a pull request's Lead is: the holder of the claim on the issue its `Issue: #<n>` line names, else its `Team:` line when that is
 * a team's name (a letter, then letters and digits, as holders() and FACTORY_TEAM have it), else null. */
export function teamOfBody(body, held) {
  const issue = /^Issue: #(\d+)\b/m.exec(body ?? '')?.[1];
  return (issue && held.get(Number(issue))) || /^Team: ([a-z][a-z0-9]*)[ \t]*$/m.exec(body ?? '')?.[1] || null;
}

/** Posts `line` to the socket file of `dir` under `runs`; a team with no socket file costs no process. */
function deliver(post, runs, dir, line) {
  const file = join(runs, dir, 'socket');
  return recordedPath(file) === null ? { posted: false, why: 'no file' } : post(file, line);
}

const said = (r) => (r.posted ? 'woken' : r.why === 'no file' ? 'not woken (no socket file on this machine)' : `not woken (${r.why})`);

/** Writes the line of one event and wakes the Lead `dir` (`<folder>-<team>`, or null: none could be named). `where` is where to read.
 * Returns the seq. A failure to write the line is thrown. */
function tell({ state, runs, post, kind, key, what, where, dir }) {
  let how = 'no Lead found for it (no claim holder, no Team: line)';
  // The delivery as data (#370): the MacBook's relay reads these and never the text.
  const extra = { what: oneLine(what), where: oneLine(where), lead: dir ?? null, woke: false };
  if (dir) {
    const r = deliver(post, runs, dir, newsLine(kind, what, where));
    how = `Lead ~/factory-runs/${dir}: ${said(r)}`;
    extra.woke = r.posted;
    if (!r.posted) extra.why = r.why;
  }
  return appendStart({ state, kind, key, text: `${what}; ${how}`, extra });
}

const logFailure = (what, error) => console.log(`queue: the wake for ${what} failed: ${String(error.message).split('\n')[0]}`);

/** The step after a successful read of a repository: wakes for the events of its pull requests that are new since the sweep before.
 * `data` is { prs (with body, mergeable), merged, required, claims (QUERY's claim ref nodes) }; `folder` the clone's folder under the
 * factory root; `post` is passed in for tests. Returns the seqs of the lines it wrote. It throws for a state it cannot write; an event or a
 * post that fails is told on the console. */
export function wakeOnNews({ repo, folder, state, runs, data, post = postSync, now = Date.now() }) {
  const found = detect({ repo, prs: data.prs, merged: data.merged ?? [], required: data.required });
  const file = join(state, `queue-${repo.replace('/', '-')}.news`);
  const kept = readJson(file);
  const sent = new Set(strings(kept?.sent));
  const keys = new Set(found.map((e) => e.key));
  // A conflict stays told while the same head reads UNKNOWN, which GitHub says for a while after the base moves.
  for (const p of data.prs)
    if (p.mergeable === 'UNKNOWN' && sent.has(`conflict ${repo}#${p.number} ${p.head}`)) keys.add(`conflict ${repo}#${p.number} ${p.head}`);
  // A merged pull request stays told while its mergedAt is newer than the oldest of the list, or for MERGED_KEEP_MS, so one that comes
  // back into the list on a comment does not wake again.
  const oldest = Math.min(Infinity, ...(data.merged ?? []).map((p) => Date.parse(p.mergedAt)).filter(Number.isFinite));
  const merged = Object.fromEntries(found.filter((e) => e.kind === 'merged' && e.mergedAt).map((e) => [e.key, e.mergedAt]));
  for (const [key, at] of Object.entries(plain(kept?.merged))) {
    const t = Date.parse(at);
    if (!(key in merged) && (t > oldest || now - t < MERGED_KEEP_MS)) {
      merged[key] = at;
      keys.add(key);
    }
  }
  // A red check run that is not the one told before, of a check told before, is a re-run that failed again: news on the same head.
  const before = plain(kept?.reds);
  const reds = {};
  const again = new Set();
  for (const e of found.filter((f) => f.runs)) {
    const was = plain(before[e.key]);
    reds[e.key] = { ...was, ...e.runs };
    if (Object.entries(e.runs).some(([name, run]) => name in was && was[name] !== run)) again.add(e.key);
  }
  writeJson(file, { sent: [...keys], reds, merged });
  if (!kept) return [];
  const held = holders(data.claims);
  const lines = [];
  for (const e of found.filter((f) => !sent.has(f.key) || again.has(f.key))) {
    try {
      const team = teamOfBody(e.body, held);
      lines.push(tell({ state, runs, post, kind: e.kind, key: e.key, what: e.what, where: e.where, dir: team ? `${folder}-${team}` : null }));
    } catch (error) {
      logFailure(`${repo}#${e.pr}`, error);
    }
  }
  return lines;
}

/** What wakes the Lead of a check-not-started condition (events.mjs) whose start was just written: `condition` is its record, `reads` is
 * { repo -> { prs, claims, folder } } as the sweep read them. Nothing is written to the events, the condition's own line being there; a
 * wake that did not go is told on the console. Returns the result of the post, or null when no Lead could be named. */
export function wakeStarted({ condition, reads, runs, post = postSync, seen = new Set() }) {
  const m = /^check-not-started (\S+)#(\d+) /.exec(condition.key);
  // One wake for each pull request in a sweep, though two of its checks started the condition: `seen` is the sweep's.
  if (!m || seen.has(`${m[1]}#${m[2]}`)) return null;
  seen.add(`${m[1]}#${m[2]}`);
  const d = reads.get(m[1]);
  const p = d?.prs.find((x) => x.number === Number(m[2]));
  const team = p && teamOfBody(p.body, holders(d.claims));
  if (!team) return null;
  const dir = `${d.folder}-${team}`;
  const r = deliver(post, runs, dir, newsLine('check-not-started', condition.text, condition.url ?? `https://github.com/${m[1]}/pull/${m[2]}`));
  if (!r.posted) console.log(`queue: the Lead ~/factory-runs/${dir} was not woken for ${condition.key}: ${said(r)}`);
  return r;
}

/** The team of a run folder `<folder>-<n>` from the claim on issue n, in the repository whose clone folder is `<folder>`: `heldBy` is
 * { folder -> holders map }. */
function teamOfRun(run, heldBy) {
  const m = /^(.+)-(\d+)$/.exec(basename(run));
  const team = m && heldBy.get(m[1])?.get(Number(m[2]));
  return team ? `${m[1]}-${team}` : null;
}

/** The seats' news, once for the host: the records of sessions.jsonl after the count of the sweep before, and the run-<tag>.pid files
 * whose process is gone with no record after them for SEAT_GRACE_MS. `heldBy` is { clone folder -> holders map } of the repositories
 * read this sweep, for a record or a run that names no team. `live` (runLive) and `post` are passed in for tests. Returns the seqs. */
export function wakeOnSeats({ state, runs, heldBy = new Map(), post = postSync, live = runLive, now = Date.now() }) {
  const file = join(state, 'queue-seats.news');
  const kept = readJson(file);
  const records = readSessions(state);
  const pids = runFiles(runs, '.pid').filter((f) => !/\.claim\.pid$/.test(f));
  const ended = (run, tag, since) => records.some((r) => r.tag === tag && r.run && resolve(r.run) === resolve(run) && Date.parse(r.end) >= since - 1000);
  const gone = {};
  const current = [];
  const due = [];
  for (const f of pids) {
    const dir = join(f, '..');
    const tag = basename(f).slice('run-'.length, -'.pid'.length);
    let since;
    try {
      since = Math.floor(statSync(f).mtimeMs);
    } catch {
      continue;
    }
    const key = `${dir} ${tag} ${since}`;
    // The record is read first: liveness costs a ps for each pid that is not known gone, and every run ever made keeps its pid file.
    if (ended(dir, tag, since) || live(f)) continue;
    current.push(key);
    gone[key] = kept?.gone?.[key] ?? now;
    if (kept && !strings(kept.told).includes(key) && now - gone[key] >= SEAT_GRACE_MS) due.push({ dir, tag, key });
  }
  const told = [...strings(kept?.told).filter((k) => current.includes(k)), ...(kept ? due.map((d) => d.key) : current)];
  const fresh = kept && Number.isInteger(kept.count) && kept.count <= records.length ? records.slice(kept.count) : [];
  writeJson(file, { count: records.length, gone: Object.fromEntries(Object.entries(gone).filter(([k]) => !told.includes(k))), told });
  const lines = [];
  const seat = (kind, key, what, where, run, team) => {
    try {
      lines.push(tell({ state, runs, post, kind, key, what, where, dir: team ?? teamOfRun(run, heldBy) }));
    } catch (error) {
      logFailure(`${kind} ${key}`, error);
    }
  };
  for (const r of fresh) {
    const done = r.structured !== null && r.structured !== undefined;
    seat(done ? 'seat-ended' : 'seat-no-result', `${done ? 'seat-ended' : 'seat-no-result'} ${r.run} ${r.tag}`, `${r.role ?? 'seat'} ${r.tag} ended${done ? '' : ' with no structured result'}`, `${r.run}/run-${r.tag}.jsonl`, r.run, r.team);
  }
  for (const d of due) seat('seat-no-result', `seat-no-result ${d.dir} ${d.tag}`, `run ${d.tag} ended with no record: its process is gone`, `${d.dir}/run-${d.tag}.jsonl`, d.dir, null);
  return lines;
}
