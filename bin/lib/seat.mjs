// bin/seat (#91): the one command that starts an unattended `claude -p` session. This file holds the role presets: the
// arguments each role gives claude. They come from the hand-written launchers of ~/factory-runs, role by role (see
// PRESETS). Nothing here reads a credential.
import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, reexec, withStartLock } from './checkout.mjs';
import { PluginError, installPlugins } from './plugins.mjs';
import { seatAccounts, tokenDir } from './token.mjs';

/** What a session reports back through --json-schema (as the gate's reviewer does, kit/.gate/bin/lib/claude-reviewer.mjs).
 * The cost is not asked of the model: the record takes it from the session's result event. */
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'evidence', 'couldNotRead', 'needsHuman'],
  properties: {
    conclusion: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    couldNotRead: { type: 'array', items: { type: 'string' } },
    needsHuman: { type: 'array', items: { type: 'string' } },
  },
};

// The researcher's only git (#181).
export const RESEARCH_GIT = fileURLToPath(new URL('../research-git', import.meta.url));

// The settings every session gets with --settings (#205): bin/factory-alerts at its start, from this checkout, so no profile
// has to hold the hook.
export const ALERTS_SETTINGS = JSON.stringify({
  hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: fileURLToPath(new URL('../factory-alerts', import.meta.url)), timeout: 10 }] }] },
});

// The deny list every launcher shared, with env and printenv for every role and seat (#181). WebFetch and WebSearch are
// denied for every role but the researcher.
export const secretsRead = ['Read(~/.config/**)', 'Read(~/.claude/**)', 'Read(~/.codex/**)', 'Read(~/.agent-profiles/**)', 'Read(~/.ssh/**)', 'Read(~/.local/share/claude/**)'];
// No agent runs `factory login` or `factory store` (#177): the Human alone puts a token in the store. The leading `*` takes
// `factory` by name, by a relative or an absolute path and after other words; the two library rules close the `node` grant.
// `factory use` and `factory logout` (#178) are the Human's too: the first moves a row to another account, the second removes one.
export const tokenStoreDeny = [
  'Bash(*factory login*)', 'Bash(*factory store*)', 'Bash(*lib/factory.mjs login*)', 'Bash(*lib/factory.mjs store*)',
  'Bash(*factory use*)', 'Bash(*factory logout*)', 'Bash(*lib/factory.mjs use*)', 'Bash(*lib/factory.mjs logout*)',
];
// The copies of a Lead's transcripts (packs/pstack/bin/transcript-copy.mjs, #185): only the Lead reads its own, so every seat role is
// denied them. The Lead's own deny list takes secretsRead alone.
export const leadTranscripts = 'Read(~/factory-runs/*-lead/transcripts/**)';
const denyOf = (home, web) => [
  ...tokenStoreDeny, 'Bash(gh:*)', 'Bash(git push:*)', 'Bash(git config:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(curl:*)',
  'Bash(herdr:*)', `Bash(${home}/.local/bin/herdr:*)`, 'Bash(env:*)', 'Bash(printenv:*)', ...(web ? [] : ['WebFetch', 'WebSearch']), ...secretsRead, leadTranscripts,
];

// --json-schema adds the StructuredOutput tool to the session, so each allow list admits it (claude-reviewer.mjs).
const builderAllow = (run) => [
  'Read', 'Glob', 'Grep', 'Bash(node:*)', 'Bash(git:*)', `Bash(${run}/sv)`, 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(cd:*)', 'Bash(mktemp:*)', 'Bash(grep:*)', 'Bash(diff:*)',
];

// The filesystem commands acceptEdits approved in the session's folders, which the default mode bin/seat runs in does not
// (#188). The researcher gets none of them, nor cp or sed, so it cannot move or remove the folder research-git clones into.
const fsCommands = ['Bash(mv:*)', 'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(touch:*)'];

