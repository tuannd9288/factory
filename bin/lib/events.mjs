// The factory's events (#309): the queue's sweep writes one line to $FACTORY_STATE/events.jsonl when one of its conditions
// begins (`start`) and one when it ends (`clear`); a condition that holds writes nothing more. A line is one JSON object:
// { seq, at, type, kind, key, text }. `seq` counts up from 1 across the file and is what a reader's cursor holds; `key` names the
// condition (it begins with the kind), so a clear matches its start. The first five kinds:
//   check-not-started  a check `main` requires is missing from the head commit of a pull request waiting on auto-merge, or is there
//                      and has not started, for NOT_STARTED_MS from the first sweep that saw it (a dead runner leaves it so)
//   waiting-on-human   a tier-3 or needs-human pull request whose tier check did not succeed, or an open issue labelled needs-human
//   lead-at-dialog     a Lead whose newest hook event is a permission prompt or an elicitation dialog
//   out-of-quota       an account Claude Code has rejected until a reset that has not come
//   gh-refused         the sweep's own gh refused for a rate limit or a login
// and a sixth (#333):
//   switch-moved       a repository's merge switch moved since the sweep before; held 24 hours from the sweep that saw it
// The sweep writes them (record), and the stream reader (#339, bin/lib/reader.mjs) writes two more kinds of line: a `reader-failed` condition
// of scope `reader` (through record, as the sweep's conditions are) and one-time `start` lines for what the model found (appendStart),
// which are no condition and are never cleared; the sweep writes one too, a `comment` line when it wakes a Lead for a new comment (#351,
// bin/lib/comment-wake.mjs), and one line of its own for each piece of news of a Lead's seats, checks and pull request (#370,
// bin/lib/news-wake.mjs: seat-ended, seat-no-result, checks-red, checks-green, conflict, merged: NEWS_KINDS, the Lead's, which
// `bin/factory-events` leaves out and `--news` alone prints, after a cursor of its own, $FACTORY_STATE/events.news.cursor). `observe` also hands each started
// check-not-started condition to its `onStart`, which wakes that pull request's Lead. The two writers are two processes, so each write takes $FACTORY_STATE/events.lock, a lock
// of that write alone, and `seq` stays unique and increasing across both.
// Only record and appendStart write: $FACTORY_STATE/events-active.json remembers which conditions hold and since when,
// and a repository the sweep could not read keeps its conditions, since only a read that succeeded can end one. `factory colly --brief` and
// `bin/factory-events` only read. `bin/factory-events [--follow]` prints the start lines after its cursor ($FACTORY_STATE/events.cursor);
// only --follow moves the cursor and then follows the file, and no run prints a clear line. A text holds no token and no e-mail address.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWS_KINDS } from './news-wake.mjs';
import { redact } from './redact.mjs';
import { accountOut } from './seat.mjs';
import { accountList, seatAccounts } from './token.mjs';
import { leadOf, leadStateOf, readProcesses } from './colly-status.mjs';

/** How long a required check may sit unstarted before it is told: half as much again as the slowest normal wait seen on 2026-11-02
 * (1,208 s on a busy self-hosted runner, from the run's creation), so only a real stall passes it. */
export const NOT_STARTED_MS = 30 * 60_000;

const STARTED = new Set(['IN_PROGRESS', 'COMPLETED']);
const HUMAN = new Set(['tier-3', 'needs-human']);
const stateDir = () => process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');

export { redact };

/** The first non-empty line of a text, redacted, with its control characters gone, at most 200 characters. */
export const oneLine =(text) => redact(String(text).split('\n').find((l) => l.trim()) ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);

// What gh prints when GitHub refuses it, from its own messages: the API's "API rate limit exceeded" / "secondary rate limit" and a 429
// for a rate limit; "HTTP 401: Bad credentials", "To get started with GitHub CLI, please run:  gh auth login" and "The token in ... is
// invalid" for a login. Read from the messages as remembered, not from a run against GitHub.
const REFUSED = /rate limit|HTTP 429|abuse detection|HTTP 401|Bad credentials|gh auth login|not logged in|authentication (?:failed|required)|token in .{0,60} is (?:invalid|expired)/i;

