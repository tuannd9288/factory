// `factory top` (#174): the repo -> issue -> session view, built from fixture run folders, a fixture state folder and a fake
// gh on PATH. Nothing here runs claude, a live gh or the network. Frames are rendered at a fixed width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const top = () => import('../bin/lib/top.mjs');

const NOW = Date.parse('2026-10-31T12:00:00Z');
const line = (o) => `${JSON.stringify(o)}\n`;
const init = (cwd) => line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', cwd });
const assistant = (id, usage) => line({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage } });
const result = (o) => line({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.42, session_id: 's1', ...o });
const limit = (status, resetsAt) => line({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt, unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.2, resetsAt: resetsAt + 86400 } } } });

/** A run folder with one session: its log (aged secs seconds before NOW), its seat, and a pid file. */
function session(runs, folder, tag, { log, seat = '2', ageSecs = 30 }) {
  const dir = join(runs, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${tag}.jsonl`);
  writeFileSync(file, log);
  writeFileSync(join(dir, `run-${tag}.seat`), `${seat}\n`);
  writeFileSync(join(dir, `run-${tag}.pid`), '99999\n');
  utimesSync(file, (NOW - ageSecs * 1000) / 1000, (NOW - ageSecs * 1000) / 1000);
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'top-'));
  const runs = join(root, 'runs');
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const fx = join(root, 'fx');
  for (const d of [runs, state, bin, fx]) mkdirSync(d);
  const cwd = join(root, 'WORKSPACES/factory/.claude/worktrees/w');
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  session(runs, 'issue-174', 'worker', { log: init(cwd) + assistant('m1', u) + assistant('m2', { ...u, output_tokens: 7 }) });
  session(runs, 'issue-174', 'reviewer', { log: init(cwd) + assistant('m1', u) + result({ total_cost_usd: 1.5, num_turns: 4 }), ageSecs: 4000 });
  session(runs, 'issue-170', 'worker', { log: init(cwd) + assistant('m1', u) + limit('rejected', NOW / 1000 + 3600) + result({ is_error: true, subtype: 'error', api_error_status: 429 }), seat: '1', ageSecs: 600 });
  session(runs, 'issue-169', 'worker', { log: init(cwd) + assistant('m1', u), ageSecs: 90000 });
  session(runs, 'issue-150', 'worker', { log: init(cwd) + assistant('m1', u) + result({ is_error: true, subtype: 'error_during_execution' }), ageSecs: 7200 });
  const lead = join(runs, 'factory-lead/transcripts');
  mkdirSync(lead, { recursive: true });
  writeFileSync(join(lead, 'abc.jsonl'), assistant('l1', u));
  utimesSync(join(lead, 'abc.jsonl'), (NOW - 10000) / 1000, (NOW - 10000) / 1000);
  writeFileSync(
    join(state, 'sessions.jsonl'),
    line({ session: 's1', role: 'reviewer', seat: 2, tag: 'reviewer', run: join(runs, 'issue-174'), repo: 'tuannd9288/factory', branch: 'issue-174-top', start: '2026-10-31T10:00:00Z', end: '2026-10-31T10:30:00Z', total_cost_usd: 1.5, model: 'claude-opus-5-5', ended: 'success' }) +
      line({ session: 's9', role: 'worker', seat: 2, tag: 'worker', run: join(runs, 'issue-150'), repo: 'tuannd9288/factory', branch: 'issue-150-x', start: '2026-10-31T09:00:00Z', end: '2026-10-31T09:10:00Z', total_cost_usd: 0.1, model: 'claude-sonnet-5-5', ended: 'error_during_execution' }),
  );
  writeFileSync(join(state, 'queue-tuannd9288-factory.ok'), '2026-10-31T11:59:00Z\n');
  writeFileSync(join(state, 'digest.failed'), '2026-10-31T09:00:00Z digest failed\n');
  const check = (name, conclusion, status = 'COMPLETED') => ({ name, status, conclusion });
  writeFileSync(join(fx, 'issues.json'), JSON.stringify([
    { number: 174, title: 'factory top, the repo view', state: 'OPEN', labels: [{ name: 'task' }] },
    { number: 170, title: 'A session real end', state: 'OPEN', labels: [{ name: 'task' }] },
    { number: 150, title: 'An old task', state: 'CLOSED', labels: [{ name: 'task' }] },
  ]));
  writeFileSync(join(fx, 'prs.json'), JSON.stringify([
    { number: 260, title: 'top view', state: 'OPEN', headRefName: 'issue-174-top', body: 'Issue: #174\nClaim: abc\nTeam: alpha', labels: [{ name: 'tier-3' }], mergedAt: null, statusCheckRollup: [check('verify', 'SUCCESS'), check('review', null, 'IN_PROGRESS'), check('tier', 'FAILURE')] },
    { number: 240, title: 'old', state: 'MERGED', headRefName: 'issue-150-x', body: 'Issue: #150', labels: [], mergedAt: '2026-10-30T00:00:00Z', statusCheckRollup: [check('verify', 'SUCCESS'), check('review', 'SUCCESS'), check('verdict', 'SUCCESS'), check('tier', 'SUCCESS')] },
  ]));
  const log = join(root, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${log}'\ncase "$1 $2" in\n"issue list") cat '${fx}/issues.json';;\n"pr list") cat '${fx}/prs.json';;\n*) echo "unexpected gh $*" >&2; exit 1;;\nesac\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const claims = async () => new Map([[174, { state: 'claimed', team: 'alpha' }], [170, { state: 'claimed', team: 'beta' }]]);
  const opts = {
    runs, state, now: NOW, repos: ['tuannd9288/factory'], clones: new Map([['tuannd9288/factory', join(root, 'WORKSPACES/factory')]]),
    live: (pidFile) => pidFile.endsWith('issue-174/run-worker.pid'),
    processes: () => [{ pid: 4242, command: 'claude --model opus --name factory-lead --continue' }],
    branchOf: () => 'issue-174-top', load: [2.31, 1.98, 1.5], claims,
  };
  return { root, bin, fx, log, opts };
}

async function withPath(bin, fn) {
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
}

const frame = async (w, tab = 0, width = 200) => {
  const { snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot(w.opts));
  return { snap, text: render(snap, { width, tab }) };
};

test('parseLog reads model, turns, tokens, context and the last result cost; a resumed log takes the last total', async () => {
  const { parseLog } = await top();
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  const p = parseLog(init('/x') + assistant('m1', u) + assistant('m1', u) + assistant('m2', { ...u, output_tokens: 7 }) + result({ total_cost_usd: 0.4 }) + result({ total_cost_usd: 0.9, num_turns: 2 }));
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.equal(p.cost, 0.9);
  assert.equal(p.ctx, 10 + 1000 + 100);
  assert.deepEqual([p.tokensIn, p.tokensOut], [2 * 1110, 12]);
  assert.equal(p.turns, 5);
  assert.equal(p.isError, false);
});

test('parseLog gives null, never a guess, for what the log does not hold', async () => {
  const { parseLog } = await top();
  const p = parseLog(init('/x'));
  assert.equal(p.cost, null);
  assert.equal(p.ctx, null);
  assert.equal(p.isError, null);
  assert.equal(parseLog('not json\n').model, null);
});

test('the sessions: states follow the log, the pid and the limit; a stopped session names its reset', async () => {
  const w = world();
  const { snap } = await frame(w);
  const by = Object.fromEntries(snap.sessions.map((s) => [s.name, s]));
  assert.equal(by['174-worker'].state, 'working');
  assert.equal(by['174-reviewer'].state, 'done');
  assert.equal(by['170-worker'].state, 'stopped');
  assert.match(by['170-worker'].stopped, /5h .*13:00/);
  assert.equal(by['150-worker'].state, 'failed');
  assert.equal(by['169-worker'].state, 'gone');
  assert.equal(by['factory-lead'].role, 'lead');
  assert.equal(by['factory-lead'].state, 'idle');
});

test('the frame: header, tabs, the tree and the session columns at a fixed width', async () => {
  const w = world();
  const { text } = await frame(w);
  const lines = text.split('\n');
  assert.ok(lines.every((l) => l.length <= 200));
  assert.match(lines[0], /load 2\.31 1\.98 1\.50/);
  assert.match(lines[0], /1 working/);
  assert.match(lines[0], /1 idle/);
  assert.match(lines[0], /1 stopped/);
  assert.match(lines[0], /seats 1:0\/4 2:1\/4/);
  assert.match(lines[0], /queue ok 2026-10-31 11:59/);
  assert.match(lines[0], /alerts 1/);
  assert.match(lines[1], /\[1 All\] .*\[2 factory 4\].*\[3 Done 1\]/);
  assert.ok(lines.some((l) => /accounts/i.test(l) && /#178/.test(l)));
  const head = lines.find((l) => l.startsWith('NAME'));
  for (const col of ['ROLE', 'STATE', 'HARNESS', 'MODEL', 'SEAT', 'CTX', 'TURNS', 'TOKENS', 'COST', 'AGE', 'SINCE', 'CWD']) assert.ok(head.includes(col), col);
  const group = lines.findIndex((l) => /#174 factory top, the repo view/.test(l));
  assert.ok(group > 0);
  assert.match(lines[group], /alpha/);
  assert.match(lines[group], /PR #260/);
  assert.match(lines[group], /verify✓ review… verdict– tier✗/);
  assert.match(lines[group], /waiting on the Human/);
  const lead = lines.findIndex((l) => /^\s*factory-lead /.test(l));
  const worker = lines.findIndex((l) => /^\s*174-worker /.test(l));
  const reviewer = lines.findIndex((l) => /^\s*174-reviewer /.test(l));
  assert.ok(lead > 0 && lead < group || lead > 0, 'the lead is listed');
  assert.ok(group < worker && worker < reviewer, 'workers before reviewers, under the issue');
  assert.match(lines[worker], /worker +working +claude -p +sonnet-5-5 medium +2 /);
  assert.match(lines[worker], /issue-174-top/);
  assert.match(lines[reviewer], /\$1\.50/);
});

test('gone sessions fold into one row; the Done tab holds the merged issue', async () => {
  const w = world();
  const all = (await frame(w, 0)).text;
  assert.match(all, /1 gone/);
  assert.ok(!/^\s*169-worker /m.test(all));
  assert.ok(!/#150 An old task/.test(all));
  const done = (await frame(w, 2)).text;
  assert.match(done, /#150 An old task/);
  assert.match(done, /step merged/);
});

test('a field the data does not give shows as ?', async () => {
  const w = world();
  const { text } = await frame(w);
  const lead = text.split('\n').find((l) => /^\s*factory-lead /.test(l));
  assert.match(lead, /\?/);
});

test('gh is called only through porcelain, never api, and not again within a minute', async () => {
  const w = world();
  const { snapshot } = await top();
  const keep = {};
  await withPath(w.bin, async () => {
    const a = await snapshot({ ...w.opts, cache: keep });
    await snapshot({ ...w.opts, cache: keep, now: NOW + 30_000 });
    assert.ok(a.github.ok);
  });
  const calls = readFileSync(w.log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2, 'one issue list and one pr list for the repository, read once');
  assert.ok(calls.every((c) => /^(issue|pr) list /.test(c) && !c.includes('api')));
  assert.ok(calls.every((c) => c.includes('--json')));
});

test('a failing gh shows in the header and the local part still renders', async () => {
  const w = world();
  writeFileSync(join(w.bin, 'gh'), '#!/bin/sh\necho "HTTP 502" >&2\nexit 1\n');
  const { text } = await frame(w);
  const head = text.split('\n')[0];
  assert.match(head, /gh failed/);
  assert.match(text, /174-worker/);
});

test('the queue and the alerts come from the state folder files', async () => {
  const w = world();
  const { queueOf } = await top();
  const q = queueOf(w.opts.state);
  assert.equal(q.lastSweep, '2026-10-31T11:59:00Z');
  assert.equal(q.failed.length, 1);
  assert.equal(queueOf(join(w.root, 'missing')).lastSweep, null);
});