/** The presets. turns is a new session's --max-turns, resumeTurns a resumed one's. No preset has a spend cap: a figure the
 * factory picked, on a subscription that bills no dollars, is a stop of the kind #194 removed; --max-turns guards a runaway.
 * worker: run-90.sh worker (sonnet, medium, 400 turns); its fix rounds (run-90fix.sh) resume with 200.
 * reviewer: run-90.sh reviewer (opus, high, 300 turns); its rounds (run-90rr family) resume with 300 or 200, 300 here.
 * researcher: run-79.sh, run-71.sh and run-58.sh (opus, high, 300 turns, the web and read-only git); resumed with 200
 *   (run-71tx.sh, run-71rc.sh). Its git goes through bin/research-git, and every other form of git is denied (#181).
 * deny is a role's own deny rules, after the common ones. */
export const PRESETS = {
  worker: {
    model: 'sonnet', effort: 'medium', turns: 400, resumeTurns: 200, web: false,
    allow: (run) => [...builderAllow(run), 'Bash(cp:*)', 'Bash(sed:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(cmp:*)', ...fsCommands],
  },
  reviewer: {
    model: 'opus', effort: 'high', turns: 300, resumeTurns: 300, web: false,
    allow: (run) => [...builderAllow(run), 'Bash(cp:*)', ...fsCommands],
  },
  researcher: {
    // The Lead's proposal (review of #91, #6), agreed by Colly on 2026-10-26: the researcher reads untrusted pages and can send
    // them out with WebFetch, so it never runs on seat 1. Since #178 seat 2 holds a token too; its grants were reviewed for that
    // (AGENTS.md): no tool of its own returns a file's content but Read, which the deny rules refuse on the tokens.
    model: 'opus', effort: 'high', turns: 300, resumeTurns: 200, web: true, seats: [2],
    allow: () => [
      'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', `Bash(${RESEARCH_GIT}:*)`,
      'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(date:*)', 'Bash(cd:*)',
    ],
    deny: ['Bash(git:*)'],
  },
};

export const ROLES = Object.keys(PRESETS);

/** The arguments of `claude`, for a role. run is the run folder (the session may add it to its directories and run its
 * `sv`); skills become Skill(<name>) grants and allow is a run's own extra grants; profiles, the profiles folder, adds three deny
 * rules for every seat (#178): the tokens folder, the archive folder and seat 1's old token file; deny is a run's own extra deny
 * rules (#92), which come after the role's and before those three. The mode is
 * default: with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB set, Claude Code 2.1.308 forces it whatever is asked (#188). Write, Edit
 * and redirects reach the session's own folders only (run, work and each --add-dir), as acceptEdits limited them. */
export function buildArgs({ role, run, work = null, home, resume = null, skills = [], allow = [], deny: extraDeny = [], addDirs = [], maxTurns = null, profiles = null }) {
  const p = PRESETS[role];
  if (!Object.hasOwn(PRESETS, role)) throw new Error(`unknown role ${role}; the roles are ${ROLES.join(', ')}`);
  const edits = [...new Set([run, work, ...addDirs].filter(Boolean))].map((d) => `Edit(/${d}/**)`);
  const deny = [...denyOf(home, p.web), ...(p.deny ?? []), ...extraDeny, ...(profiles ? [`Read(/${profiles}/tokens/**)`, `Read(/${profiles}/archive/**)`, `Read(/${profiles}/seats/1/oauth-token)`] : [])];
  return [
    '-p', ...(resume ? ['--resume', resume] : []),
    '--model', p.model, '--effort', p.effort, '--max-turns', String(maxTurns ?? (resume ? p.resumeTurns : p.turns)),
    '--permission-mode', 'default',
    '--settings', ALERTS_SETTINGS,
    '--add-dir', run, ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--allowedTools', ...p.allow(run), ...edits, 'StructuredOutput', ...skills.map((s) => `Skill(${s})`), ...allow,
    '--disallowedTools', ...deny,
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(SCHEMA),
  ];
}

// The seats: 1 and 2. A new session tries seat 2 first. A seat has no stop at a share of its quota (the Human, 2026-10-30,
// #194), nor at a number of live sessions (the Human, 2026-10-31, #280): how many run is the Lead's call.
export const SEATS = { 1: {}, 2: {} };
const ORDER = [2, 1];