/** The text of a gh failure that is a refusal of a rate limit or a login ("gh <command>: <first line of the error>"), else null. The
 * command is its first two arguments that are not options, so the query and the owner stay out. */
export function ghRefusal(args, error) {
  const stderr = String(error?.stderr ?? '');
  if (!REFUSED.test(stderr)) return null;
  return `gh ${args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')}: ${oneLine(stderr)}`;
}

/** What the sweep's gh calls did this run: how many failed, and the first refusal. */
export const notes = { failed: 0, refused: null };
export function resetNotes() {
  notes.failed = 0;
  notes.refused = null;
}
export function noteGh(args, error) {
  notes.failed += 1;
  notes.refused ??= ghRefusal(args, error);
}

/** Condition 1, for one repository: from the pull requests as the queue reads them (`checks` and `apps` by name, each with its `status`)
 * and the checks `main` requires. A draft, a pull request without auto-merge and one in conflict (DIRTY: pull_request never runs) are none. */
export function checksNotStarted({ repo, prs, required }) {
  const found = [];
  for (const p of prs) {
    if (!p.autoMerge || p.isDraft || p.mergeStateStatus === 'DIRTY') continue;
    for (const name of required) {
      const c = p.checks[name] ?? p.apps?.[name];
      if (c && STARTED.has(c.status)) continue;
      found.push({ key: `check-not-started ${repo}#${p.number} ${name}`, scope: repo, afterMs: NOT_STARTED_MS, top: true, url: `https://github.com/${repo}/pull/${p.number}`, text: `${repo}#${p.number} ${name} has not started` });
    }
  }
  return found;
}

/** Condition 2, for one repository: a pull request labelled tier-3 or needs-human whose tier check completed without success (the rule
 * `factory colly --brief` uses, which lists it itself), and an open issue labelled needs-human (read by the sweep's one query). */
export function humanWaits({ repo, prs, issues }) {
  return [
    ...prs
      .filter((p) => p.labels.some((l) => HUMAN.has(l)) && p.checks.tier?.status === 'COMPLETED' && p.checks.tier.state !== 'SUCCESS')
      .map((p) => ({ key: `waiting-on-human ${repo}#${p.number}`, scope: repo, text: `${repo}#${p.number} waits for your approval` })),
    ...issues.map((i) => ({ key: `waiting-on-human ${repo}#${i.number}`, scope: repo, top: true, url: `https://github.com/${repo}/issues/${i.number}`, text: `${repo}#${i.number} ${i.title} waits for your answer (needs-human)` })),
  ];
}

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** Condition 3: the Leads running now whose newest hook event is a permission prompt or an elicitation dialog (the `waiting` state of
 * top's LEAD_STATES, read by top's own rule). The guess of a Lead at a login or a folder trust is not a dialog and is left out. A process
 * list that cannot be read throws (readProcesses), unlike top's, which shows none. */
export const defaultProcesses = readProcesses;
export function leadsAtDialog({ runs, now, processes = defaultProcesses }) {
  const out = [];
  for (const proc of processes()) {
    const lead = leadOf(proc.command);
    if (!lead) continue;
    const dir = join(runs, `${lead.repo}-${lead.team}`);
    let event = null;
    try {
      event = JSON.parse(readText(join(dir, 'state.json')));
    } catch {
      // no state yet
    }
    const s = leadStateOf({ event, command: proc.command, ageMs: proc.ageMs, now });
    if (s?.state !== 'waiting' || !s.stateAt) continue;
    const name = readText(join(dir, 'name')).trim() || `${lead.repo}-${lead.team}`;
    out.push({ key: `lead-at-dialog ${lead.repo}-${lead.team}`, scope: 'leads', text: `Lead ${name} (${lead.repo}, team ${lead.team}) waits at a dialog` });
  }
  return out;
}

