// The research eval's runner (#92): node probes/research-eval/run.mjs --set probe|full --run <run folder> --work <work folder> [--go]
// Starts the researcher sessions of the eval through bin/seat (#91), one at a time, two arms (A as the research session runs
// today, B the same with the Agent tool denied), grades each report with grade.mjs and prints what each run and each arm cost.
// Without --go it only prints the plan. See README.md for the decision rule.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS } from '../../bin/lib/seat.mjs';
import { grade } from './grade.mjs';
import { outsidePaths, realOf } from './paths.mjs';
import { briefOf, loadTasks, validateTask, verifyTask } from './keys.mjs';

// bin/seat is a one-line wrapper of this file; running the file with the same node needs no shell on the PATH.
const SEAT_JS = join(dirname(fileURLToPath(import.meta.url)), '../../bin/lib/seat.mjs');
export const ARMS = ['A', 'B'];
export const PROBE_TASKS = ['knip-reader', 'round4-review'];
const SETS = { probe: { runs: 1 }, full: { runs: 2 } };
// The tools that start helper agents: Agent (called Task before), and Workflow.
const HELPER_TOOLS = ['Agent', 'Task', 'Workflow'];
const DEFAULTS = { turns: 80, pollMs: 5000, timeoutMin: 45, limit: 24 };
// Printed with the results and kept in them: what the eval cannot show.
const NOTE = 'Both arms deny the web (WebFetch, WebSearch), so the helpers are the only difference; this departs from "A, as today". The eval measures helpers on research over files on disk and says nothing about helpers in web research, where the 13 helpers of #58, #68, #68b and #70 mostly worked.';

class Refused extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}
// Exit codes of the runner besides 0: 2 refused to start, 3 spend, 4 arm B broken, 5 stuck, 6 model changed, 7 a readable folder
// reaches an answer, 8 a run read outside its folders.
const EXIT_GUARD = 7;
const EXIT_INVALID = 8;

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

// The factory checkout this file sits in. A session never reads its eval folder (the keys), and no folder given to the runner
// may hold the checkout.
const CHECKOUT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../..'));

/** The folders of a session: its own run folder, one level under the runs folder where bin/seat counts sessions and reads the
 * seven-day use, and its own work folder under the folder the caller gave. Nothing else of the eval's is shared with it. */
export function sessionPaths(entry, { runsRoot, work, set }) {
  return { run: join(runsRoot, `re-${set}-${entry.tag.slice(3)}`), work: join(work, entry.tag) };
}

/** The arguments of bin/seat for a run. The session may read its own run folder and its task's folders (the narrowest that
 * hold its sources), not the keys. Both arms deny the web, since the tasks are answered from disk and a fetched page could
 * answer what the disk cannot; arm B also denies the tools that start helper agents. */
export function seatArgs(entry, { runsRoot, work, set, turns }) {
  const { run, work: cwd } = sessionPaths(entry, { runsRoot, work, set });
  return [
    'researcher', join(run, `${entry.tag}.md`), '--run', run, '--work', cwd, '--tag', entry.tag, '--max-turns', String(turns),
    ...(entry.task.readable ?? []).flatMap((r) => ['--add-dir', join(runsRoot, r)]),
    '--deny', 'WebFetch', '--deny', 'WebSearch', '--deny', `Read(/${CHECKOUT}/probes/research-eval/**)`,
    ...(entry.arm === 'B' ? HELPER_TOOLS.flatMap((t) => ['--deny', t]) : []),
  ];
}

/** The folders no readable folder may be, or hold, or sit in: every run and work folder of the plan, the keys of this checkout and
 * of every checkout the runner can name, and issue-92 (the reports). The runs folder itself is checked apart: a readable folder
 * sits in it, but may not be it or hold it. */
function forbidden(plan, { runsRoot, work, set, home }) {
  const keys = (root) => join(root, 'probes/research-eval/tasks');
  return [
    ...plan.flatMap((e) => Object.values(sessionPaths(e, { runsRoot, work, set }))),
    keys(CHECKOUT), keys(join(home, 'WORKSPACES')), keys(join(runsRoot, 'issue-92/w92')), join(runsRoot, 'issue-92'),
  ];
}

/** The tasks of a plan with a readable folder that is, holds or sits in a forbidden folder, one line each. Two paths meet when one
 * is the other or an ancestor of it, after `..` and symlinks are resolved. */