/** The run*<ext> files of the run folders under runs (one level down). */
export function runFiles(runs, ext) {
  const out = [];
  for (const folder of existsSync(runs) ? readdirSync(runs) : []) {
    const dir = join(runs, folder);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) if (n.startsWith('run') && n.endsWith(ext)) out.push(join(dir, n));
  }
  return out;
}

/** The seat a run's file belongs to: its .seat file, else fallback (a session from before there were seats ran on seat 2). */
const seatOf = (file, fallback = null) => {
  try {
    return readFileSync(file.replace(/\.[^./]*$/, '.seat'), 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return fallback; // never there, or a start backing off removed its claim meanwhile
    throw e;
  }
};

// The uid and start time of a process, from ps (the kernel's own record, which no launcher can change; argv it can). lstart has
// one-second precision. ps is by absolute path, since a test's PATH holds no /bin. A failed ps, or no process, is null.
function processInfo(pid) {
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    if (!existsSync(ps)) continue;
    try {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(execFileSync(ps, ['-o', 'uid=,lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },stdio: ['ignore', 'pipe', 'ignore'] }));
      const started = m ? Date.parse(m[2]) : NaN;
      return Number.isNaN(started) ? null : { uid: Number(m[1]), started };
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether pid is a live session that wrote a file at fileMs: a process of this user (never pid 1, nor another user's), that
 * started no later than the file was written, give or take a second; a later start is a pid the system gave again. */
const alive = (pid, fileMs) => {
  const p = processInfo(pid);
  return p !== null && p.uid === process.getuid() && p.started <= fileMs + 1000;
};

// An empty or non-numeric pid file is no live session (process.kill(0, 0) would succeed for it).
// A file that goes away meanwhile (a start backing off removes its claim) is no live session either.
function filePidAlive(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^[1-9][0-9]*$/.test(text) && alive(Number(text), statSync(file).mtimeMs);
  } catch {
    return false;
  }
}

/** Whether a run is live: its pid file's process (the supervisor, or the claude of an old launcher) or the session the
 * supervisor recorded in run-<tag>.child, which outlives a supervisor that was killed with SIGKILL. */
export const runLive = (pidFile) => filePidAlive(pidFile) || filePidAlive(pidFile.replace(/\.pid$/, '.child'));

/** How many sessions of a seat have a live process: Infinity when the folders never held still. The count is taken between two
 * listings of the .pid files, claims included, and is made again when they differ. A start's hand-off removes
 * run-<tag>.claim.pid only after it wrote run-<tag>.pid, and that removal changes the listing, so none can finish between two
 * equal listings; one seen half done counts that start twice at worst. list is the listing, passed in so a test can force the
 * interleaving. */
export function liveCount(runs, seat, list = runFiles) {
  return countLive(runs, (p) => seatOf(p, '2') === String(seat), list);
}

/** How many runs are live whatever their seat, claims and the markers of seat 0 included (#257): the update of the checkout waits
 * for none. Infinity when the folders never held still. */
export function liveRuns(runs, list = runFiles) {
  return countLive(runs, () => true, list);
}

function countLive(runs, keep, list) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const before = list(runs, '.pid').sort();
    const n = before.filter((p) => keep(p) && runLive(p)).length;
    if (before.join('\n') === list(runs, '.pid').sort().join('\n')) return n;
  }
  return Infinity;
}

/** The rate_limit_info that the newest log of the seat reporting a seven-day use gives (its last rate_limit_event), with the
 * log's time, or null. The one reader of a seat's quota: seatOut and the ledger's table (bin/lib/quota.mjs) both use it. */
export function seatEvent(runs, seat) {
  const logs = runFiles(runs, '.jsonl').filter((f) => seatOf(f) === String(seat)).map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f, t } of logs) {
    const line = readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"type":"rate_limit_event"')).pop();
    if (!line) continue;
    let info;
    try {
      info = JSON.parse(line).rate_limit_info;
    } catch {
      continue;
    }
    const u = info?.unifiedWindows?.seven_day?.utilization;
    if (u !== undefined && u !== null && u !== '') return { info, asOf: t };
  }
  return null;
}

/** Whether a reset time, in seconds, has passed at now (ms): the one comparison bin/seat and the quota notices make. */
export const resetPassed = (resetsAt, now) => resetsAt != null && resetsAt * 1000 <= now;

const WINDOW = { five_hour: 'five-hour', seven_day: 'seven-day' };

/** Why the seat is out, or null: Claude Code rejected its newest event (see seatEvent), and the reset that event gives has not
 * passed. This is the only signal of a limit hit (#194): the two recorded cut-offs, factory-runs/issue-149 and issue-167, each
 * carry this event before their result ("You've hit your session limit · resets …", api_error_status 429). */
export function seatOut(runs, seat, now = Date.now()) {
  const info = seatEvent(runs, seat)?.info;
  if (info?.status !== 'rejected' || info.resetsAt == null || resetPassed(info.resetsAt, now)) return null;
  const until = new Date(info.resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `rejected by Claude Code (${WINDOW[info.rateLimitType] ?? info.rateLimitType} window) until ${until} UTC`;
}

/** The seat a session runs on: resumeSeat when it is a resume, else the first of 2, 1 that is not out (seatOut), whatever its
 * number of live sessions. reasons say why each seat that was tried was passed over; with seat null, none was free. With claim, a
 * function that writes this start's own pid file for a seat and returns the function that removes it, the claim is written
 * before the seat is judged, so the update of the checkout counts it (#257). The claim of the seat chosen stays. With accounts
 * ({ seat: account }, #178), the team's account is that of the first seat tried, and a seat whose account differs, or that has
 * none, is passed over with a reason: nothing moves a session to another account by itself. */
export function chooseSeat({ runs, resumeSeat = null, seats = ORDER, claim = null, now = Date.now(), accounts = null }) {
  if (resumeSeat !== null && !Object.hasOwn(SEATS, resumeSeat)) throw new Error(`seat ${resumeSeat} does not exist; the seats are 1 and 2`);
  const reasons = [];
  const tried = resumeSeat === null ? seats : [resumeSeat];
  for (const seat of tried) {
    if (accounts && accounts[seat] === undefined) {
      reasons.push(`seat ${seat}: no row in the accounts file`);
      continue;
    }
    if (accounts && accounts[seat] !== accounts[tried[0]]) {
      reasons.push(`seat ${seat}: its account is not the team's (the team's is seat ${tried[0]}'s)`);
      continue;
    }
    const unclaim = claim ? claim(seat) : () => {};
    const out = seatOut(runs, seat, now);
    if (!out) return { seat, reasons };
    reasons.push(`seat ${seat}: ${out}`);
    unclaim();
  }
  return { seat: null, reasons };
}

class Refused extends Error {}
class Moved extends Error {
  constructor(head) {
    super('the checkout moved');
    this.head = head;
  }
}

const USAGE = 'usage: bin/seat <role> <brief file> --run <run folder> --work <work folder> [--tag <name>] [--resume <session id> --seat <n>] [--skill <name>]... [--allow <rule>]... [--deny <rule>]... [--add-dir <folder>]... [--max-turns <n>]';
const VALUE = { '--run': 'run', '--work': 'work', '--tag': 'tag', '--resume': 'resume', '--seat': 'seat', '--max-turns': 'maxTurns' };
const LIST = { '--skill': 'skills', '--allow': 'allow', '--deny': 'deny', '--add-dir': 'addDirs' };

const realOf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The arguments of bin/seat as an object; a Refused error, in a sentence, for anything else. */
export function parseArgs(argv) {
  const o = { skills: [], allow: [], deny: [], addDirs: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a in VALUE || a in LIST) {
      if (i + 1 >= argv.length) throw new Refused(`${a} needs a value\n${USAGE}`);
      if (a in LIST) o[LIST[a]].push(argv[++i]);
      else o[VALUE[a]] = argv[++i];
    } else if (a.startsWith('--')) throw new Refused(`unknown option ${a}\n${USAGE}`);
    else rest.push(a);
  }
  if (rest.length !== 2) throw new Refused(USAGE);
  [o.role, o.brief] = rest;
  if (!o.run || !o.work) throw new Refused(`--run and --work are both needed\n${USAGE}`);
  for (const [flag, value] of [['--resume', o.resume], ...o.allow.map((v) => ['--allow', v]), ...o.deny.map((v) => ['--deny', v]), ...o.addDirs.map((v) => ['--add-dir', v])]) {
    if (typeof value === 'string' && value.startsWith('-')) throw new Refused(`${flag} ${value}: a value that starts with a dash is refused, since claude would read it as a flag`);
  }
  // A folder's Edit rule is a gitignore pattern, so a glob character widens it, and a path that is not already real (relative,
  // a link, a trailing slash, a `..` step) is not the path the rule would name once claude resolves it (#192).
  for (const [flag, value] of [['--run', o.run], ['--work', o.work], ...o.addDirs.map((v) => ['--add-dir', v])]) {
    if (/[*?[]/.test(value)) throw new Refused(`${flag} ${value}: a folder with a glob character (*, ? or [) is refused, since its permission rule would reach other folders`);
    if (!isAbsolute(value) || realOf(value) !== value) throw new Refused(`${flag} ${value}: a folder must be an existing absolute path that is its own real path (no link, no relative part, no trailing slash)`);
  }
  if (o.seat !== undefined && !/^[12]$/.test(o.seat)) throw new Refused(`seat ${o.seat} does not exist; the seats are 1 and 2`);
  if (o.seat !== undefined) o.seat = Number(o.seat);
  if (o.maxTurns !== undefined && !/^[1-9][0-9]*$/.test(o.maxTurns)) throw new Refused('--max-turns needs a whole number of at least 1');
  if (o.resume && o.seat === undefined) throw new Refused('a resume stays on its seat; give --seat <n>, the seat the session ran on');
  if (o.tag !== undefined && !/^[A-Za-z0-9._-]+$/.test(o.tag)) throw new Refused('--tag takes letters, digits, dot, dash and underscore');
  return o;
}

/** The token of a seat's account from its file under tokens/, trailing newlines stripped. Refuses, naming the path only, when the
 * file is missing (and then names `factory login`), empty or holds any byte outside printable ASCII (0x21-0x7E): such a value
 * would make Node throw an error that quotes it. */
function readToken(path, seat, account) {
  let text = '';
  let missing = false;
  try {
    text = readFileSync(path, 'latin1').replace(/[\r\n]+$/, '');
  } catch (e) {
    missing = e.code === 'ENOENT';
  }
  if (missing) throw new Refused(`seat ${seat}: the account ${account} has no token file ${path}; the Human runs \`factory login ${account}\``);
  if (!/^[\x21-\x7e]+$/.test(text)) throw new Refused(`seat ${seat}: the token file ${path} is empty or not printable ASCII`);
  return text;
}

const onPath = (name, PATH) => (PATH ?? '').split(':').some((d) => d && existsSync(join(d, name)));

/** Starts a session in the background and returns what to print. The session runs under a detached supervisor of this
 * file, which waits for it and appends its record; the supervisor's pid is the one in run-<tag>.pid. */
export function launch(argv, env = process.env) {
  const o = parseArgs(argv);
  if (!Object.hasOwn(PRESETS, o.role)) throw new Refused(`unknown role ${o.role}; the roles are ${ROLES.join(', ')}`);
  const home = env.HOME;
  // Absolute, like --run and --work: the supervisor and claude run in the work folder.
  const runs = resolve(env.FACTORY_RUNS ?? join(home, 'factory-runs'));
  const profiles = resolve(env.AGENT_PROFILES ?? join(home, '.agent-profiles'));
  const state = resolve(env.FACTORY_STATE ?? join(home, '.local/state/factory'));
  const seats = PRESETS[o.role].seats ?? ORDER;
  if (o.seat !== undefined && !seats.includes(o.seat)) throw new Refused(`the ${o.role} does not run on seat ${o.seat}`);
  const [run, work, brief] = [resolve(o.run), resolve(o.work), resolve(o.brief)];
  for (const [what, path] of [['run folder', run], ['work folder', work]]) if (!existsSync(path) || !statSync(path).isDirectory()) throw new Refused(`the ${what} ${path} is not a folder`);
  if (!existsSync(brief) || !statSync(brief).isFile()) throw new Refused(`the brief ${brief} is not a file`);
  const tag = o.tag ?? (o.resume ? basename(brief, extname(brief)) : o.role);
  // run-<tag>.claim.pid is the claim of a start of <tag>, so a tag of that shape, in any case on a disk that ignores case, would
  // take another's claim files as its run files.
  if (/\.claim$/i.test(tag)) throw new Refused(`the tag ${tag} ends in .claim, the name of the claim files of tag ${tag.slice(0, -'.claim'.length)}`);
  // The tag is claimed with a lock folder (mkdir is atomic) for as long as the start takes, so two starts of one tag cannot both pass the check.
  const release = claimTag(join(run, `run-${tag}.lock`), tag);
  try {
    // The start registers (its claim, which chooseSeat writes) while it holds checkout.lock, and only then: the update of the
    // checkout counts the claim or has finished, and a start that loaded older code than the checkout now holds starts again
    // (#257). The plugin install and the spawn run after the release, the claim being live from then on.
    let started;
    try {
      started = withStartLock(state, ROOT, () => register({ o, runs, state, run, tag }), { label: 'a start of bin/seat' });
    } catch (e) {
      throw e.busy ? new Refused(e.message) : e;
    }
    if (started.moved) throw new Moved(started.head);
    const { seat, account, pidFile, unclaim } = started.value;
    try {
      return spawnSupervisor({ o, env, home, profiles, state, run, work, brief, tag, pidFile, seat, account });
    } finally {
      unclaim(); // after the run's own .seat and .pid are written, so the count never drops; on any failure, nothing is left
    }
  } finally {
    release();
  }
}

function claimTag(lock, tag) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw new Refused(`could not claim run-${tag} (${e.code ?? 'error'})`);
      // A start that crashed leaves its lock; one older than a minute is not a start in progress.
      if (attempt === 0 && Date.now() - statSync(lock).mtimeMs > 60000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw new Refused(`another start of run-${tag} is in progress`);
    }
  }
}

/** The registration of a start: refuses a tag that is running, writes the claim and chooses the seat (chooseSeat writes the claim).
 * Returns the seat, the pid file and the function that removes the claim, which the caller calls when the run's own files are
 * written. On any failure here nothing is left. */
function register({ o, runs, state, run, tag }) {
  const pidFile = join(run, `run-${tag}.pid`);
  if (runLive(pidFile)) throw new Refused(`run-${tag} is already running (${readFileSync(pidFile, 'utf8').trim()}) in ${run}`);
  // The claim: this start's own pid with its seat, in run-<tag>.claim.pid and .claim.seat, written before the seat is judged
  // and removed if it backs off. They are files of their own, since run-<tag>.seat also gives the earlier run's log to a seat
  // (seatEvent) and a claim must not move it. Until the supervisor exists the claim holds bin/seat's pid, which counts as
  // live (this user's, started before the file).
  const claimPid = join(run, `run-${tag}.claim.pid`);
  const claimSeat = join(run, `run-${tag}.claim.seat`);
  const unclaim = () => {
    rmSync(claimPid, { force: true });
    rmSync(claimSeat, { force: true });
  };
  const claim = (seat) => {
    writeFileSync(claimSeat, `${seat}\n`);
    writeFileSync(claimPid, `${process.pid}\n`);
    return unclaim;
  };
  try {
    // Until teams are named (#196) every session is one team's: its account is that of the first seat its role tries.
    const accounts = seatAccounts(state);
    const first = o.seat ?? (PRESETS[o.role].seats ?? ORDER)[0];
    if (!accounts[first]) throw new Refused(`seat ${first} has no row in the accounts file ${join(state, 'accounts')}; the Human sets one with \`factory use\``);
    const { seat, reasons } = chooseSeat({ runs, resumeSeat: o.seat ?? null, seats: PRESETS[o.role].seats, claim, accounts });
    if (seat === null) throw new Refused(`${reasons.join('\n')}\nno seat free on the team's account; \`factory\` shows every account's room and \`factory use\` moves the team`);
    return { seat, account: accounts[seat], pidFile, unclaim };
  } catch (e) {
    unclaim();
    throw e;
  }
}

function spawnSupervisor({ o, env, home, profiles, state, run, work, brief, tag, pidFile, seat, account }) {
  const tokenPath = join(tokenDir(profiles), account);
  readToken(tokenPath, seat, account); // refuses now; the supervisor reads it again, just before it starts claude

  // Neither bin/seat's environment nor the supervisor's holds the token, nor the caller's GitHub or API credentials. The
  // scrub has claude take credentials out of the environment of each command, hook and MCP server it starts (#181).
  const child = { ...env, GH_CONFIG_DIR: join(run, '.gh-empty'), CLAUDE_CONFIG_DIR: join(profiles, 'seats', String(seat), 'claude'), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete child[name];
  // The researcher's git clones under its run folder, and only there (bin/research-git).
  if (o.role === 'researcher') child.FACTORY_RESEARCH_CLONES = join(run, 'clones');
  mkdirSync(child.GH_CONFIG_DIR, { recursive: true });
  // The plugin cache is outside every profile, since the deny list hides the profiles (#185); whatever the caller had is replaced.
  try {
    child.CLAUDE_CODE_PLUGIN_CACHE_DIR = installPlugins({ work, config: child.CLAUDE_CONFIG_DIR, home, profiles, env });
  } catch (e) {
    if (e instanceof PluginError) throw new Refused(`plugins: ${e.message}`);
    throw e;
  }
  const args = buildArgs({ role: o.role, run, work, home, resume: o.resume ?? null, skills: o.skills, allow: o.allow, deny: o.deny, addDirs: o.addDirs, maxTurns: o.maxTurns ? Number(o.maxTurns) : null, profiles });
  const spec = {
    cmd: [...(onPath('caffeinate', env.PATH) ? ['caffeinate', '-i'] : []), 'claude', ...args], cwd: work, brief, jsonl: join(run, `run-${tag}.jsonl`), err: join(run, `run-${tag}.err`),
    childFile: join(run, `run-${tag}.child`), tokenPath, account, role: o.role, seat, tag, run, state, model: PRESETS[o.role].model, resume: o.resume ?? null, start: new Date().toISOString(),
  };
  for (const f of [spec.jsonl, spec.err]) writeFileSync(f, '');
  const sup = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise'], { cwd: work, detached: true, stdio: 'ignore', env: { ...child, FACTORY_SEAT_SUPERVISE: JSON.stringify(spec) } });
  if (!sup.pid) throw new Refused(`could not start the supervisor of run-${tag}`);
  sup.unref();
  // The seat first: a pid file with no .seat file would count on seat 2.
  writeFileSync(join(run, `run-${tag}.seat`), `${seat}\n`);
  writeFileSync(pidFile, `${sup.pid}\n`);
  return `bin/seat: ${tag} started ${sup.pid} on seat ${seat}\n`;
}

/** The repository (`owner/name`, from a GitHub https or ssh URL of origin) and the branch of a work folder, null where git
 * cannot tell: a folder that is not a clone, another host, a detached HEAD. Read when the session ends, since a worker may
 * make its branch during the session (#205). */
function placeOf(dir) {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
    } catch {
      return null;
    }
  };
  const repo = /^(?:https:\/\/|git@|ssh:\/\/git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(git('remote', 'get-url', 'origin') ?? '')?.[1] ?? null;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return { repo, branch: branch && branch !== 'HEAD' ? branch : null };
}

/** The record of a session that has ended: spec is what launch decided, text the session's log, end how it ended. */
export function recordOf(spec, events, { code, signal, error = null, end = new Date() }) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  // A run can hold several results (a background task that ends starts another query): turns and duration add up; the cost
  // is cumulative, so the last result's is the whole; the report is the last one that has it.
  const results = events.filter((e) => e.type === 'result');
  const result = results.at(-1) ?? null;
  const sum = (key) => (results.some((r) => typeof r[key] === 'number') ? results.reduce((s, r) => s + (typeof r[key] === 'number' ? r[key] : 0), 0) : null);
  const models = result?.modelUsage ? Object.keys(result.modelUsage) : [];
  return {
    session: result?.session_id ?? init?.session_id ?? spec.resume ?? null,
    role: spec.role, seat: spec.seat, tag: spec.tag, run: spec.run, ...placeOf(spec.cwd),
    model: models.length ? models.join(',') : (init?.model ?? spec.model),
    start: spec.start, end: end.toISOString(), minutes: Math.round((end - Date.parse(spec.start)) / 600) / 100,
    turns: sum('num_turns'), duration_ms: sum('duration_ms'), total_cost_usd: result?.total_cost_usd ?? null,
    structured: results.findLast((r) => r.structured_output !== undefined && r.structured_output !== null)?.structured_output ?? null,
    ended: result ? (result.subtype ?? 'result') : 'no-result',
    exitCode: code ?? null, signal: signal ?? null, ...(error ? { error } : {}),
  };
}