/** Condition 4: one for each account Claude Code has rejected until a reset that has not come (accountOut, the signal that stops a
 * session), named by its letter. The account readers give an empty list for a file or folder they cannot read, so a host with no
 * account at all throws: it is not a reading, and cannot clear a condition. */
export function accountsOut({ runs, state, agentProfiles, now }) {
  const seatRows = seatAccounts(state);
  const accounts = accountList({ state, agentProfiles });
  if (!accounts.length) throw new Error('no account could be read');
  return accounts.flatMap(({ name, letter }) => {
    const why = accountOut(runs, name, seatRows, now);
    return why ? [{ key: `out-of-quota ${letter}`, scope: 'quota', text: `account ${letter} is ${why}` }] : [];
  });
}

/** How long a move of the merge switch stays reported, from the time the sweep saw it. */
export const SWITCH_HOLD_MS = 24 * 60 * 60_000;
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Condition 6 (#333), for one repository whose merge switch the sweep read: its last move ({ from, to, at }, from
 * bin/lib/switch-watch.mjs), for 24 hours from the time the sweep saw it. A second move has its own key, so it ends the first. */
export function switchMoves({ repo, move, now }) {
  const seen = Date.parse(move?.at);
  if (!move || !(now - seen < SWITCH_HOLD_MS)) return [];
  return [{ key: `switch-moved ${repo} ${move.at}`, scope: `switch ${repo}`, top: true, url: `https://github.com/${repo}/rules`, text: `${repo} merge switch moved from ${move.from} to ${move.to}, seen by the sweep at ${localStamp(seen)}` }];
}

/** INN answers are permanent conditions keyed by the source event, on the factory host only.
 * Keeping the scope unread preserves the start across catch-up and daemon restarts. */
export function innAnswer({ state, event, pick, source, now }) {
  const key = event.kind === 'commentCreated' ? event.id : `${event.id}:${event.time}`;
  const answer = event.kind === 'commentCreated' ? 'his comment'
    : source ? `his pick ${pick} (${source})` : `pick ${pick}; ticker is not confirmed; not his answer`;
  return record({ state, found: [{ key: `inn-answer ${key}`, scope: 'inn-answer',
    text: `${event.issueIdentifier}: ${answer}` }], read: new Set(), now });
}

const emptyActive = () => ({ seq: 0, conditions: {} });

/** The conditions that hold, as events-active.json keeps them: { seq, conditions: { key: { kind, key, scope, text, since, started, top, url } } }. */
export function readActive(state) {
  try {
    const a = JSON.parse(readFileSync(join(state, 'events-active.json'), 'utf8'));
    return { seq: Number.isInteger(a.seq) ? a.seq : 0, conditions: a.conditions && typeof a.conditions === 'object' ? a.conditions : {} };
  } catch {
    return emptyActive();
  }
}

