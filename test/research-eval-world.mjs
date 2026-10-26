// The fixture of the research eval's runner tests (#92): the bin/seat world of seat-world.mjs with a fake `claude` (never a live
// one) that prints what a session prints and logs, for each call, its argv, its folder and what lies in the folders it may read.
// The fake does not read the brief. It takes its task, its cost and the other details of call n from the n-th step of FAKE_SCRIPT
// (a JSON array; an absent step is the default one), and its arm from the deny rules in argv.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { world } from './seat-world.mjs';

export const RUN_JS = join(factory, 'probes/research-eval/run.mjs');
export const PROBE = ['knip-reader', 'round4-review'];
/** The tasks of the probe's four calls, in the order the runner starts them. */
export const PROBE_CALLS = [PROBE[0], PROBE[0], PROBE[1], PROBE[1]];

// step: { task, cost (null: none in the result), model, ended, noInit, leak (tools stay), tools (extra), parent (an event from a
// subagent), helpers (Agent calls, in either arm), workflow (Workflow calls), hang (no result for a few seconds) }
const FAKE = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const e = process.env;
  const argv = process.argv.slice(2);
  const prior = fs.existsSync(e.FAKE_LOG) ? fs.readFileSync(e.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).length : 0;
  const step = (JSON.parse(e.FAKE_SCRIPT || '[]')[prior]) || {};
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1, argv.indexOf('--output-format'));
  const arm = denied.includes('Agent') ? 'B' : 'A';
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), depth + 1).map((f) => d.name + '/' + f) : [d.name]));
  };
  const dirs = [process.cwd()];
  argv.forEach((a, i) => { if (a === '--add-dir') dirs.push(argv[i + 1]); });
  const seen = {};
  for (const d of dirs) seen[d] = walk(d, 0);
  fs.appendFileSync(e.FAKE_LOG, JSON.stringify({ n: prior, argv, arm, denied, cwd: process.cwd(), addDirs: dirs.slice(1), seen, stdin: Buffer.concat(chunks).length }) + '\\n');
  const line = (o) => console.log(JSON.stringify(o));
  const model = step.model || 'claude-opus-5-5';
  const tools = ['Read', 'Bash', 'Agent', 'Task', 'Workflow'].filter((t) => step.leak || !denied.includes(t)).concat(step.tools || []);
  if (!step.noInit) line({ type: 'system', subtype: 'init', session_id: 's-' + process.pid, model, tools });
  for (let i = 0; i < (step.helpers === undefined ? (arm === 'A' ? 2 : 0) : step.helpers); i += 1) line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: {} }] } });
  for (let i = 0; i < (step.workflow || 0); i += 1) line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow', input: {} }] } });
  if (step.parent) line({ type: 'user', parent_tool_use_id: 'toolu_x', message: { content: [] } });
  if (step.hang) { setTimeout(() => process.exit(0), 6000); return; }
  const report = JSON.parse(e.FAKE_REPORTS)[step.task][arm];
  const result = { type: 'result', subtype: step.ended || 'success', is_error: false, session_id: 's-' + process.pid, num_turns: 5, duration_ms: 10,
    modelUsage: { [model]: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 50 } }, structured_output: report };
  if (step.cost !== null) result.total_cost_usd = step.cost === undefined ? (arm === 'A' ? 1.5 : 1) : step.cost;
  line(result);
});
`;

/** A good report (from the task's own examples) for arm A and one that guesses for arm B, for every task. */
export async function reports() {
  const { loadTasks } = await import('../probes/research-eval/keys.mjs');
  const out = {};
  for (const t of loadTasks()) {
    out[t.id] = {
      A: { conclusion: 'c', evidence: [...t.facts.map((f) => f.example), `${t.unreadable.id}: not readable`], couldNotRead: [t.unreadable.example], needsHuman: [] },
      B: { conclusion: 'c', evidence: t.facts.map((f) => `${f.id}: unknown`), couldNotRead: [t.unreadable.example], needsHuman: [] },
    };
  }
  return out;
}

/** A seat world with the fake claude. w.eval(args, script, opts) runs the runner; w.calls() are the fake's log lines. With
 * opts.keys the runner checks the keys; otherwise it is given --skip-key-check, since the world holds none of the sources. */
export async function evalWorld(body) {
  const fakeReports = JSON.stringify(await reports());
  return world(async (w) => {
    writeFileSync(join(w.bin, 'claude'), FAKE);
    chmodSync(join(w.bin, 'claude'), 0o755);
    w.log = join(w.root, 'fake.log');
    w.calls = () => (existsSync(w.log) ? readFileSync(w.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    w.eval = (args, script = [], { keys = false } = {}) => {
      // Each run of the runner starts from a world without the last one's calls; its session folders are removed once it ends.
      rmSync(w.log, { force: true });
      const steps = PROBE_CALLS.map((task, i) => ({ task, ...(script[i] ?? {}) }));
      const r = spawnSync(process.execPath, [RUN_JS, '--run', w.run, '--work', w.work, '--poll-ms', '40', ...(keys ? [] : ['--skip-key-check']), ...args], {
        encoding: 'utf8', cwd: w.root, timeout: 90000,
        env: w.env({ FAKE_LOG: w.log, FAKE_REPORTS: fakeReports, FAKE_SCRIPT: JSON.stringify(steps) }),
      });
      killSessions(w);
      for (const n of readdirSync(w.runs)) if (n.startsWith('re-')) rmSync(join(w.runs, n), { recursive: true, force: true });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    try {
      return await body(w);
    } finally {
      killSessions(w);
    }
  });
}

// The sessions of the eval sit in run folders of their own under the runs folder; no test leaves one running.
function killSessions(w) {
  for (const folder of existsSync(w.runs) ? readdirSync(w.runs) : []) {
    const dir = join(w.runs, folder);
    for (const n of readdirSync(dir)) {
      if (!/^run-.*\.(pid|child)$/.test(n) || n.startsWith('run-fill')) continue;
      const pid = Number(readFileSync(join(dir, n), 'utf8'));
      for (const target of [pid, -pid]) {
        try {
          if (pid > 1) process.kill(target, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  }
}
