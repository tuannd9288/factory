// bin/seat (#91): the one command that starts an unattended `claude -p` session. This file holds the role presets: the
// arguments each role gives claude. They come from the hand-written launchers of ~/factory-runs, role by role (see
// PRESETS). Nothing here reads a credential.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
    model: 'opus', effort: 'high', turns: 300, resumeTurns: 200, budget: 15, web: true,
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
  if (!p) throw new Error(`unknown role ${role}; the roles are ${ROLES.join(', ')}`);
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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** How many sessions of a seat have a live process. */
export function liveCount(runs, seat) {
  return runFiles(runs, '.pid').filter((p) => seatOf(p, '2') === String(seat) && alive(Number(readFileSync(p, 'utf8').trim()))).length;
}

/** The seven-day use the newest log of the seat that reports one gives (its last rate_limit_event), or null. */
export function seatUse(runs, seat) {
  const logs = runFiles(runs, '.jsonl').filter((f) => seatOf(f) === String(seat)).map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of logs) {
    const line = readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"type":"rate_limit_event"')).pop();
    if (!line) continue;
    let u;
    try {
      u = JSON.parse(line).rate_limit_info?.unifiedWindows?.seven_day?.utilization;
    } catch {
      continue;
    }
    if (u !== undefined && u !== null && u !== '') return u;
  }
  return null;
}

/** The seat a session runs on: resumeSeat when it is a resume, else the first of 2, 1 that is under its cap and its
 * stop. reasons say why each seat that was tried was passed over; with seat null, none was free. */
export function chooseSeat({ runs, resumeSeat = null }) {
  if (resumeSeat !== null && !SEATS[resumeSeat]) throw new Error(`seat ${resumeSeat} does not exist; the seats are 1 and 2`);
  const reasons = [];
  for (const seat of resumeSeat === null ? ORDER : [resumeSeat]) {
    const n = liveCount(runs, seat);
    const use = seatUse(runs, seat);
    if (n >= SEATS[seat].cap) reasons.push(`seat ${seat}: ${n} live sessions, at most ${SEATS[seat].cap}`);
    else if (use !== null && !(Number(use) < Number(SEATS[seat].stop))) reasons.push(`seat ${seat}: seven-day use ${use}, stops at ${SEATS[seat].stop}`);
    else return { seat, reasons };
  }
  return { seat: null, reasons };
}
