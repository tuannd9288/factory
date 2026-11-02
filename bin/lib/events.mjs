// The factory's events (#309): the queue's sweep writes one line to $FACTORY_STATE/events.jsonl when one of five conditions
// begins (`start`) and one when it ends (`clear`); a condition that holds writes nothing more. A line is one JSON object:
// { seq, at, type, kind, key, text }. `seq` counts up from 1 across the file and is what a reader's cursor holds; `key` names the
// condition (it begins with the kind), so a clear matches its start. The five kinds:
//   check-not-started  a check `main` requires is missing from the head commit of a pull request waiting on auto-merge, or is there
//                      and has not started, for NOT_STARTED_MS from the first sweep that saw it (a dead runner leaves it so)
//   waiting-on-human   a tier-3 or needs-human pull request whose tier check did not succeed, or an open issue labelled needs-human
//   lead-at-dialog     a Lead whose newest hook event is a permission prompt or an elicitation dialog
//   out-of-quota       an account Claude Code has rejected until a reset that has not come
//   gh-refused         the sweep's own gh refused for a rate limit or a login
// Only the sweep writes (record, under its lock): $FACTORY_STATE/events-active.json remembers which conditions hold and since when,
// and a repository the sweep could not read keeps its conditions, since only a read that succeeded can end one. `factory top` and
// `bin/factory-events` only read. `bin/factory-events [--follow]` prints the start lines after its cursor ($FACTORY_STATE/events.cursor);
// only --follow moves the cursor and then follows the file, and no run prints a clear line. A text holds no token and no e-mail address.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountOut } from './seat.mjs';
import { accountList, seatAccounts } from './token.mjs';
import { leadOf, leadStateOf, readProcesses } from './top.mjs';

/** How long a required check may sit unstarted before it is told: half as much again as the slowest normal wait seen on 2026-11-02
 * (1,208 s on a busy self-hosted runner, from the run's creation), so only a real stall passes it. */
export const NOT_STARTED_MS = 30 * 60_000;

const STARTED = new Set(['IN_PROGRESS', 'COMPLETED']);
const HUMAN = new Set(['tier-3', 'needs-human']);
const stateDir = () => process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');

/** A text with every e-mail address as [account] and every token-like string (GitHub's prefixes, any run of 32 or more letters, digits,
 * _ or -) as [redacted]. */
export function redact(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[account]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

/** The first non-empty line of a text, redacted, with its control characters gone, at most 200 characters. */
const oneLine = (text) => redact(String(text).split('\n').find((l) => l.trim()) ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);

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
 * `factory top` uses, which lists it itself), and an open issue labelled needs-human (read by the sweep's one query). */
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

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Brings the events up to what holds now, and returns the lines it wrote. `found` is every condition that holds in what the sweep read
 * ({ key, scope, text, afterMs?, top?, url? }); `read` is the set of scopes it could read this time (a repository, 'leads', 'quota',
 * 'gh'). A condition of a scope not read stays as it was; one of a scope read that is not found ends, with a clear if it had started. A
 * condition with `afterMs` starts once that long has passed from the first sweep that saw it. */
export function record({ state, found, read, now = Date.now() }) {
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
export function observe({ state, reads, runs, agentProfiles, now = Date.now(), processes }) {
  const found = [];
  const read = new Set();
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
  return record({ state, found, read, now });
}

/** `factory-events [--follow] [--after <seq>]`: the start lines after the cursor (or after <seq>, which the reader says it got as far
 * as, in place of the cursor), one JSON line each. Without --follow it prints them and leaves the cursor; with it, a line moves the
 * cursor only once its write succeeded, lines go out one at a time, and the file is followed. It never prints a clear line. A cursor
 * or <seq> above the file's highest seq (the file was made anew) starts from its first line, and says so on stderr. */
function main(argv) {
  let follow = false;
  let after = null;
  const usage = () => new Error('usage: factory-events [--follow] [--after <seq>]');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--follow') follow = true;
    else if (argv[i] === '--after') {
      const v = argv[++i] ?? '';
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw usage();
      after = Number(v);
    } else throw usage();
  }
  const state = stateDir();
  const file = join(state, 'events.jsonl');
  const cursorFile = join(state, 'events.cursor');
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
      if (e?.type !== 'start' || !Number.isInteger(e.seq) || e.seq <= queued) continue;
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