/** The detached half: runs the session with the brief on stdin and its log and errors in the run folder, forwards a
 * signal it gets to the session, and when the session ends appends its record to $FACTORY_STATE/sessions.jsonl. */
function supervise() {
  const spec = JSON.parse(process.env.FACTORY_SEAT_SUPERVISE);
  delete process.env.FACTORY_SEAT_SUPERVISE;
  const [stdin, stdout, stderr] = [openSync(spec.brief, 'r'), openSync(spec.jsonl, 'w'), openSync(spec.err, 'w')];
  const [cmd, ...args] = spec.cmd;
  let done = false;
  let rest = '';
  const decoder = new StringDecoder('utf8'); // per stream, not per chunk: a character cut between two reads stays whole
  const events = [];
  const take = (line) => {
    try {
      const e = JSON.parse(line);
      if (e?.type === 'result' || (e?.type === 'system' && e.subtype === 'init')) events.push(e);
    } catch {
      // Not an event.
    }
  };
  // Only claude's environment holds the token, read here, just before it starts.
  const env = { ...process.env };
  let child;
  try {
    env.CLAUDE_CODE_OAUTH_TOKEN = readToken(spec.tokenPath, spec.seat, spec.account);
    child = spawn(cmd, args, { cwd: spec.cwd, env, stdio: [stdin, 'pipe', stderr], detached: true });
  } catch (e) {
    // A fixed message: a Node error can quote the environment.
    appendFileSync(spec.err, `bin/seat: could not start claude (${e instanceof Refused ? 'token' : (e.code ?? 'error')})\n`);
    return finish(null, null, 'start failed');
  }
  // The session's own pid, so that the run stays counted, and its tag taken, while claude lives even if this supervisor is killed.
  writeFileSync(spec.childFile, `${child.pid}\n`);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    });
  }
  function finish(code, signal, error = null) {
    if (done) return;
    done = true;
    rest += decoder.end();
    if (rest.trim()) take(rest);
    rmSync(spec.childFile, { force: true });
    for (const fd of [stdin, stdout, stderr]) closeSync(fd);
    try {
      mkdirSync(spec.state, { recursive: true });
      appendFileSync(join(spec.state, 'sessions.jsonl'), `${JSON.stringify(recordOf(spec, events, { code, signal, error }))}\n`);
    } catch (e) {
      appendFileSync(spec.err, `bin/seat: could not write the record: ${e.code ?? 'error'}\n`);
    }
  }
  // The log is what this child wrote through the pipe, and the record is built from the same events, so no other process's
  // output (an orphan that wrote to the same path) can get into it.
  child.stdout.on('data', (chunk) => {
    writeSync(stdout, chunk);
    rest += decoder.write(chunk);
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const l of lines) take(l);
  });
  child.on('error', (e) => finish(null, null, `${e.syscall ?? 'spawn'} ${e.code ?? 'failed'}`));
  child.on('close', finish);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--supervise') supervise();
  else {
    try {
      process.stdout.write(launch(process.argv.slice(2)));
    } catch (e) {
      if (e instanceof Moved) process.exitCode = reexec(process.argv.slice(1), e.head);
      else {
        // A Node error can quote the environment, so anything but our own refusal prints its code and nothing else.
        process.stderr.write(`bin/seat: ${e instanceof Refused ? e.message : `failed (${e.code ?? e.name})`}\n`);
        process.exitCode = e instanceof Refused ? 2 : 1;
      }
    }
  }
}