/** The lines of the events file, parsed; a torn or foreign line is skipped. */
export function readLines(state) {
  return readText(join(state, 'events.jsonl')).split('\n').flatMap((l) => {
    try {
      const e = l.trim() ? JSON.parse(l) : null;
      return Number.isInteger(e?.seq) ? [e] : [];
    } catch {
      return [];
    }
  });
}

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs fn holding $state/events.lock, a folder made with mkdir (one process wins). A write holds it for milliseconds, so a lock older
 * than 30 s is a dead writer's and is removed; a writer waits up to 10 s for it. `name` is another lock of the same kind: the seats' state
 * file has one (queue-seats.lock, #399), since the daemon's pass and its seat-ended handler both read and write it. */
export function withEventsLock(state, fn, name = 'events.lock') {
  mkdirSync(state, { recursive: true });
  const lock = join(state, name);
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
    } catch {
      continue;
    }
    if (Date.now() > until) throw new Error('events.lock is held');
    sleep(10);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Brings the events up to what holds now, and returns the lines it wrote. `found` is every condition that holds in what the sweep read
 * ({ key, scope, text, afterMs?, top?, url? }); `read` is the set of scopes it could read this time (a repository, 'leads', 'quota',
 * 'gh', 'reader'). A condition of a scope not read stays as it was; one of a scope read that is not found ends, with a clear if it had
 * started. A condition with `afterMs` starts once that long has passed from the first sweep that saw it. */
export function record(args) {
  return withEventsLock(args.state, () => recordLocked(args));
}

/** One line that is no condition: a `start` that nothing clears (the reader's findings, #339). Returns its seq. `extra` is more fields
 * of the line, as data for a reader that must not parse `text` (the news lines' `lead`, `woke`, `why`, `what` and `where`, #370); it
 * cannot replace a field the line has. */
export function appendStart({ state, kind, key, text, extra = {}, now = Date.now() }) {
  return withEventsLock(state, () => {
    const active = readActive(state);
    const seq = Math.max(active.seq, ...readLines(state).map((e) => e.seq)) + 1;
    appendFileSync(join(state, 'events.jsonl'), `${JSON.stringify({ ...extra, seq, at: new Date(now).toISOString(), type: 'start', kind, key, text: oneLine(text) })}\n`);
    writeAtomic(join(state, 'events-active.json'), `${JSON.stringify({ seq, conditions: active.conditions })}\n`);
    return seq;
  });
}

function recordLocked({ state, found, read, now = Date.now(), started }) {
  const active = readActive(state);
  const next = {};
  const changes = [];
  const keys = new Set();
  for (const f of found) {
    keys.add(f.key);
    const c = active.conditions[f.key] ?? { kind: f.key.split(' ')[0], key: f.key, scope: f.scope, text: oneLine(f.text), since: now, started: false, top: Boolean(f.top), ...(f.url ? { url: f.url } : {}) };
    if (!c.started && now - c.since >= (f.afterMs ?? 0)) {
      c.started = true;
      changes.push(['start', c]);
      started?.push(c);
    }
    next[f.key] = c;
  }
  for (const [key, c] of Object.entries(active.conditions)) {
    if (keys.has(key)) continue;
    if (!read.has(c.scope)) next[key] = c;
    else if (c.started) changes.push(['clear', c]);
  }
  mkdirSync(state, { recursive: true });
  let seq = active.seq;
  if (changes.length) {
    seq = Math.max(seq, ...readLines(state).map((e) => e.seq));
    const at = new Date(now).toISOString();
    appendFileSync(join(state, 'events.jsonl'), changes.map(([type, c]) => `${JSON.stringify({ seq: ++seq, at, type, kind: c.kind, key: c.key, text: c.text })}\n`).join(''));
  }
  const body = `${JSON.stringify({ seq, conditions: next })}\n`;
  if (body !== readText(join(state, 'events-active.json'))) writeAtomic(join(state, 'events-active.json'), body);
  return changes.length;
}

/** The step after a sweep's repository loop: every condition from what the sweep read. `reads` is { repo -> { required, prs, issues } }
 * for the repositories it read. The local readers (the Leads, the accounts) start nothing and call no gh; one that fails leaves its
 * conditions as they were. gh-refused ends only on a sweep whose gh calls all succeeded (`notes`). */
export function observe({ state, reads, runs, agentProfiles, now = Date.now(), processes, switches = new Map(), onStart }) {
  const found = [];
  const read = new Set();
  // `switches` is { repo -> last move or null } for the repositories whose merge switch the sweep read.
  for (const [repo, move] of switches) {
    read.add(`switch ${repo}`);
    found.push(...switchMoves({ repo, move, now }));
  }
  for (const [repo, d] of reads) {
    read.add(repo);
    found.push(...checksNotStarted({ repo, prs: d.prs, required: d.required }), ...humanWaits({ repo, prs: d.prs, issues: d.issues }));
  }
  try {
    found.push(...leadsAtDialog({ runs, now, processes }));
    read.add('leads');
  } catch {
    // the Leads could not be read: their conditions stay
  }
  try {
    found.push(...accountsOut({ runs, state, agentProfiles, now }));
    read.add('quota');
  } catch {
    // the accounts could not be read: their conditions stay
  }
  if (notes.refused) {
    found.push({ key: 'gh-refused', scope: 'gh', top: true, text: notes.refused });
    read.add('gh');
  } else if (!notes.failed) read.add('gh');
  const started = [];
  const changed = record({ state, found, read, now, started });
  // #370: the start of a check-not-started condition is told to the pull request's Lead as well, after its line is written and the
  // events lock is let go; `onStart` gets each condition that started and its failure never changes the result.
  for (const c of started.filter((s) => s.kind === 'check-not-started')) {
    try {
      onStart?.(c);
    } catch (error) {
      console.log(`queue: the wake for ${c.key} failed: ${String(error.message).split('\n')[0]}`);
    }
  }
  return changed;
}

/** `factory-events [--follow] [--after <seq>]`: the start lines after the cursor (or after <seq>, which the reader says it got as far
 * as, in place of the cursor), one JSON line each. Without --follow it prints them and leaves the cursor; with it, a line moves the
 * cursor only once its write succeeded, lines go out one at a time, and the file is followed. It never prints a clear line. A cursor
 * or <seq> above the file's highest seq (the file was made anew) starts from its first line, and says so on stderr. */
function main(argv) {
  let follow = false;
  let news = false;
  let newest = false;
  let after = null;
  const usage = () => new Error('usage: factory-events [--follow] [--after <seq>] [--news [--newest]]');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--follow') follow = true;
    else if (argv[i] === '--news') news = true;
    else if (argv[i] === '--newest') newest = true;
    else if (argv[i] === '--after') {
      const v = argv[++i] ?? '';
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw usage();
      after = Number(v);
    } else throw usage();
  }
  if (newest && (!news || follow || after !== null)) throw usage();
  const state = stateDir();
  const file = join(state, 'events.jsonl');
  // `--news --newest` prints the highest seq of a news line, or 0, and nothing else; it moves no cursor. The relay's first pass reads only this.
  if (newest) return void console.log(Math.max(0, ...readLines(state).filter((e) => e.type === 'start' && NEWS_KINDS.has(e.kind)).map((e) => e.seq)));
  // --news has a cursor of its own: Colly's never moves for it.
  const cursorFile = join(state, news ? 'events.news.cursor' : 'events.cursor');
  let cursor = Number(readText(cursorFile).trim()) || 0;
  const highest = Math.max(0, ...readLines(state).map((e) => e.seq));
  let queued = after ?? cursor;
  if (queued > highest) {
    console.error(`factory-events: ${after === null ? 'the cursor' : '--after'} ${queued} is above the highest seq in events.jsonl (${highest}); starting from its first line`);
    queued = 0;
  }
  if (cursor > highest) cursor = 0;
  let offset = 0;
  let partial = '';
  const pending = [];
  let writing = false;
  // One line at a time; the cursor moves in the write's callback, and only when the write succeeded.
  const pump = () => {
    if (writing || !pending.length) return;
    writing = true;
    const { seq, line } = pending.shift();
    process.stdout.write(`${line}\n`, (error) => {
      if (error) process.exit(0);
      writing = false;
      if (follow) {
        cursor = Math.max(cursor, seq);
        mkdirSync(state, { recursive: true });
        writeAtomic(cursorFile, `${cursor}\n`);
      }
      pump();
    });
  };
  process.stdout.on('error', () => process.exit(0));
  const drain = () => {
    let size;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) {
      // The file was made anew: its seq counts from 1 again.
      offset = 0;
      partial = '';
      queued = 0;
    }
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;
    const parts = (partial + buf.toString('utf8')).split('\n');
    partial = parts.pop();
    for (const l of parts) {
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e?.type !== 'start' || !Number.isInteger(e.seq) || e.seq <= queued || NEWS_KINDS.has(e.kind) !== news) continue;
      queued = e.seq;
      pending.push({ seq: e.seq, line: l });
    }
    pump();
  };
  drain();
  if (follow) setInterval(drain, 500);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`factory-events: ${error.message}`);
    process.exitCode = 2;
  }
}