export function guardProblems(plan, opts) {
  const bad = forbidden(plan, opts).map((f) => realOf(resolve(f)));
  const root = realOf(resolve(opts.runsRoot));
  const out = [];
  for (const task of new Set(plan.map((e) => e.task))) {
    for (const r of task.readable ?? []) {
      const at = realOf(resolve(join(opts.runsRoot, r)));
      const hit = at === root || root.startsWith(`${at}/`) ? root : bad.find((b) => at === b || at.startsWith(`${b}/`) || b.startsWith(`${at}/`));
      if (hit) out.push(`${task.id}: its readable folder ${r} (${at}) is, holds or sits in ${hit}`);
    }
  }
  return out;
}

const SKIP = new Set(['node_modules', '.git']);

/** Why a folder given to the runner is refused, or null: it holds the checkout or is inside it, or it holds another session's
 * log or a task's key. The walk is bounded; a folder too big to check is refused. */
export function refusal(dir) {
  const d = realpathSync(dir);
  if (d === CHECKOUT || CHECKOUT.startsWith(`${d}/`)) return `${dir} holds the factory checkout`;
  if (d.startsWith(`${CHECKOUT}/`)) return `${dir} is inside the factory checkout`;
  let budget = 20000;
  const walk = (folder, depth) => {
    if (depth > 5) return null;
    for (const ent of readdirSync(folder, { withFileTypes: true })) {
      budget -= 1;
      if (budget < 0) return `${dir} is too big to check; give an empty folder`;
      const p = join(folder, ent.name);
      if (ent.isDirectory()) {
        const r = SKIP.has(ent.name) ? null : walk(p, depth + 1);
        if (r) return r;
      } else if (/^run-.*\.jsonl$/.test(ent.name)) return `${dir} holds a session's log, ${p}`;
      else if (/research-eval\/tasks\/[^/]+\.json$/.test(p)) return `${dir} holds a task key, ${p}`;
    }
    return null;
  };
  return walk(d, 0);
}

/** What a session's log says: whether it has an init event and its tools, the helper agents it started, the events that a
 * subagent wrote (they carry a parent_tool_use_id), and its tokens (all models, helpers included). */
