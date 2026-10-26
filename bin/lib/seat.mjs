// bin/seat (#91): the one command that starts an unattended `claude -p` session. This file holds the role presets: the
// arguments each role gives claude. They come from the hand-written launchers of ~/factory-runs, role by role (see
// PRESETS). Nothing here reads a credential.
import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What a session reports back through --json-schema (as the gate's reviewer does, kit/scripts/lib/claude-reviewer.mjs).
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

// The deny list every launcher shared. WebFetch and WebSearch are denied for every role but the researcher.
const secretsRead = ['Read(~/.config/**)', 'Read(~/.claude/**)', 'Read(~/.codex/**)', 'Read(~/.agent-profiles/**)', 'Read(~/.ssh/**)', 'Read(~/.local/share/claude/**)'];
const denyOf = (home, web) => [
  'Bash(gh:*)', 'Bash(git push:*)', 'Bash(git config:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(curl:*)',
  'Bash(herdr:*)', `Bash(${home}/.local/bin/herdr:*)`, ...(web ? [] : ['WebFetch', 'WebSearch']), ...secretsRead,
];

// --json-schema adds the StructuredOutput tool to the session, so each allow list admits it (claude-reviewer.mjs).
const builderAllow = (run) => [
  'Read', 'Glob', 'Grep', 'Bash(node:*)', 'Bash(git:*)', `Bash(${run}/sv)`, 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(cd:*)', 'Bash(mktemp:*)', 'Bash(grep:*)', 'Bash(diff:*)',
];

/** The presets. turns is a new session's --max-turns, resumeTurns a resumed one's. The budget is the Lead's choice
 * (#91); whether it stops a session on a subscription seat is not known yet.
 * worker: run-90.sh worker (sonnet, medium, 400 turns); its fix rounds (run-90fix.sh) resume with 200.
 * reviewer: run-90.sh reviewer (opus, high, 300 turns); its rounds (run-90rr family) resume with 300 or 200, 300 here.
 * researcher: run-79.sh, run-71.sh and run-58.sh (opus, high, 300 turns, the web and read-only git); resumed with 200
 *   (run-71tx.sh, run-71rc.sh). */
export const PRESETS = {
  worker: {
    model: 'sonnet', effort: 'medium', turns: 400, resumeTurns: 200, budget: 20, web: false,
    allow: (run) => [...builderAllow(run), 'Write', 'Edit', 'Bash(cp:*)', 'Bash(sed:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(cmp:*)'],
  },
  reviewer: {
    model: 'opus', effort: 'high', turns: 300, resumeTurns: 300, budget: 15, web: false,
    allow: (run) => [...builderAllow(run), 'Write'],
  },
  researcher: {
    // The Lead's proposal (review of #91, #6), agreed by Colly on 2026-10-26: the researcher reads untrusted pages, can send them out
    // with WebFetch and can read a file outside a repository with git grep, so it never runs on seat 1, which holds a token.
    model: 'opus', effort: 'high', turns: 300, resumeTurns: 200, budget: 15, web: true, seats: [2],
    allow: () => [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash(git clone:*)', 'Bash(git -C:*)', 'Bash(git log:*)',
      'Bash(git show:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-files:*)', 'Bash(git grep:*)', 'Bash(git diff:*)',
      'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(date:*)', 'Bash(cd:*)',
    ],
  },
};

export const ROLES = Object.keys(PRESETS);

/** The arguments of `claude`, for a role. run is the run folder (the session may add it to its directories and run its
 * `sv`); skills become Skill(<name>) grants and allow is a run's own extra grants; seat and tokenPath add seat 1's
 * deny rules. */
export function buildArgs({ role, run, home, resume = null, skills = [], allow = [], addDirs = [], maxTurns = null, seat = null, tokenPath = null }) {
  const p = PRESETS[role];
  if (!Object.hasOwn(PRESETS, role)) throw new Error(`unknown role ${role}; the roles are ${ROLES.join(', ')}`);
  const deny = [...denyOf(home, p.web), ...(seat === 1 ? ['Bash(env:*)', 'Bash(printenv:*)', `Read(/${tokenPath})`] : [])];
  return [
    '-p', ...(resume ? ['--resume', resume] : []),
    '--model', p.model, '--effort', p.effort, '--max-turns', String(maxTurns ?? (resume ? p.resumeTurns : p.turns)),
    '--max-budget-usd', String(p.budget), '--permission-mode', 'acceptEdits',
    '--add-dir', run, ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--allowedTools', ...p.allow(run), 'StructuredOutput', ...skills.map((s) => `Skill(${s})`), ...allow,
    '--disallowedTools', ...deny,
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(SCHEMA),
  ];
}

// The seats, as factory:~/factory-runs/seat.zsh has them (the Human, 2026-10-26): at most four live sessions a seat; seat 1
// stops at 70% of its week, seat 2 at 90%. A new session tries seat 2 first.
export const SEATS = { 1: { cap: 4, stop: '0.70' }, 2: { cap: 4, stop: '0.90' } };
const ORDER = [2, 1];

/** The run*<ext> files of the run folders under runs (one level down). */
function runFiles(runs, ext) {
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
  const s = file.replace(/\.[^./]*$/, '.seat');
  return existsSync(s) ? readFileSync(s, 'utf8').trim() : fallback;
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
const runLive = (pidFile) => filePidAlive(pidFile) || filePidAlive(pidFile.replace(/\.pid$/, '.child'));

/** How many sessions of a seat have a live process. */
export function liveCount(runs, seat) {
  return runFiles(runs, '.pid').filter((p) => seatOf(p, '2') === String(seat) && runLive(p)).length;
}

/** The rate_limit_info that the newest log of the seat reporting a seven-day use gives (its last rate_limit_event), with the
 * log's time, or null. The one reader of a seat's quota: seatUse and the ledger's table (bin/lib/quota.mjs) both use it. */
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

/** The seven-day use of the seat (see seatEvent), or null. */
export const seatUse = (runs, seat) => seatEvent(runs, seat)?.info.unifiedWindows.seven_day.utilization ?? null;

/** The seat a session runs on: resumeSeat when it is a resume, else the first of 2, 1 that is under its cap and its
 * stop. reasons say why each seat that was tried was passed over; with seat null, none was free. With claim, a function that
 * writes this start's own pid file for a seat and returns the function that removes it, the count runs after the claim and
 * includes it: two starts at the same moment cannot both pass a seat at its cap minus one, since each counts the other's
 * claim (both may back off). The claim of the seat chosen stays. */
export function chooseSeat({ runs, resumeSeat = null, seats = ORDER, claim = null }) {
  if (resumeSeat !== null && !Object.hasOwn(SEATS, resumeSeat)) throw new Error(`seat ${resumeSeat} does not exist; the seats are 1 and 2`);
  const reasons = [];
  for (const seat of resumeSeat === null ? seats : [resumeSeat]) {
    const unclaim = claim ? claim(seat) : () => {};
    const n = liveCount(runs, seat);
    const use = seatUse(runs, seat);
    if (n > SEATS[seat].cap - (claim ? 0 : 1)) reasons.push(`seat ${seat}: ${n - (claim ? 1 : 0)} live sessions, at most ${SEATS[seat].cap}`);
    else if (use !== null && !(Number(use) < Number(SEATS[seat].stop))) reasons.push(`seat ${seat}: seven-day use ${use}, stops at ${SEATS[seat].stop}`);
    else return { seat, reasons };
    unclaim();
  }
  return { seat: null, reasons };
}

class Refused extends Error {}

const USAGE = 'usage: bin/seat <role> <brief file> --run <run folder> --work <work folder> [--tag <name>] [--resume <session id> --seat <n>] [--skill <name>]... [--allow <rule>]... [--add-dir <folder>]... [--max-turns <n>]';
const VALUE = { '--run': 'run', '--work': 'work', '--tag': 'tag', '--resume': 'resume', '--seat': 'seat', '--max-turns': 'maxTurns' };
const LIST = { '--skill': 'skills', '--allow': 'allow', '--add-dir': 'addDirs' };

/** The arguments of bin/seat as an object; a Refused error, in a sentence, for anything else. */
export function parseArgs(argv) {
  const o = { skills: [], allow: [], addDirs: [] };
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
  for (const [flag, value] of [['--resume', o.resume], ...o.allow.map((v) => ['--allow', v]), ...o.addDirs.map((v) => ['--add-dir', v])]) {
    if (typeof value === 'string' && value.startsWith('-')) throw new Refused(`${flag} ${value}: a value that starts with a dash is refused, since claude would read it as a flag`);
  }
  if (o.seat !== undefined && !/^[12]$/.test(o.seat)) throw new Refused(`seat ${o.seat} does not exist; the seats are 1 and 2`);
  if (o.seat !== undefined) o.seat = Number(o.seat);
  if (o.maxTurns !== undefined && !/^[1-9][0-9]*$/.test(o.maxTurns)) throw new Refused('--max-turns needs a whole number of at least 1');
  if (o.resume && o.seat === undefined) throw new Refused('a resume stays on its seat; give --seat <n>, the seat the session ran on');
  if (o.tag !== undefined && !/^[A-Za-z0-9._-]+$/.test(o.tag)) throw new Refused('--tag takes letters, digits, dot, dash and underscore');
  return o;
}

/** Seat 1's token from its file, trailing newlines stripped. Refuses, naming the path only, when the file is missing, empty
 * or holds any byte outside printable ASCII (0x21-0x7E): such a value would make Node throw an error that quotes it. */
function readToken(path) {
  let text = '';
  try {
    text = readFileSync(path, 'latin1').replace(/[\r\n]+$/, '');
  } catch {
    // Missing or unreadable: the same refusal below.
  }
  if (!/^[\x21-\x7e]+$/.test(text)) throw new Refused(`seat 1: the token file ${path} is missing, empty or not printable ASCII`);
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
  // The tag is claimed with a lock folder (mkdir is atomic) for as long as the start takes, so two starts of one tag cannot both pass the check.
  const release = claimTag(join(run, `run-${tag}.lock`), tag);
  try {
    return startSession({ o, env, home, runs, profiles, state, run, work, brief, tag });
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

function startSession({ o, env, home, runs, profiles, state, run, work, brief, tag }) {
  const pidFile = join(run, `run-${tag}.pid`);
  if (runLive(pidFile)) throw new Refused(`run-${tag} is already running (${readFileSync(pidFile, 'utf8').trim()}) in ${run}`);
  const seatFile = join(run, `run-${tag}.seat`);
  // The claim: this start's own pid in its pid file, with its seat, written before the count and removed if it backs off.
  // Until the supervisor exists the file holds bin/seat's pid, which counts as live (this user's, started before the file).
  const claim = (seat) => {
    writeFileSync(seatFile, `${seat}\n`);
    writeFileSync(pidFile, `${process.pid}\n`);
    return () => {
      rmSync(pidFile, { force: true });
      rmSync(seatFile, { force: true });
    };
  };
  const { seat, reasons } = chooseSeat({ runs, resumeSeat: o.seat ?? null, seats: PRESETS[o.role].seats, claim });
  if (seat === null) throw new Refused(`${reasons.join('\n')}\nno seat free`);
  try {
    return spawnSupervisor({ o, env, home, profiles, state, run, work, brief, tag, pidFile, seat });
  } catch (e) {
    rmSync(pidFile, { force: true });
    rmSync(seatFile, { force: true });
    throw e;
  }
}

function spawnSupervisor({ o, env, home, profiles, state, run, work, brief, tag, pidFile, seat }) {
  const tokenPath = join(profiles, 'seats/1/oauth-token');
  if (seat === 1) readToken(tokenPath); // refuses now; the supervisor reads it again, just before it starts claude

  // Neither bin/seat's environment nor the supervisor's holds the token, nor the caller's GitHub or API credentials.
  const child = { ...env, GH_CONFIG_DIR: join(run, '.gh-empty'), CLAUDE_CONFIG_DIR: join(profiles, 'seats', String(seat), 'claude') };
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete child[name];
  mkdirSync(child.GH_CONFIG_DIR, { recursive: true });
  const args = buildArgs({ role: o.role, run, home, resume: o.resume ?? null, skills: o.skills, allow: o.allow, addDirs: o.addDirs, maxTurns: o.maxTurns ? Number(o.maxTurns) : null, seat, tokenPath });
  const spec = {
    cmd: [...(onPath('caffeinate', env.PATH) ? ['caffeinate', '-i'] : []), 'claude', ...args], cwd: work, brief, jsonl: join(run, `run-${tag}.jsonl`), err: join(run, `run-${tag}.err`),
    childFile: join(run, `run-${tag}.child`), tokenPath: seat === 1 ? tokenPath : null, role: o.role, seat, tag, run, state, model: PRESETS[o.role].model, resume: o.resume ?? null, start: new Date().toISOString(),
  };
  for (const f of [spec.jsonl, spec.err]) writeFileSync(f, '');
  const sup = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise'], { cwd: work, detached: true, stdio: 'ignore', env: { ...child, FACTORY_SEAT_SUPERVISE: JSON.stringify(spec) } });
  if (!sup.pid) throw new Refused(`could not start the supervisor of run-${tag}`);
  sup.unref();
  writeFileSync(pidFile, `${sup.pid}\n`); // the claim's file, now the supervisor's pid
  return `bin/seat: ${tag} started ${sup.pid} on seat ${seat}\n`;
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
    role: spec.role, seat: spec.seat, tag: spec.tag, run: spec.run,
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
    if (spec.tokenPath) env.CLAUDE_CODE_OAUTH_TOKEN = readToken(spec.tokenPath);
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
      // A Node error can quote the environment, so anything but our own refusal prints its code and nothing else.
      process.stderr.write(`bin/seat: ${e instanceof Refused ? e.message : `failed (${e.code ?? e.name})`}\n`);
      process.exitCode = e instanceof Refused ? 2 : 1;
    }
  }
}
