// The research eval's runner (#92): node probes/research-eval/run.mjs --set probe|full --run <run folder> --work <work folder> [--go]
// Starts the researcher sessions of the eval through bin/seat (#91), one at a time, two arms (A as the research session runs
// today, B the same with the Agent tool denied), grades each report with grade.mjs and prints what each run and each arm cost.
// Without --go it only prints the plan. See README.md for the decision rule.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS } from '../../bin/lib/seat.mjs';
import { grade } from './grade.mjs';
import { briefOf, loadTasks } from './keys.mjs';

// bin/seat is a one-line wrapper of this file; running the file with the same node needs no shell on the PATH.
const SEAT_JS = join(dirname(fileURLToPath(import.meta.url)), '../../bin/lib/seat.mjs');
export const ARMS = ['A', 'B'];
export const PROBE_TASKS = ['knip-reader', 'round4-review'];
const SETS = { probe: { runs: 1 }, full: { runs: 2 } };
const HELPER_TOOLS = ['Agent', 'Task'];
const DEFAULTS = { turns: 80, pollMs: 5000, timeoutMin: 45, limit: 24 };

class Refused extends Error {}

/** The runs of a set, in the order they start: for each repetition, each task with its two arms, the arm that goes first
 * alternating from task to task so that neither arm always runs first. */