export function metricsOf(text) {
  let tools = [];
  let init = false;
  let helpers = 0;
  let subagentEvents = 0;
  let usage = {};
  for (const l of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === 'system' && e.subtype === 'init') {
      init = true;
      if (Array.isArray(e.tools)) tools = e.tools;
    }
    if (e.parent_tool_use_id !== undefined && e.parent_tool_use_id !== null) subagentEvents += 1;
    if (e.type === 'assistant') helpers += (e.message?.content ?? []).filter((c) => c.type === 'tool_use' && HELPER_TOOLS.includes(c.name)).length;
    if (e.type === 'result' && e.modelUsage) usage = e.modelUsage;
  }
  const sum = (key) => Object.values(usage).reduce((s, u) => s + (u[key] ?? 0), 0);
  return {
    init, tools, helpers, subagentEvents,
    tokensIn: sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens'), tokensOut: sum('outputTokens'),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Each arm's totals (every run, since every run was paid for) and mean score; the tasks whose mean points differ between the
 * arms by a point or more; and B's mean score minus A's. An invalid run is not scored, and neither is its partner (the other
 * arm's run of the same task and repetition), so that no comparison rests on a pair with an invalid arm. */
export function summarize(results) {
  const scored = results.filter((r) => !r.invalid && !results.some((o) => o.invalid && o.task === r.task && o.rep === r.rep && o.arm !== r.arm));
  const arms = {};
  for (const arm of ARMS) {
    const rs = results.filter((r) => r.arm === arm);
    const total = (key) => rs.reduce((s, r) => s + r[key], 0);
    arms[arm] = { runs: rs.length, meanScore: mean(scored.filter((r) => r.arm === arm).map((r) => r.score)), tokensIn: total('tokensIn'), tokensOut: total('tokensOut'), minutes: total('minutes'), cost: total('cost') };
  }
  const flipped = [...new Set(scored.map((r) => r.task))].filter((task) => {
    const [a, b] = ARMS.map((arm) => mean(scored.filter((r) => r.task === task && r.arm === arm).map((r) => r.points)));
    return a !== null && b !== null && Math.abs(a - b) >= 1 - 1e-9;
  });
  const delta = arms.A.meanScore !== null && arms.B.meanScore !== null ? arms.B.meanScore - arms.A.meanScore : null;
  return { arms, flipped, delta };
}

const usd = (n) => `$${n.toFixed(2)}`;

function parse(argv) {
  const o = { go: false, turns: DEFAULTS.turns, pollMs: DEFAULTS.pollMs, timeoutMin: DEFAULTS.timeoutMin };
  const value = { '--set': 'set', '--run': 'run', '--work': 'work', '--limit-usd': 'limit', '--turns': 'turns', '--poll-ms': 'pollMs', '--timeout-min': 'timeoutMin' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--go') o.go = true;
    else if (argv[i] === '--skip-key-check') o.skipKeyCheck = true; // for the tests, which hold none of the sources
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

/** The problems of the keys of the tasks in a plan: a shape that is wrong, no readable folders, a fact that no longer holds. */
function keyProblems(plan, runsRoot) {
  const out = [];
  for (const task of new Set(plan.map((e) => e.task))) {
    for (const p of validateTask(task)) out.push(`${task.id}: ${p}`);
    if (!Array.isArray(task.readable) || task.readable.length === 0) out.push(`${task.id}: no readable folders`);
    for (const p of verifyTask(task, runsRoot)) out.push(`${task.id} ${p.id}: ${p.why}`);
  }
  return out;
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
  const opts = { runsRoot, work: o.work, set: o.set, turns: o.turns };
  const full = { tasks: tasks.length, runs: SETS.full.runs };
  for (const dir of [o.run, o.work]) {
    const why = refusal(dir);
    if (why) throw new Refused(why);
  }
  const reaching = guardProblems(plan, { ...opts, home: env.HOME });
  if (reaching.length) throw new Refused(`a readable folder reaches an answer, so nothing was started:\n${reaching.join('\n')}`, EXIT_GUARD);
  if (!o.go) {
    for (const e of plan) console.log(`dry: ${e.tag}: bin/seat ${seatArgs(e, opts).join(' ')}`);
    console.log(`not started: add --go to run these ${plan.length} sessions, one at a time; none starts that could take the spend past ${usd(o.limit)}, counting each at the researcher preset's ${usd(PRESETS.researcher.budget)} budget, which is a request to claude and not a proven limit on a subscription seat`);
    return 0;
  }
  if (!o.skipKeyCheck) {
    const problems = keyProblems(plan, runsRoot);
    if (problems.length) throw new Refused(`the keys do not hold, so nothing was started:\n${problems.slice(0, 20).join('\n')}`);
  } else console.log('keys not checked');
  // A folder left by an earlier session of a tag would hand that session's log to this one.
  for (const e of plan) {
    const p = sessionPaths(e, opts);
    for (const dir of [p.run, p.work]) if (existsSync(dir) && readdirSync(dir).length > 0) throw new Refused(`${dir} is left from an earlier run of ${e.tag}; remove it first`);
  }
  const results = [];
  let spent = 0;
  let model = null;
  let code = 0;
  const stop = (line, c) => {
    console.log(`stopped: ${line}`);
    code = c;
  };
  for (const e of plan) {
    // The limit is a ceiling: a session counts at the preset's budget, which is a request to claude and not a proven limit
    // on a subscription seat, so none starts that could take the spend past the limit.
    if (spent + PRESETS.researcher.budget > o.limit) {
      stop(`the next session could pass the limit: spent ${usd(spent)} plus the preset's budget ${usd(PRESETS.researcher.budget)} would pass ${usd(o.limit)}, before ${e.tag}`, 3);
      break;
    }
    const p = sessionPaths(e, opts);
    mkdirSync(p.run, { recursive: true });
    mkdirSync(p.work, { recursive: true });
    writeFileSync(join(p.run, `${e.tag}.md`), briefOf(e.task, runsRoot));
    const since = Date.now();
    const started = spawnSync(process.execPath, [SEAT_JS, ...seatArgs(e, opts)], { encoding: 'utf8', env });
    if (started.status !== 0) {
      // Nothing of the session exists, so a later start of the tag is not refused for a folder it left.
      for (const dir of [p.run, p.work]) rmSync(dir, { recursive: true, force: true });
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
    const log = join(p.run, `run-${e.tag}.jsonl`);
    const text = existsSync(log) ? readFileSync(log, 'utf8') : null;
    const m = metricsOf(text ?? '');
    // The paths of the session's tool inputs, checked before the report is graded. A session with no log cannot be checked.
    const invalid = text === null ? [{ tool: '-', path: '(its log could not be read)' }]
      : outsidePaths(text, { cwd: p.work, inside: [p.run, p.work, ...(e.task.readable ?? []).map((r) => join(runsRoot, r))], home: env.HOME });
    const g = invalid.length ? null : grade(e.task, rec.structured);
    const cost = rec.total_cost_usd ?? PRESETS.researcher.budget;
    spent += cost;
    results.push({ tag: e.tag, task: e.task.id, arm: e.arm, rep: e.rep, points: g?.points ?? null, max: g?.max ?? null, score: g?.score ?? null, ...(invalid.length ? { invalid } : {}), cost, minutes: rec.minutes, tokensIn: m.tokensIn, tokensOut: m.tokensOut, helpers: m.helpers, ended: rec.ended, model: rec.model, tools: m.tools });
    console.log(`${e.tag} ${g ? `score ${g.points}/${g.max}` : `INVALID: not scored; read outside its folders: ${invalid.map((x) => x.path).join(', ')}`} tokens ${m.tokensIn} in ${m.tokensOut} out minutes ${rec.minutes} cost ${usd(cost)} helpers ${m.helpers} ended ${rec.ended}${rec.ended === 'success' ? '' : ' (cut or failed, not a low score)'}${rec.total_cost_usd == null ? ' (cost unknown, counted at the cap)' : ''}`);
    // Arm B must be without helpers: it stops the set when the log cannot show that, or shows a helper.
    const leaked = HELPER_TOOLS.find((t) => m.tools.includes(t));
    const broken = e.arm !== 'B' ? null
      : !m.init ? `${e.tag} wrote no init event, so its tools are unknown`
        : leaked ? `${e.tag} had the ${leaked} tool, so arm B is not arm B`
          : m.helpers > 0 ? `${e.tag} started ${m.helpers} helper${m.helpers === 1 ? '' : 's'}, so arm B is not arm B`
            : m.subagentEvents > 0 ? `${e.tag} had ${m.subagentEvents} events from a subagent, so arm B is not arm B` : null;
    if (broken) {
      stop(broken, 4);
      break;
    }
    model ??= rec.model;
    if (rec.model !== model) {
      stop(`${e.tag} ran on ${rec.model}, not ${model}`, 6);
      break;
    }
    if (invalid.length) {
      stop(`${e.tag} read outside its folders: ${invalid.map((x) => x.path).join(', ')}`, EXIT_INVALID);
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
      if (a.runs) console.log(`arm ${arm}: ${a.runs} runs, mean score ${a.meanScore === null ? 'none (no run scored)' : a.meanScore.toFixed(2)}, tokens ${a.tokensIn} in / ${a.tokensOut} out, minutes ${a.minutes.toFixed(2)}, cost ${usd(a.cost)}`);
    }
    if (s.delta !== null) console.log(`B minus A: ${s.delta.toFixed(2)}; flipped: ${s.flipped.length ? s.flipped.join(', ') : 'none'}`);
    const invalid = results.filter((r) => r.invalid);
    if (invalid.length) console.log(`${invalid.length} invalid run${invalid.length === 1 ? '' : 's'} (${invalid.map((r) => r.tag).join(', ')}): not scored, and the partner of each is not compared${s.delta === null ? '; no comparison' : ''}`);
    const per = ARMS.map((arm) => (s.arms[arm].runs ? s.arms[arm] : null));
    if (per.every(Boolean)) {
      const n = full.tasks * full.runs;
      const cost = per.reduce((t, a) => t + (a.cost / a.runs) * n, 0);
      const minutes = per.reduce((t, a) => t + (a.minutes / a.runs) * n, 0);
      console.log(`estimate for the full set (${full.tasks} tasks x ${full.runs} runs x 2 arms): ${usd(cost)}, about ${Math.round(minutes)} minutes, from these ${results.length} runs`);
    } else console.log('estimate for the full set: not yet, it needs a run of each arm');
    console.log(`spent ${usd(spent)} of the ${usd(o.limit)} limit`);
    console.log(`note: ${NOTE}`);
    writeFileSync(join(o.run, `research-eval-${o.set}.json`), `${JSON.stringify({ set: o.set, limit: o.limit, spent, keyCheck: !o.skipKeyCheck, note: NOTE, results, summary: s }, null, 2)}\n`);
  }
  return code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`research-eval: ${e.message}\n`);
    process.exitCode = e.exitCode;
  }
}
