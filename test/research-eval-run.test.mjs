// The research eval's runner (#92), against bin/seat and a fake `claude` (never a live one): the plan it prints without
// starting anything, the sessions it starts one at a time for two arms, what it prints for each, and the three ways it stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { fill, world } from './seat-world.mjs';

const RUN_JS = join(factory, 'probes/research-eval/run.mjs');
const PROBE = ['knip-reader', 'round4-review'];

// A claude that prints what a session prints: an init event with its tools (minus the denied ones), some Agent calls on arm A,
// and a result with usage, cost and the report for its task and arm. It logs argv and the brief to FAKE_LOG.
const FAKE = `#!${process.execPath}
const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const e = process.env;
  const argv = process.argv.slice(2);
  const brief = Buffer.concat(chunks).toString();
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1, argv.indexOf('--output-format'));
  const arm = denied.includes('Agent') ? 'B' : 'A';
  const task = brief.split('Research task ')[1].split(':')[0];
  fs.appendFileSync(e.FAKE_LOG, JSON.stringify({ at: Date.now(), argv, brief, arm, task }) + '\\n');
  const line = (o) => console.log(JSON.stringify(o));
  const tools = ['Read', 'Bash', 'Agent', 'Task'].filter((t) => e.FAKE_LEAK === '1' || !denied.includes(t));
  line({ type: 'system', subtype: 'init', session_id: 's-' + process.pid, model: 'claude-opus-5-5', tools });
  if (arm === 'A') for (let i = 0; i < Number(e.FAKE_HELPERS || 0); i += 1) line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: {} }] } });
  const report = JSON.parse(e.FAKE_REPORTS)[task][arm];
  line({ type: 'result', subtype: 'success', is_error: false, session_id: 's-' + process.pid, num_turns: 5, duration_ms: 10,
    total_cost_usd: Number(arm === 'A' ? e.FAKE_COST_A : e.FAKE_COST_B),
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 50 } },
    structured_output: report });
});
`;

const lib = () => import('../probes/research-eval/keys.mjs');

async function reports() {
  const { loadTasks } = await lib();
  const out = {};
  for (const t of loadTasks()) {
    out[t.id] = {
      A: { conclusion: 'c', evidence: [...t.facts.map((f) => f.example), `${t.unreadable.id}: not readable`], couldNotRead: [t.unreadable.example], needsHuman: [] },
      B: { conclusion: 'c', evidence: t.facts.map((f) => `${f.id}: unknown`), couldNotRead: [t.unreadable.example], needsHuman: [] },
    };
  }
  return out;
}

async function evalWorld(body) {
  const fakeReports = JSON.stringify(await reports());
  return world(async (w) => {
    writeFileSync(join(w.bin, 'claude'), FAKE);
    chmodSync(join(w.bin, 'claude'), 0o755);
    w.log = join(w.root, 'fake.log');
    w.calls = () => (existsSync(w.log) ? readFileSync(w.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    w.eval = (args, extra = {}) => {
      const r = spawnSync(process.execPath, [RUN_JS, '--run', w.run, '--work', w.work, '--poll-ms', '40', ...args], {
        encoding: 'utf8', cwd: w.root, timeout: 90000,
        env: w.env({ FAKE_LOG: w.log, FAKE_REPORTS: fakeReports, FAKE_COST_A: '1.5', FAKE_COST_B: '1', FAKE_HELPERS: '2', ...extra }),
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    return body(w);
  });
}

test('without --go the probe is only printed: four runs, the exact bin/seat command of each, and nothing is started', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe']);
  assert.equal(r.code, 0, r.out + r.err);
  const lines = r.out.split('\n').filter((l) => l.startsWith('dry: '));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.match(/dry: (re-\S+):/)[1]), PROBE.flatMap((t, i) => (i === 0 ? ['A', 'B'] : ['B', 'A']).map((arm) => `re-${t}-${arm}-1`)));
  for (const l of lines) {
    assert.match(l, /bin\/seat researcher \S+\/re-\S+\.md --run \S+ --work \S+ --tag re-\S+ --max-turns 80 /);
    assert.match(l, /--deny WebFetch --deny WebSearch/);
    assert.equal(/--deny Agent --deny Task$/.test(l), /-B-1:/.test(l), l);
  }
  assert.match(lines[0], /--add-dir \S+\/issue-70 /);
  assert.deepEqual(readdirSync(w.run).filter((n) => n.startsWith('run-')), [], 'no session was started');
  assert.deepEqual(w.calls(), []);
  assert.match(r.out, /not started: add --go/);
}));

test('--go runs the probe one session at a time and prints each run\'s score, tokens, minutes and cost, then each arm\'s, then the full-set estimate', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 0, r.out + r.err);
  const calls = w.calls();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => `${c.task}:${c.arm}`), ['knip-reader:A', 'knip-reader:B', 'round4-review:B', 'round4-review:A']);
  for (const c of calls) {
    assert.equal(c.argv[c.argv.indexOf('--max-turns') + 1], '80');
    assert.match(c.brief, /F1\./);
  }
  const records = w.records();
  assert.equal(records.length, 4);
  records.forEach((rec, i) => i > 0 && assert.ok(Date.parse(rec.start) >= Date.parse(records[i - 1].end), 'a session starts after the last one ended'));
  const run = r.out.match(/^re-knip-reader-A-1 .*$/m)[0];
  assert.match(run, /score 6\/6/);
  assert.match(run, /tokens 1150 in 20 out/);
  assert.match(run, /minutes \d+(\.\d+)?/);
  assert.match(run, /cost \$1\.50/);
  assert.match(run, /helpers 2/);
  assert.match(r.out.match(/^re-knip-reader-B-1 .*$/m)[0], /score 1\/6.*cost \$1\.00.*helpers 0/);
  assert.match(r.out, /^arm A: 2 runs, mean score 1\.00, .*cost \$3\.00/m);
  assert.match(r.out, /^arm B: 2 runs, mean score 0\.17, .*cost \$2\.00/m);
  assert.match(r.out, /^B minus A: -0\.83; flipped: knip-reader, round4-review$/m);
  // 20 runs of an arm at the mean cost of the probe's runs: A 20 x 1.50, B 20 x 1.00.
  assert.match(r.out, /^estimate for the full set \(10 tasks x 2 runs x 2 arms\): \$50\.00/m);
  assert.match(r.out, /^spent \$5\.00 of the \$24\.00 limit$/m);
}));