export function planRuns(tasks, set) {
  const chosen = set === 'probe' ? PROBE_TASKS.map((id) => tasks.find((t) => t.id === id)) : [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const plan = [];
  for (let rep = 1; rep <= SETS[set].runs; rep += 1) {
    chosen.forEach((task, i) => {
      for (const arm of i % 2 === 0 ? ARMS : [...ARMS].reverse()) plan.push({ tag: `re-${task.id}-${arm}-${rep}`, task, arm, rep });
    });
  }
  return plan;
}

/** The arguments of bin/seat for a run. Both arms deny the web, since the tasks are answered from disk and a fetched page
 * could answer what the disk cannot; arm B also denies the tool that starts helper agents. */
export function seatArgs(entry, { run, work, runsRoot, turns }) {
  return [
    'researcher', join(run, `${entry.tag}.md`), '--run', run, '--work', work, '--tag', entry.tag, '--max-turns', String(turns),
    ...entry.task.sources.flatMap((s) => ['--add-dir', join(runsRoot, s)]),
    '--deny', 'WebFetch', '--deny', 'WebSearch',
    ...(entry.arm === 'B' ? HELPER_TOOLS.flatMap((t) => ['--deny', t]) : []),
  ];
}

/** What a session's log says: its tools, the helper agents it started, and its tokens (all models, helpers included). */
export function metricsOf(text) {
  let tools = [];
  let helpers = 0;
  let usage = {};
  for (const l of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === 'system' && e.subtype === 'init' && Array.isArray(e.tools)) tools = e.tools;
    if (e.type === 'assistant') helpers += (e.message?.content ?? []).filter((c) => c.type === 'tool_use' && HELPER_TOOLS.includes(c.name)).length;
    if (e.type === 'result' && e.modelUsage) usage = e.modelUsage;
  }
  const sum = (key) => Object.values(usage).reduce((s, u) => s + (u[key] ?? 0), 0);
  return {
    tools, helpers,
    tokensIn: sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens'), tokensOut: sum('outputTokens'),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Each arm's totals and mean score; the tasks whose mean points differ between the arms by a point or more; and B's mean
 * score minus A's. */
export function summarize(results) {
  const arms = {};
  for (const arm of ARMS) {
    const rs = results.filter((r) => r.arm === arm);
    const total = (key) => rs.reduce((s, r) => s + r[key], 0);
    arms[arm] = { runs: rs.length, meanScore: mean(rs.map((r) => r.score)), tokensIn: total('tokensIn'), tokensOut: total('tokensOut'), minutes: total('minutes'), cost: total('cost') };
  }
  const flipped = [...new Set(results.map((r) => r.task))].filter((task) => {
    const [a, b] = ARMS.map((arm) => mean(results.filter((r) => r.task === task && r.arm === arm).map((r) => r.points)));
    return a !== null && b !== null && Math.abs(a - b) >= 1 - 1e-9;
  });
  const delta = arms.A.runs && arms.B.runs ? arms.B.meanScore - arms.A.meanScore : null;
  return { arms, flipped, delta };
}

const usd = (n) => `$${n.toFixed(2)}`;

function parse(argv) {
  const o = { go: false, turns: DEFAULTS.turns, pollMs: DEFAULTS.pollMs, timeoutMin: DEFAULTS.timeoutMin };
  const value = { '--set': 'set', '--run': 'run', '--work': 'work', '--limit-usd': 'limit', '--turns': 'turns', '--poll-ms': 'pollMs', '--timeout-min': 'timeoutMin' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--go') o.go = true;
    else if (argv[i] in value && i + 1 < argv.length) o[value[argv[i]]] = argv[++i];
    else throw new Refused(`unknown option or missing value: ${argv[i]}`);
  }
  if (!Object.hasOwn(SETS, o.set ?? '')) throw new Refused('--set probe|full is needed: probe is 2 tasks, 1 run each arm; full is 10 tasks, 2 runs each arm');
  for (const k of ['run', 'work']) if (!o[k] || !existsSync(o[k]) || !statSync(o[k]).isDirectory()) throw new Refused(`--${k} <folder> is needed, and must be a folder`);
  if (o.set === 'full' && o.go && o.limit === undefined) throw new Refused('the full set needs --limit-usd <dollars>, chosen by whoever starts it');
  for (const k of ['limit', 'turns', 'pollMs', 'timeoutMin']) {
    if (o[k] === undefined) continue;
    if (!(Number(o[k]) > 0)) throw new Refused(`--${k === 'limit' ? 'limit-usd' : k} needs a positive number`);
    o[k] = Number(o[k]);
  }
  o.limit ??= DEFAULTS.limit;
  return o;
}

const recordOf = (state, tag, since) => {
  const file = join(state, 'sessions.jsonl');
  if (!existsSync(file)) return null;
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return rows.findLast((r) => r.tag === tag && Date.parse(r.start) >= since) ?? null;
};

async function main(argv, env) {
  const o = parse(argv);
  const tasks = loadTasks();
  const runsRoot = env.FACTORY_RUNS ?? join(env.HOME, 'factory-runs');
  const state = env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory');
  const plan = planRuns(tasks, o.set);
  const opts = { run: o.run, work: o.work, runsRoot, turns: o.turns };
  const full = { tasks: tasks.length, runs: SETS.full.runs };
  if (!o.go) {
    for (const e of plan) console.log(`dry: ${e.tag}: bin/seat ${seatArgs(e, opts).join(' ')}`);
    console.log(`not started: add --go to run these ${plan.length} sessions, one at a time, stopping when the spend passes ${usd(o.limit)}; each session is capped at ${usd(PRESETS.researcher.budget)} by the researcher preset`);
    return 0;
  }
  const results = [];
  let spent = 0;
  let code = 0;
  const stop = (line, c) => {
    console.log(`stopped: ${line}`);
    code = c;
  };
  for (const e of plan) {
    writeFileSync(join(o.run, `${e.tag}.md`), briefOf(e.task, runsRoot));
    const since = Date.now();
    const started = spawnSync(process.execPath, [SEAT_JS, ...seatArgs(e, opts)], { encoding: 'utf8', env });
    if (started.status !== 0) {
      stop(`bin/seat refused ${e.tag}: ${(started.stderr + started.stdout).trim()}`, 2);
      break;
    }
    let rec = null;
    while (!rec && Date.now() - since < o.timeoutMin * 60000) {
      await sleep(o.pollMs);
      rec = recordOf(state, e.tag, since);
    }
    if (!rec) {
      stop(`${e.tag} wrote no record in ${o.timeoutMin} minutes; it may still be running`, 5);
      break;
    }
    const log = join(o.run, `run-${e.tag}.jsonl`);
    const m = metricsOf(existsSync(log) ? readFileSync(log, 'utf8') : '');
    const g = grade(e.task, rec.structured);
    const cost = rec.total_cost_usd ?? PRESETS.researcher.budget;
    spent += cost;
    results.push({ tag: e.tag, task: e.task.id, arm: e.arm, rep: e.rep, points: g.points, max: g.max, score: g.score, cost, minutes: rec.minutes, tokensIn: m.tokensIn, tokensOut: m.tokensOut, helpers: m.helpers, ended: rec.ended, tools: m.tools });
    console.log(`${e.tag} score ${g.points}/${g.max} tokens ${m.tokensIn} in ${m.tokensOut} out minutes ${rec.minutes} cost ${usd(cost)} helpers ${m.helpers}${rec.total_cost_usd == null ? ' (cost unknown, counted at the cap)' : ''}`);
    if (e.arm === 'B' && m.tools.some((t) => HELPER_TOOLS.includes(t))) {
      stop(`${e.tag} had the Agent tool, so arm B is not arm B`, 4);
      break;
    }
    if (spent > o.limit) {
      stop(`spend ${usd(spent)} passed the limit of ${usd(o.limit)} after ${e.tag}`, 3);
      break;
    }
  }
  if (results.length) {
    const s = summarize(results);
    for (const arm of ARMS) {
      const a = s.arms[arm];
      if (a.runs) console.log(`arm ${arm}: ${a.runs} runs, mean score ${a.meanScore.toFixed(2)}, tokens ${a.tokensIn} in / ${a.tokensOut} out, minutes ${a.minutes.toFixed(2)}, cost ${usd(a.cost)}`);
    }
    if (s.delta !== null) console.log(`B minus A: ${s.delta.toFixed(2)}; flipped: ${s.flipped.length ? s.flipped.join(', ') : 'none'}`);
    const per = ARMS.map((arm) => (s.arms[arm].runs ? s.arms[arm] : null));
    if (per.every(Boolean)) {
      const n = full.tasks * full.runs;
      const cost = per.reduce((t, a) => t + (a.cost / a.runs) * n, 0);
      const minutes = per.reduce((t, a) => t + (a.minutes / a.runs) * n, 0);
      console.log(`estimate for the full set (${full.tasks} tasks x ${full.runs} runs x 2 arms): ${usd(cost)}, about ${Math.round(minutes)} minutes, from these ${results.length} runs`);
    } else console.log('estimate for the full set: not yet, it needs a run of each arm');
    console.log(`spent ${usd(spent)} of the ${usd(o.limit)} limit`);
    writeFileSync(join(o.run, `research-eval-${o.set}.json`), `${JSON.stringify({ set: o.set, limit: o.limit, spent, results, summary: s }, null, 2)}\n`);
  }
  return code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`research-eval: ${e.message}\n`);
    process.exitCode = 2;
  }
}