test('it stops when the spend passes the limit, after the run that passed it, and says so with exit 3', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], { FAKE_COST_A: '10', FAKE_COST_B: '10' });
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(w.calls().length, 3, 'the third run took the spend to $30; the fourth never started');
  assert.match(r.out, /^stopped: spend \$30\.00 passed the limit of \$24\.00 after re-round4-review-B-1$/m);
}));

test('a spend that only reaches the limit does not stop it, and --limit-usd moves the limit', () => evalWorld((w) => {
  const exact = w.eval(['--set', 'probe', '--go', '--limit-usd', '40'], { FAKE_COST_A: '10', FAKE_COST_B: '10' });
  assert.equal(exact.code, 0, exact.out + exact.err);
  assert.equal(w.calls().length, 4);
  assert.match(exact.out, /^spent \$40\.00 of the \$40\.00 limit$/m);
}));

test('arm B with an Agent tool still in its session is a broken arm: the runner stops at once with exit 4', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go'], { FAKE_LEAK: '1' });
  assert.equal(r.code, 4, r.out + r.err);
  assert.equal(w.calls().length, 2, 'A, then B, which had the tool');
  assert.match(r.out, /^stopped: re-knip-reader-B-1 had the Agent tool, so arm B is not arm B$/m);
}));

test('a refusal by bin/seat (no free seat) stops it with exit 2, naming the refusal, with nothing started', () => evalWorld((w) => {
  fill(w, 2, 4);
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /seat 2: 4 live sessions/);
  assert.match(r.out, /^stopped: bin\/seat refused re-knip-reader-A-1/m);
  assert.deepEqual(w.calls(), []);
}));

test('the full set needs a limit named by the person who starts it, and a set must be named', () => evalWorld((w) => {
  const full = w.eval(['--set', 'full', '--go']);
  assert.equal(full.code, 2, full.out + full.err);
  assert.match(full.err, /--limit-usd/);
  const none = w.eval([]);
  assert.equal(none.code, 2);
  assert.match(none.err, /--set/);
  assert.deepEqual(w.calls(), []);
  const dry = w.eval(['--set', 'full']);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.out.split('\n').filter((l) => l.startsWith('dry: ')).length, 40);
}));

test('summarize: each arm\'s mean score, and a task flips when its mean score differs between the arms by a point or more', async () => {
  const { summarize } = await import('../probes/research-eval/run.mjs');
  const run = (task, arm, rep, points, max = 6) => ({ task, arm, rep, points, max, score: points / max, cost: 1, minutes: 2, tokensIn: 10, tokensOut: 1 });
  const s = summarize([run('a', 'A', 1, 6), run('a', 'A', 2, 4), run('a', 'B', 1, 5), run('a', 'B', 2, 5), run('b', 'A', 1, 3), run('b', 'B', 1, 4), run('c', 'A', 1, 2), run('c', 'B', 1, 2)]);
  assert.equal(s.arms.A.runs, 4);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(s.arms.A.meanScore, (6 + 4 + 3 + 2) / 4 / 6);
  near(s.arms.B.meanScore, (5 + 5 + 4 + 2) / 4 / 6);
  assert.deepEqual(s.flipped, ['b'], 'a: 5 and 5 against 6 and 4 is the same mean; b differs by a point; c is the same');
  near(s.delta, s.arms.B.meanScore - s.arms.A.meanScore);
});
