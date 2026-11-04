// `factory top` (#174): the repo -> issue -> session view, built from fixture run folders, a fixture state folder and a fake
// gh on PATH. Nothing here runs claude, a live gh or the network. Frames are rendered at a fixed width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local times are shown in the machine's zone; the fixtures are in UTC, so a local time reads as the fixture's.
process.env.TZ = 'UTC';

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
  mkdirSync(join(root, 'WORKSPACES/factory/.gate/bin'), { recursive: true });
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  session(runs, 'issue-174', 'worker', { log: init(cwd) + assistant('m1', u) + assistant('m2', { ...u, output_tokens: 7 }) });
  session(runs, 'issue-174', 'reviewer', { log: init(cwd) + assistant('m1', u) + result({ total_cost_usd: 1.5, num_turns: 4 }), ageSecs: 4000 });
  session(runs, 'issue-170', 'worker', { log: init(cwd) + assistant('m1', u) + limit('rejected', NOW / 1000 + 3600) + result({ is_error: true, subtype: 'error', api_error_status: 429 }), seat: '1', ageSecs: 600 });
  session(runs, 'issue-169', 'worker', { log: init(cwd) + assistant('m1', u), ageSecs: 90000 });
  session(runs, 'issue-174', 'old', { log: init(cwd) + assistant('m1', u), ageSecs: 90000 });
  session(runs, 'issue-150', 'worker', { log: init(cwd) + assistant('m1', u) + result({ is_error: true, subtype: 'error_during_execution' }), ageSecs: 7200 });
  // The names bin/seat and the Lead's launcher keep (#286); the 170 and 150 runs have none and keep the old <issue>-<tag>.
  writeFileSync(join(runs, 'issue-174/run-worker.name'), 'badger\n');
  writeFileSync(join(runs, 'issue-174/run-reviewer.name'), 'beaver\n');
  const lead = join(runs, 'factory-lead/transcripts');
  mkdirSync(lead, { recursive: true });
  writeFileSync(join(runs, 'factory-lead/name'), 'aardvark\n');
  writeFileSync(join(lead, 'abc.jsonl'), assistant('l1', u));
  utimesSync(join(lead, 'abc.jsonl'), NOW / 1000 - 10000, NOW / 1000 - 10000);
  // Two teams of the factory's own repository (#311); the seat rows and the old Lead row are old lines: they name no user of an account,
  // and only attribute a run or a record that has no account of its own (the 170 run, the s9 record).
  writeFileSync(join(state, 'accounts'), 'factory/factory-lead=acct-one\nfactory/factory-b=acct-two\nfactory/seat-1=acct-one\nfactory/seat-2=acct-two\nfactory/lead-factory=acct-one\n');
  writeFileSync(
    join(state, 'sessions.jsonl'),
    line({ session: 's1', role: 'reviewer', seat: 2, tag: 'reviewer', run: join(runs, 'issue-174'), repo: 'tuannd9288/factory', branch: 'issue-174-top', start: '2026-10-31T10:00:00Z', end: '2026-10-31T10:30:00Z', total_cost_usd: 1.5, model: 'claude-opus-5-5', ended: 'success' }) +
      line({ session: 's9', role: 'worker', seat: 2, tag: 'worker', run: join(runs, 'issue-150'), repo: 'tuannd9288/factory', branch: 'issue-150-x', start: '2026-10-31T09:00:00Z', end: '2026-10-31T09:10:00Z', total_cost_usd: 0.1, model: 'claude-sonnet-5-5', ended: 'error_during_execution' }),
  );
  writeFileSync(join(state, 'queue-tuannd9288-factory.ok'), '2026-10-31T11:59:00Z\n');
  writeFileSync(join(state, 'digest.failed'), '2026-10-31T09:00:00Z digest failed\n');
  const check = (name, conclusion, status = 'COMPLETED', completedAt = undefined) => ({ name, status, conclusion, completedAt });
  writeFileSync(join(fx, 'issues.json'), JSON.stringify([
    { number: 174, title: 'factory top, the repo view', state: 'OPEN', labels: [{ name: 'task' }] },
    { number: 170, title: 'A session real end', state: 'OPEN', labels: [{ name: 'task' }] },
    { number: 150, title: 'An old task', state: 'CLOSED', labels: [{ name: 'task' }] },
    { number: 151, title: 'Closed with no PR', state: 'CLOSED', labels: [] },
    { number: 17, title: 'A quiet open issue', state: 'OPEN', labels: [] },
  ]));
  writeFileSync(join(fx, 'prs.json'), JSON.stringify([
    { number: 260, title: 'top view', state: 'OPEN', headRefName: 'issue-174-top', body: 'Issue: #174\nClaim: abc\nTeam: alpha', labels: [{ name: 'tier-3' }], mergedAt: null, statusCheckRollup: [check('verify', 'SUCCESS', 'COMPLETED', '2026-10-31T11:00:00Z'), check('review', null, 'IN_PROGRESS'), check('tier', 'FAILURE', 'COMPLETED', '2026-10-31T11:05:00Z')] },
    // merged today after waiting for the Human from 08:30 (the newest finish of verify, review and verdict) to 09:00
    { number: 250, title: 'earlier today', state: 'MERGED', headRefName: 'x', body: 'Issue: #999', labels: [{ name: 'tier-3' }], mergedAt: '2026-10-31T09:00:00Z', statusCheckRollup: [check('verify', 'SUCCESS', 'COMPLETED', '2026-10-31T07:00:00Z'), check('review', 'SUCCESS', 'COMPLETED', '2026-10-31T08:00:00Z'), check('verdict', 'SUCCESS', 'COMPLETED', '2026-10-31T08:30:00Z'), check('tier', 'SUCCESS', 'COMPLETED', '2026-10-31T08:45:00Z')] },
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
    branchOf: () => 'issue-174-top', originOf: () => null, load: [2.31, 1.98, 1.5], cores: 8, agentProfiles: join(root, 'profiles'), claims,
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

test('a Lead runs while a claude process names it with --name <repo>-lead, the rule the sessions use (#179)', async () => {
  const { leadRunning } = await top();
  const ps = (...commands) => () => commands.map((command, i) => ({ pid: i + 1, command }));
  assert.equal(leadRunning('factory', ps('claude --model opus --name factory-lead --continue')), true);
  assert.equal(leadRunning('factory', ps('claude --name factory-lead')), true);
  assert.equal(leadRunning('factory', ps('claude --name other-lead', 'vim --name factory-lead x')), false);
  assert.equal(leadRunning('factory', ps('claude --name factory-lead-two')), false);
  assert.equal(leadRunning('factory', ps()), false);
});

test('leadOf reads { repo, team } from --name <repo>-<team>, splitting at the last dash, and needs a claude command and a valid team (#196)', async () => {
  const { leadOf } = await top();
  assert.deepEqual(leadOf('claude --model opus --name factory-probe-lead --continue'), { repo: 'factory-probe', team: 'lead' });
  assert.deepEqual(leadOf('claude --name factory-probe-b'), { repo: 'factory-probe', team: 'b' });
  assert.deepEqual(leadOf('claude --name factory-lead'), { repo: 'factory', team: 'lead' });
  assert.equal(leadOf('claude --name factory'), null, 'a name with no team');
  assert.equal(leadOf('claude --name factory-probe-3'), null, 'a digit first is an issue folder, not a team');
  assert.equal(leadOf('claude --name factory-Lead'), null);
  assert.equal(leadOf('claude --name factory-a_b'), null);
  assert.equal(leadOf(`claude --name factory-${'a'.repeat(33)}`), null);
  assert.equal(leadOf('vim --name factory-lead x'), null);
});

test('leadRunning is true when some process is a Lead of the repository, whichever its team (#196)', async () => {
  const { leadRunning } = await top();
  const ps = (...commands) => () => commands.map((command, i) => ({ pid: i + 1, command }));
  assert.equal(leadRunning('factory-probe', ps('claude --name factory-probe-b')), true);
  assert.equal(leadRunning('factory', ps('claude --name factory-probe-b')), false);
  assert.equal(leadRunning('factory-probe', ps('claude --name factory-probe-b', 'claude --name factory-probe-lead')), true);
});

test('top shows each running team of a repository as its own Lead row, naming the team, in the block and the answer line (#196)', async () => {
  const w = world();
  const dir = join(w.opts.runs, 'factory-b');
  mkdirSync(join(dir, 'transcripts'), { recursive: true });
  writeFileSync(join(dir, 'name'), 'badger\n');
  writeFileSync(join(dir, 'pane'), 'p-8\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ event: 'Notification', type: 'permission_prompt', at: new Date(NOW - 30_000).toISOString() }));
  const { snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot({ ...w.opts, processes: () => [
    { pid: 1, command: 'claude --model opus --name factory-lead --continue' },
    { pid: 2, command: 'claude --model opus --name factory-b' },
  ] }));
  const leads = snap.sessions.filter((s) => s.role === 'lead');
  assert.deepEqual(leads.map((s) => [s.name, s.team]).sort(), [['aardvark', 'lead'], ['badger', 'b']]);
  const lines = render(snap, { width: 200 }).split('\n');
  assert.ok(lines.some((l) => /^ {2}aardvark +Lead lead +○ idle/.test(l)));
  assert.ok(lines.some((l) => /^ {2}badger +Lead b +! waiting/.test(l)));
  assert.ok(lines.includes('  answer   badger (factory Lead, team b)  pane p-8'));
});

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
  assert.equal(by.badger.state, 'working');
  assert.equal(by.beaver.state, 'done');
  assert.equal(by['170-worker'].state, 'stopped');
  assert.equal(by['170-worker'].until, (NOW / 1000 + 3600) * 1000);
  assert.equal(by['150-worker'].state, 'failed');
  assert.equal(by['169-worker'].state, 'gone');
  assert.equal(by.aardvark.role, 'lead');
  assert.equal(by.aardvark.state, 'idle');
});

test('a run shows the name in its run-<tag>.name, a Lead the name in its folder\'s name file; a run with none keeps <issue>-<tag>', async () => {
  const w = world();
  const { snap } = await frame(w);
  const names = snap.sessions.map((s) => s.name);
  for (const n of ['badger', 'beaver', 'aardvark', '170-worker', '150-worker']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('174-worker') && !names.includes('factory-lead'));
});

test('the frame: a header in plain words, what waits on you, one block per team, the accounts and today, no keys line (#311, #174)', async () => {
  const w = world();
  const { text } = await frame(w);
  const lines = text.split('\n');
  assert.ok(lines.every((l) => l.length <= 200));
  assert.ok(!lines.some((l) => l.startsWith('keys:')), 'the keys line is asked for, and --once does not');
  assert.match(lines[0], /^Mac mini {2}load 2\.3 of 8 cores {2}·  1 working · 1 idle · 0 agents waiting {2}·  12:00 {2}·/);
  assert.match(lines[0], /queue ok 11:59/);
  assert.match(lines[0], /alerts 1/);
  assert.ok(!/\d{4}-\d\d-\d\d|\d\dZ\b/.test(lines.join('\n')), 'no UTC time or full date is left, an alert\'s included');
  assert.match(lines[1], /\[1 All\] .*\[2 factory 4\].*\[3 Done 2\]/);
  assert.deepEqual(lines.slice(2, 5), [
    'Waiting on you',
    '  approve  tuannd9288/factory#260 top view  https://github.com/tuannd9288/factory/pull/260',
    '  alert    digest.failed  09:00 digest failed',
  ]);
  assert.equal(lines[5], 'tuannd9288/factory');
  // One block per team, the worst state first: alpha waits on the Human, beta is stuck, the Lead's own team is idle.
  const at = (re) => lines.findIndex((l) => re.test(l));
  const [alpha, beta, lead] = [at(/^ {2}team alpha$/), at(/^ {2}team beta$/), at(/^ {2}aardvark +Lead lead +○ idle +\?/)];
  assert.ok(5 < alpha && alpha < beta && beta < lead, `${alpha} ${beta} ${lead}`);
  // The issue row: its state first, then #n, team, step, the pull request with its checks, the title last.
  const group = at(/#174 /);
  assert.match(lines[group], /^ {4}! on you #174 alpha +PR open +PR #260 verify✓ review… verdict– tier✗ factory top, the repo view$/);
  assert.ok(alpha < group && group < beta);
  const worker = at(/^ {6}badger +worker +● working /);
  const reviewer = at(/^ {6}beaver +reviewer +✓ done +53m +\$1\.50/);
  assert.ok(group < worker && worker < reviewer, 'working before done, under the issue');
  assert.ok(beta < at(/^ {4}× stuck +#170 /));
  assert.ok(at(/^ {4}× stuck +#170 /) < at(/^ {6}170-worker +worker +× out of quota .*until 13:00$/));
  assert.ok(!lines.some((l) => /HARNESS|claude -p|CTX|TOKENS/.test(l)), 'the engineering columns are behind a key');
  const accounts = lines.findIndex((l) => l === 'Accounts');
  assert.deepEqual(lines.slice(accounts + 1, accounts + 3), [
    '  a  acct-one  5h 100% resets 13:00 · 7d 20% resets 11-01 13:00 · factory-lead',
    '  b  acct-two  5h ? · 7d ? · factory-b',
  ]);
  assert.doesNotMatch(lines.slice(accounts, accounts + 3).join('\n'), /seat/);
  assert.equal(lines.at(-1), 'Today  1 pull request merged · workers and reviewers cost $1.60 on account b · waited on you 1h30');
});

test('--full adds the engineering columns to every session row, and a header for them', async () => {
  const w = world();
  const { snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot(w.opts));
  const lines = render(snap, { width: 200, full: true }).split('\n');
  const head = lines.find((l) => l.startsWith('NAME'));
  for (const col of ['ROLE', 'STATE', 'COST', 'HARNESS', 'MODEL', 'SEAT', 'CTX', 'TURNS', 'TOKENS', 'CWD', 'BRANCH']) assert.ok(head.includes(col), col);
  const worker = lines.find((l) => /^ {6}badger /.test(l));
  assert.match(worker, /worker +● working .* claude -p +sonnet-5-5 medium +2 /);
  assert.match(worker, /issue-174-top/);
  assert.ok(!render(snap, { width: 200 }).split('\n').some((l) => l.startsWith('NAME')));
});

test('a block folds the sessions that ended before today of all its issues into one "N ended before today" row, at its end', async () => {
  const w = world();
  const cwd = join(w.root, 'WORKSPACES/factory/.claude/worktrees/w');
  session(w.opts.runs, 'issue-170', 'old', { log: init(cwd) + assistant('m1', { input_tokens: 1, output_tokens: 1 }), ageSecs: 90000 });
  const lines = (await frame(w, 0)).text.split('\n');
  const folded = lines.flatMap((l, i) => (/ended before today/.test(l) ? [i] : []));
  assert.deepEqual(folded.map((i) => lines[i]), ['  2 ended before today'], 'one row for the block: 174-old and 170-old');
  const last = lines.findIndex((l) => /^ {6}beaver /.test(l));
  assert.ok(folded[0] > last, 'it comes after the issues\' rows');
  assert.match(lines[folded[0] + 1], /^ {2}2 older$/);
  assert.ok(!lines.some((l) => /^\s*174-old /.test(l)));
});

test('Waiting on you says "Nothing waits on you" when no pull request, Lead or alert waits', async () => {
  const w = world();
  writeFileSync(join(w.fx, 'prs.json'), '[]');
  rmSync(join(w.opts.state, 'digest.failed'));
  const { text } = await frame(w);
  assert.equal(text.split('\n')[2], 'Nothing waits on you');
  assert.ok(!text.includes('Waiting on you'));
});

test('Today names each account after its cost: "$1.00 on account a, $2.00 on account b"; with none, "nothing yet"', async () => {
  const w = world();
  const { snap } = await frame(w);
  const { render } = await top();
  const today = (cost) => render({ ...snap, today: { ...snap.today, cost } }, { width: 200 }).split('\n').at(-1);
  assert.match(today([['a', 1], ['b', 2]]), /workers and reviewers cost \$1\.00 on account a, \$2\.00 on account b · waited/);
  assert.match(today([]), /workers and reviewers cost nothing yet · waited/);
});

test('an alert\'s leading ISO time shows as local time, with the date on another day; a line that does not start with one is as it is', async () => {
  const w = world();
  writeFileSync(join(w.opts.state, 'claude-canary.failed'), '2026-10-30T13:27:10.966Z claude 2.1.309 failed the canary run\n');
  writeFileSync(join(w.opts.state, 'queue-run.failed'), 'queue could not start\n');
  const alerts = (await frame(w)).text.split('\n').filter((l) => l.startsWith('  alert'));
  assert.ok(alerts.includes('  alert    claude-canary.failed  10-30 13:27 claude 2.1.309 failed the canary run'), alerts.join('\n'));
  assert.ok(alerts.includes('  alert    queue-run.failed  queue could not start'), alerts.join('\n'));
});

test('All shows an issue only while it has a session listed today, a claim or an open PR; the rest, one that ended yesterday included, fold into "N older"', async () => {
  const w = world();
  const cwd = join(w.root, 'WORKSPACES/factory/.claude/worktrees/w');
  // #171 is open; its only session finished 15 hours ago, before today: not live, not gone, not listed.
  session(w.opts.runs, 'issue-171', 'worker', { log: init(cwd) + assistant('m1', { input_tokens: 1, output_tokens: 1 }) + result({}), ageSecs: 54000 });
  const issues = JSON.parse(readFileSync(join(w.fx, 'issues.json'), 'utf8'));
  writeFileSync(join(w.fx, 'issues.json'), JSON.stringify([...issues, { number: 171, title: 'Ended yesterday', state: 'OPEN', labels: [] }]));
  const all = (await frame(w, 0)).text;
  for (const n of [174, 170]) assert.match(all, new RegExp(`#${n} `));
  assert.ok(!/#17 A quiet/.test(all));
  assert.ok(!/#169 /.test(all));
  assert.ok(!/#171 /.test(all));
  assert.match(all, /^\s*3 older$/m);
  assert.ok(!/#15[01] /.test(all));
});

test('a repository\'s tab lists an issue whose session ended in the last 24 hours, as #174 did; All counts it in "N older"', async () => {
  const w = world();
  const cwd = join(w.root, 'WORKSPACES/factory/.claude/worktrees/w');
  session(w.opts.runs, 'issue-171', 'worker', { log: init(cwd) + assistant('m1', { input_tokens: 1, output_tokens: 1 }) + result({}), ageSecs: 54000 });
  const issues = JSON.parse(readFileSync(join(w.fx, 'issues.json'), 'utf8'));
  writeFileSync(join(w.fx, 'issues.json'), JSON.stringify([...issues, { number: 171, title: 'Ended yesterday', state: 'OPEN', labels: [] }]));
  const tab = (await frame(w, 1)).text;
  for (const n of [174, 170, 171]) assert.match(tab, new RegExp(`^ {4}\\S.* #${n} `, 'm'));
  assert.ok(!/#169 /.test(tab), 'a session over 24 hours old is gone');
  assert.match(tab, /^\s*2 older$/m);
  assert.ok(!/ #171 /.test((await frame(w, 0)).text), 'All folds it');
});

test('the Done tab holds the closed issues, merged or not', async () => {
  const w = world();
  const done = (await frame(w, 2)).text;
  assert.match(done, /✓ merged +#150 .*An old task/);
  assert.match(done, /✓ closed +#151 .*Closed with no PR/);
  assert.ok(!/#174 /.test(done));
});

test('the role comes from the record, else from the tag; a tag it does not know shows ?', async () => {
  const { roleOf } = await top();
  assert.equal(roleOf('anything', { role: 'reviewer' }), 'reviewer');
  assert.equal(roleOf('build-2', null), 'worker');
  assert.equal(roleOf('fix-1', null), 'worker');
  assert.equal(roleOf('review-3', null), 'reviewer');
  assert.equal(roleOf('BRIEF-review-x', null), 'reviewer');
  assert.equal(roleOf('rereview', null), 'reviewer');
  assert.equal(roleOf('research-1', null), 'researcher');
  assert.equal(roleOf('worker', null), 'worker');
  assert.equal(roleOf('mystery', null), '?');
});

test('a pid file whose pid is alive but belongs to a later process start is not a live session', async () => {
  const w = world();
  const runs = join(w.root, 'runs-reuse');
  session(runs, 'issue-300', 'worker', { log: init('/x') + assistant('m1', { input_tokens: 1, output_tokens: 1 }) });
  const pidFile = join(runs, 'issue-300/run-worker.pid');
  writeFileSync(pidFile, `${process.pid}\n`);
  const old = new Date('2000-01-01T00:00:00Z');
  utimesSync(pidFile, old, old);
  const { gatherSessions, snapshot } = await top();
  const [s] = gatherSessions({ runs, state: w.opts.state, now: NOW, processes: () => [] });
  assert.equal(s.live, false);
  assert.equal(s.state, 'gone');
  const { live, ...rest } = w.opts;
  const snap = await withPath(w.bin, () => snapshot({ ...rest, runs }));
  assert.equal(snap.seats['2'].live, 0);
});

// A same-size rewrite that keeps the modification time: only a read would show it (#340).
const rewrite = (file, text) => {
  const { mtimeMs } = statSync(file);
  writeFileSync(file, text);
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
};

test('with a shared cache a log whose size and time did not change is not read again; one that grew or was replaced is; without a cache every log is read (#340)', async () => {
  const w = world();
  const runs = join(w.root, 'runs-cache');
  const out = (n) => init('/x') + assistant('m1', { input_tokens: 1, output_tokens: n });
  session(runs, 'issue-301', 'worker', { log: out(1) });
  const file = join(runs, 'issue-301/run-worker.jsonl');
  const { gatherSessions } = await top();
  const base = { runs, state: w.opts.state, now: NOW, processes: () => [], live: () => false };
  const tokens = (cache) => gatherSessions({ ...base, cache })[0].tokensOut;
  const cache = {};
  assert.equal(tokens(cache), 1);
  rewrite(file, out(2));
  assert.equal(tokens(cache), 1, 'same size and time: the cached parse');
  assert.equal(tokens(null), 2, 'no cache: read as before');
  assert.equal(tokens({}), 2, 'a fresh cache reads');
  writeFileSync(file, out(2) + assistant('m2', { input_tokens: 1, output_tokens: 3 }));
  assert.equal(tokens(cache), 5, 'a log that grew is read whole');
  const t = new Date(NOW + 60000);
  rewrite(file, out(7) + assistant('m2', { input_tokens: 1, output_tokens: 3 }));
  utimesSync(file, t, t);
  assert.equal(tokens(cache), 10, 'same size, newer time: replaced, read');
  rmSync(file);
  assert.deepEqual(gatherSessions({ ...base, cache }), []);
  assert.equal(cache.logs.size, 0, 'a log that is gone leaves the cache');
});

test('with a shared cache sessions.jsonl is read again only when its size or time changed (#340)', async () => {
  const w = world();
  const state = join(w.root, 'state-cache');
  mkdirSync(state);
  const file = join(state, 'sessions.jsonl');
  const rec = (cost) => line({ session: 's1', run: 'r', tag: 't', total_cost_usd: cost });
  const { sessionRecords } = await top();
  writeFileSync(file, rec(1));
  utimesSync(file, NOW / 1000, NOW / 1000); // a whole second, which utimesSync can put back exactly
  const cache = {};
  assert.equal(sessionRecords(state, cache)[0].total_cost_usd, 1);
  rewrite(file, rec(2));
  assert.equal(sessionRecords(state, cache)[0].total_cost_usd, 1, 'unchanged size and time: cached');
  assert.equal(sessionRecords(state)[0].total_cost_usd, 2, 'no cache: read');
  writeFileSync(file, rec(2) + rec(3));
  assert.equal(sessionRecords(state, cache).length, 2, 'grown: read');
  rmSync(file);
  assert.deepEqual(sessionRecords(state, cache), []);
});

test('a run\'s repository is its record\'s, else a live run\'s origin, else ?; every such repository has its issues read', async () => {
  const w = world();
  const runs = join(w.root, 'runs-origin');
  session(runs, 'issue-400', 'build-1', { log: init('/elsewhere/w') + assistant('m1', { input_tokens: 1, output_tokens: 1 }) });
  session(runs, 'issue-401', 'build-1', { log: init('/elsewhere/v') + assistant('m1', { input_tokens: 1, output_tokens: 1 }), ageSecs: 100000 });
  const { snapshot } = await top();
  const opts = { ...w.opts, runs, live: (f) => f.includes('issue-400'), originOf: (cwd) => (cwd === '/elsewhere/w' ? 'x/y' : null) };
  const snap = await withPath(w.bin, () => snapshot(opts));
  const by = Object.fromEntries(snap.sessions.map((s) => [s.name, s]));
  assert.equal(by['400-build-1'].repo, 'x/y');
  assert.equal(by['401-build-1'].repo, null);
  const calls = readFileSync(w.log, 'utf8').trim().split('\n');
  const issues = calls.filter((c) => c.startsWith('issue list') && c.includes('--repo x/y'));
  assert.equal(issues.length, 1);
  assert.match(issues[0], /--state all/);
  assert.match(issues[0], /--limit 300/);
  assert.match(issues[0], /--json number,state,title/);
});

test('an ended run with no record takes its repository from its work folder\'s origin, read once per folder per refresh; one issue sits under one repository', async () => {
  const w = world();
  const runs = join(w.root, 'runs-ended');
  const [a, b, c] = ['w', 'clone', 'other'].map((n) => {
    const d = join(w.root, 'folders', n);
    mkdirSync(d, { recursive: true });
    return d;
  });
  const done = (cwd) => init(cwd) + assistant('m1', { input_tokens: 1, output_tokens: 1 }) + result({});
  session(runs, 'issue-500', 'build-1', { log: done(a), ageSecs: 600 });
  session(runs, 'issue-500', 'review-3', { log: done(b), ageSecs: 600 });
  session(runs, 'issue-501', 'build-1', { log: done(a), ageSecs: 600 });
  session(runs, 'issue-502', 'build-1', { log: done(c), ageSecs: 600 });
  const asked = [];
  const originOf = (cwd) => {
    asked.push(cwd);
    return cwd === a ? 'p/q' : null;
  };
  const { snapshot } = await top();
  const keep = {};
  const opts = { ...w.opts, runs, live: () => false, originOf, cache: keep };
  const snap = await withPath(w.bin, () => snapshot(opts));
  await withPath(w.bin, () => snapshot({ ...opts, now: NOW + 10_000 }));
  const by = Object.fromEntries(snap.sessions.map((s) => [s.name, s]));
  assert.equal(by['500-build-1'].repo, 'p/q');
  assert.equal(by['500-review-3'].repo, 'p/q', 'a sibling in the same run folder joins the repository the folder\'s other run has');
  assert.equal(by['501-build-1'].repo, 'p/q');
  assert.equal(by['502-build-1'].repo, null, 'no origin and no sibling: ?');
  assert.equal(asked.filter((x) => x === a).length, 1);
});

test('a run with no repository takes it from its folder\'s name: issue-<n> is the factory\'s own, <short>-<n> a known repository\'s; the rest fold into one line, not a block or a tab', async () => {
  const w = world();
  const runs = join(w.root, 'runs-folders');
  const done = init(join(w.root, 'gone')) + assistant('m1', { input_tokens: 1, output_tokens: 1 }) + result({});
  session(runs, 'issue-293', 'review-1', { log: done, ageSecs: 600 });
  session(runs, 'zalo-gateway-7', 'build-1', { log: done, ageSecs: 600 });
  session(runs, 'mystery-9', 'build-1', { log: done, ageSecs: 600 });
  session(runs, 'notes', 'build-1', { log: done, ageSecs: 600 });
  const asked = [];
  const originOf = (cwd) => {
    asked.push(cwd);
    return cwd === '/the/factory' ? 'tuannd9288/factory' : null;
  };
  const clones = new Map([...w.opts.clones, ['tuannd9288/zalo-gateway', join(w.root, 'WORKSPACES/zalo-gateway')]]);
  const { snapshot, render } = await top();
  const opts = { ...w.opts, runs, live: () => false, processes: () => [], originOf, clones, root: '/the/factory' };
  const snap = await withPath(w.bin, () => snapshot(opts));
  const by = Object.fromEntries(snap.sessions.map((s) => [s.name, s]));
  assert.equal(by['293-review-1'].repo, 'tuannd9288/factory');
  assert.equal(by['zalo-gateway-7-build-1'].repo, 'tuannd9288/zalo-gateway');
  assert.equal(by['mystery-9-build-1'].repo, null);
  assert.equal(by['notes-build-1'].repo, null);
  assert.equal(asked.filter((x) => x === '/the/factory').length, 1, 'the factory\'s origin is read once');
  const text = render(snap, { width: 200 });
  const lines = text.split('\n');
  assert.ok(!lines.some((l) => /^\?$|team \?/.test(l)), 'no block of ?');
  assert.ok(!lines[1].includes('[? '), 'no tab of ?');
  const unplaced = lines.findIndex((l) => l === '  2 sessions with no repository');
  assert.ok(unplaced > lines.findLastIndex((l) => /^tuannd9288\//.test(l)) && unplaced === lines.indexOf('Accounts') - 1, 'the line ends the repositories, before Accounts');
  assert.ok(!render(snap, { width: 200, tab: 1 }).includes('no repository'), 'only All shows it');
});

test('the claim reader writes nothing into the clone: it fetches into a bare cache of its own under the state folder', async () => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { readClaims } = await top();
  const root = mkdtempSync(join(tmpdir(), 'top-claims-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  git(root, 'init', '--bare', '-q', origin);
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'commit', '--allow-empty', '-q', '-m', 'first');
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const main = git(origin, 'rev-parse', 'main');
  const tip = git(origin, 'commit-tree', `${main}^{tree}`, '-p', main, '-m', 'claim 5 alpha');
  git(origin, 'update-ref', 'refs/heads/claim/5', tip);
  const before = git(clone, 'for-each-ref');
  const state = join(root, 'state');
  git(clone, 'config', 'remote.origin.url', `--upload-pack=touch ${join(root, 'PWNED')} #`);
  const claims = await readClaims('o/n', state, { url: origin });
  assert.deepEqual(claims.get(5), { state: 'claimed', team: 'alpha' });
  assert.ok(existsSync(join(state, 'top/o-n.git')));
  assert.ok(!existsSync(join(clone, '.git/FETCH_HEAD')));
  assert.equal(git(clone, 'for-each-ref'), before);
  assert.throws(() => git(clone, 'cat-file', '-e', `${tip}^{commit}`));
  assert.ok(!existsSync(join(root, 'PWNED')), 'the clone\'s url is never read, so its hostile value runs nothing');
});

test('the claim reader runs git in its own cache: no option in a url, no config of the folder the view runs from', async () => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { readClaims } = await top();
  const root = mkdtempSync(join(tmpdir(), 'top-hostile-'));
  const state = join(root, 'state');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  // A url that starts with a dash would be an option without `--`.
  const flag = join(root, 'PWNED-OPTION');
  const gitFailure = (e) => !(e instanceof TypeError);
  await assert.rejects(readClaims('o/n', state, { url: `--upload-pack=touch ${flag} #` }), gitFailure);
  assert.ok(!existsSync(flag));
  assert.ok(existsSync(join(state, 'top/o-n.git')), 'git ran, in the cache');
  // The folder the view runs from rewrites https://github.com/ to ssh and sets an ssh command.
  const here = join(root, 'cwd');
  mkdirSync(here);
  g(here, 'init', '-q');
  const mark = join(root, 'PWNED-CWD');
  g(here, 'config', 'url.ssh://evil.invalid/.insteadOf', 'https://github.com/');
  g(here, 'config', 'core.sshCommand', `touch ${mark} #`);
  const before = [process.cwd(), process.env.GIT_ALLOW_PROTOCOL];
  process.chdir(here);
  process.env.GIT_ALLOW_PROTOCOL = 'ssh';
  try {
    await assert.rejects(readClaims('o/n', state), gitFailure);
  } finally {
    process.chdir(before[0]);
    if (before[1] === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = before[1];
  }
  assert.ok(!existsSync(mark));
});

const SGR_OURS = /\x1b\[(?:1;33|1|2|3[0-7]|0)m/g;
const plain = (s) => s.replace(SGR_OURS, '');

// A world whose texts are hard on a width counter: wide characters, an emoji (a surrogate pair), a long title with spaces, a long note.
function hardWorld() {
  const w = world();
  const issues = JSON.parse(readFileSync(join(w.fx, 'issues.json'), 'utf8'));
  issues[0].title = '漢字 the top view 😀 reads at a glance and never runs one line into another on a narrow phone window';
  writeFileSync(join(w.fx, 'issues.json'), JSON.stringify(issues));
  const prs = JSON.parse(readFileSync(join(w.fx, 'prs.json'), 'utf8'));
  prs[0].title = '漢字 😀 a pull request with a long title that is cut when the line is too wide for it';
  writeFileSync(join(w.fx, 'prs.json'), JSON.stringify(prs));
  writeFileSync(join(w.opts.runs, 'factory-lead/pane'), 'p-7\n');
  return w;
}

test('at 45, 80, 120 and 200 columns no line of a full frame is wider than the width in display cells, with colour on and off, --full too', async () => {
  const { cells, clip, snapshot, render } = await top();
  const w = hardWorld();
  const waiting = { event: 'Notification', type: 'permission_prompt', at: new Date(NOW - 5000).toISOString() };
  writeFileSync(join(w.opts.runs, 'factory-lead/state.json'), JSON.stringify(waiting));
  const snap = await withPath(w.bin, () => snapshot({ ...w.opts, processes: () => [{ pid: 1, command: 'claude --name factory-lead --settings {"hooks":{"SessionStart":[]}}', ageMs: 600_000 }] }));
  for (const width of [45, 80, 120, 200]) {
    for (const color of [false, true]) {
      for (const full of [false, true]) {
        const text = render(snap, { width, color, full, keys: true });
        for (const l of text.split('\n')) assert.ok(cells(l) <= width, `${width} ${color} ${full}: ${cells(l)} cells: ${l}`);
        assert.equal(/\x1b/.test(text), color, `${width}: ESC bytes appear only with colour on`);
        assert.equal(plain(render(snap, { width, color: true, full, keys: true })), render(snap, { width, color: false, full, keys: true }), 'colour changes no character');
        assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text), 'no surrogate pair is split');
      }
    }
  }
  assert.equal(cells('漢字'), 4);
  assert.equal(cells('a😀b'), 4);
  assert.equal(cells('\x1b[1;33mab\x1b[0m'), 2);
  assert.equal(clip('a😀b', 3), 'a…', 'the pair is cut whole, never in half');
  assert.equal(clip('abc', 3), 'abc');
});

test('a title is cut at a word boundary, with …, and only the last free-text cell is cut', async () => {
  const { cutWord } = await top();
  assert.equal(cutWord('one two three', 10), 'one two…');
  assert.equal(cutWord('one two three', 8), 'one two…');
  assert.equal(cutWord('one two three', 13), 'one two three');
  assert.equal(cutWord('unbroken', 5), 'unbr…');
  const w = hardWorld();
  const { text } = await frame(w, 0, 80);
  const row = text.split('\n').find((l) => / #174 /.test(l));
  const title = JSON.parse(readFileSync(join(w.fx, 'issues.json'), 'utf8'))[0].title;
  assert.ok(row.endsWith('…'), row);
  const kept = row.slice(row.indexOf('漢字')).slice(0, -1);
  assert.ok(kept.length > 2 && title.startsWith(kept), row);
  assert.equal(title[kept.length], ' ', 'the cut falls between words');
  assert.match(row, /^ {4}! on you #174 /, 'the state, #n and the pull request stay');
});

test('a session row keeps its state at every width and drops whole columns in a fixed order: the full columns, COST, ROLE, FOR, then NAME shrinks', async () => {
  const w = hardWorld();
  const { snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot(w.opts));
  const order = ['BRANCH', 'CWD', 'TOKENS', 'TURNS', 'CTX', 'SEAT', 'MODEL', 'HARNESS', 'COST', 'ROLE', 'FOR'];
  let gone = 0;
  for (let width = 200; width >= 45; width -= 5) {
    const lines = render(snap, { width, full: true }).split('\n');
    const head = lines.find((l) => l.startsWith('NAME'));
    const missing = ['NAME', 'STATE', ...order].filter((c) => !head.includes(c));
    const k = missing.length;
    assert.deepEqual(missing, order.slice(0, k), `${width}: columns go from the end of the order, one whole column at a time`);
    assert.ok(k >= gone, `${width}: a column that went does not come back at a narrower width`);
    gone = k;
    assert.ok(head.includes('NAME') && head.includes('STATE'));
    for (const name of ['badger', 'beaver', '170-worker']) assert.match(lines.find((l) => l.includes(name) && /^ +\S/.test(l)), /[●○✓×!] \S/, `${width}: ${name} keeps a mark and a word`);
  }
  assert.ok(gone >= order.indexOf('COST') + 1, 'at 45 the full columns and COST are gone');
  const at45 = render(snap, { width: 45 }).split('\n').find((l) => l.includes('badger'));
  assert.doesNotMatch(at45, /\$/, 'COST goes before ROLE');
  const at80 = render(snap, { width: 80 }).split('\n').find((l) => l.includes('badger'));
  assert.match(at80, /worker/);
});

test('the sections come in order: waits on you, the repositories by team, the folded lines, the accounts, Today; a block runs from waiting to done', async () => {
  const w = hardWorld();
  const { text } = await frame(w, 0, 120);
  const lines = text.split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const order = [at(/^Waiting on you$/), at(/^tuannd9288\/factory$/), at(/^ {2}team alpha$/), at(/^ {2}team beta$/), at(/^ {2}aardvark /), at(/ended before today$/), at(/^Accounts$/), at(/^Today /)];
  assert.ok(order.every((i, n) => i > (order[n - 1] ?? -1)), order.join(' '));
  const rank = (l) => ['!', '×', '●', '○', '✓'].indexOf(/[!×●○✓]/.exec(l)?.[0]);
  const sessionsOfAlpha = lines.slice(at(/ #174 /) + 1, at(/^ {2}team beta$/)).filter((l) => /^ {6}\S/.test(l));
  assert.ok(sessionsOfAlpha.length >= 2);
  assert.deepEqual(sessionsOfAlpha.map(rank), [...sessionsOfAlpha.map(rank)].sort((a, b) => a - b), 'working before done inside an issue');
});

test('each state prints a mark and a word, and with colour its cell is coloured: waits on you bold yellow, working green, stuck red, done dim, idle plain', async () => {
  const w = hardWorld();
  const { snap } = await frame(w);
  const { render } = await top();
  const lines = render(snap, { width: 120, color: true }).split('\n');
  const line = (re) => lines.find((l) => re.test(plain(l)));
  assert.ok(line(/^ {6}badger /).includes('\x1b[32m● working\x1b[0m'));
  assert.ok(line(/^ {6}beaver /).includes('\x1b[2m✓ done\x1b[0m'));
  assert.ok(line(/^ {6}170-worker /).includes('\x1b[31m× out of quota\x1b[0m'));
  assert.ok(line(/^ {4}! on you /).includes('\x1b[1;33m! on you\x1b[0m'));
  assert.ok(line(/^ {2}aardvark /).includes('○ idle') && !line(/^ {2}aardvark /).includes('\x1b[3'), 'idle has no colour');
  assert.equal(lines.find((l) => plain(l) === 'Waiting on you'), '\x1b[1;33mWaiting on you\x1b[0m');
  assert.ok(lines.find((l) => plain(l).startsWith('  approve ')).startsWith('\x1b[1;33m'));
  assert.ok(lines.includes('\x1b[1mtuannd9288/factory\x1b[0m'), 'the repository\'s name is bold');
  assert.ok(!/\x1b\[(?!(?:1;33|1|2|3[0-7]|0)m)/.test(lines.join('\n')), 'only basic SGR');
  assert.ok(!render(snap, { width: 120 }).includes('\x1b'), 'with colour off no ESC byte appears');
});

test('an empty "Waiting on you" is one line; a quiet repository folds into one line naming it', async () => {
  const w = hardWorld();
  writeFileSync(join(w.fx, 'prs.json'), '[]');
  rmSync(join(w.opts.state, 'digest.failed'));
  const { snap } = await frame(w);
  const { render } = await top();
  const base = snap.sessions.find((s) => s.name === 'beaver');
  const old = { ...base, name: 'moth', repo: 'o/quiet', issue: null, folder: null, live: false, state: 'done', lastAt: NOW - 3 * 86400_000 };
  const quiet = { ...snap, sessions: [...snap.sessions, old], repos: [...snap.repos, { repo: 'o/quiet', groups: [{ ...snap.repos[0].groups[0], number: 9, done: false, active: false, recent: false, sessions: [] }], other: [old], ghStatus: null }] };
  const lines = render(quiet, { width: 200 }).split('\n');
  assert.equal(lines[2], 'Nothing waits on you');
  assert.ok(!lines.includes('Waiting on you'));
  const mine = lines.flatMap((l, i) => (l.startsWith('o/quiet') ? [i] : []));
  assert.equal(mine.length, 1, 'one line');
  assert.ok(mine[0] > lines.findLastIndex((l) => /^ {6}\S/.test(l)), 'after the active blocks');
  assert.match(lines[mine[0]], /\b1\b.*\b1\b/, 'its folded counts');
  assert.ok(!/^ {2}\d+ (older|ended)/.test(lines[mine[0] + 1]), 'no lines of its own under it');
});

test('a worker resumed for three fix rounds is one row with its rounds counted; reviewers are one row each; a session with no issue sits under "no issue" at the end of its repository', async () => {
  const w = hardWorld();
  const cwd = join(w.root, 'WORKSPACES/factory/.claude/worktrees/w');
  const done = (n) => init(cwd) + assistant('m1', { input_tokens: 1, output_tokens: 1 }) + result({ total_cost_usd: n });
  for (const [tag, age, cost] of [['build-1', 900, 0.1], ['fix-1', 600, 0.2], ['fix-2', 300, 0.3]]) {
    session(w.opts.runs, 'issue-174', tag, { log: done(cost), ageSecs: age });
    writeFileSync(join(w.opts.runs, `issue-174/run-${tag}.name`), 'koala\n');
  }
  for (const [tag, name] of [['review-1', 'lynx'], ['review-2', 'puffin']]) {
    session(w.opts.runs, 'issue-174', tag, { log: done(1), ageSecs: 200 });
    writeFileSync(join(w.opts.runs, `issue-174/run-${tag}.name`), `${name}\n`);
  }
  session(w.opts.runs, 'notes-1', 'build-1', { log: init('/x/other-w') + assistant('m1', { input_tokens: 1, output_tokens: 1 }) + result({}), ageSecs: 100 });
  writeFileSync(join(w.opts.runs, 'notes-1/run-build-1.name'), 'ocelot\n');
  const { snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot({ ...w.opts, originOf: (dir) => (dir === '/x/other-w' ? 'tuannd9288/factory' : null) }));
  const lines = render(snap, { width: 120 }).split('\n');
  const rows = (name) => lines.filter((l) => new RegExp(`^ +${name} `).test(l));
  assert.equal(rows('koala').length, 1);
  assert.match(rows('koala')[0], /\b3\b/, 'its three rounds');
  assert.equal(rows('lynx').length + rows('puffin').length, 2);
  const noIssue = lines.indexOf('  no issue');
  assert.ok(noIssue > lines.findLastIndex((l) => / #\d+ /.test(l)), 'after every issue of the repository');
  assert.match(lines[noIssue + 1], /^ {4}ocelot +worker +✓ done/);
  assert.ok(lines.indexOf('Accounts') > noIssue);
});

test('a part of the frame that does not fit: the URL of a waiting item goes first and #n stays; the status line and the tab bar wrap whole items', async () => {
  const w = hardWorld();
  const { cells, snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot(w.opts));
  const wide = render(snap, { width: 200 }).split('\n').find((l) => l.startsWith('  approve'));
  assert.match(wide, /https:\/\/github\.com\/tuannd9288\/factory\/pull\/260$/);
  for (const width of [60, 45]) {
    const lines = render(snap, { width }).split('\n');
    const item = lines.find((l) => l.startsWith('  approve'));
    assert.ok(!item.includes('https'), `${width}: the URL is dropped first`);
    assert.match(item, /tuannd9288\/factory#260/);
    assert.ok(cells(item) <= width);
  }
  const narrow = render(snap, { width: 45 }).split('\n');
  const head = narrow.slice(0, narrow.findIndex((l) => l.startsWith('Waiting on you'))).join('\n');
  for (const piece of ['load 2.3 of 8 cores', 'queue ok 11:59', 'alerts 1', '▸[1 All]', '[3 Done 2]']) assert.ok(head.includes(piece), `${piece} is whole on one line`);
  assert.ok(narrow.findIndex((l) => l.startsWith('Waiting on you')) > 2, 'the status line wraps onto more than one line');
});

test('columns do not jump: the state column sits at the same cell on every tab, and a folded session\'s name counts in it', async () => {
  const w = hardWorld();
  const col = (text) => text.split('\n').find((l) => /^ {6}badger /.test(l)).indexOf('●');
  const before = col((await frame(w, 0, 120)).text);
  assert.equal(col((await frame(w, 1, 120)).text), before, 'the repository tab and All agree');
  writeFileSync(join(w.opts.runs, 'issue-174/run-old.name'), 'hippopotamus\n');
  const after = col((await frame(w, 0, 120)).text);
  assert.ok(after > before, 'the folded session\'s longer name widens the column for the rows that print');
  assert.equal(col((await frame(w, 1, 120)).text), after);
});

test('the data fields are cleaned before they are styled: no control character reaches a coloured frame but our own SGR', async () => {
  const w = world();
  writeFileSync(join(w.fx, 'issues.json'), JSON.stringify([{ number: 174, title: 'evil\x1b[2J\x1b]0;x\x07 title', state: 'OPEN', labels: [] }]));
  const { snap } = await frame(w);
  const { render } = await top();
  const text = render(snap, { width: 120, color: true });
  assert.ok(!/[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f]/.test(plain(text)), 'no stray control character');
  assert.ok(!/\x1b(?!\[(?:1;33|1|2|3[0-7]|0)m)/.test(text), 'no escape sequence but ours');
  assert.match(plain(text), /evil\[2J\]0;x title/);
});

test('--once leaves out the keys line; the keys line is the loop\'s option, and wraps within the width', async () => {
  const w = world();
  const { snap } = await frame(w);
  const { cells, render } = await top();
  assert.ok(!render(snap, { width: 120 }).includes('keys:'));
  const lines = render(snap, { width: 45, keys: true }).split('\n');
  const first = lines.findIndex((l) => l.startsWith('keys:'));
  assert.ok(first > 0 && lines.slice(first).every((l) => cells(l) <= 45));
});

test('a frame given the terminal\'s rows keeps the header, what waits on you, the accounts, today and the keys, cuts the tree, and says how much is left out', async () => {
  const w = world();
  const { snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot(w.opts));
  const full = render(snap, { width: 200 }).split('\n');
  const cut = render(snap, { width: 200, rows: full.length - 3 }).split('\n');
  assert.equal(cut.length, full.length - 3);
  assert.deepEqual(cut.slice(0, 5), full.slice(0, 5));
  assert.deepEqual(cut.slice(-4), full.slice(-4));
  assert.match(cut.find((l) => l.startsWith('…')), /^… 4 more rows \(a repository's tab shows fewer\); 1-9 or Tab tabs, c full columns, q quits$/);
  assert.equal(render(snap, { width: 200, rows: 500 }), full.join('\n'));
});

test('a failed gh read keeps the last good one and says when; with none, the fields are ?, never unclaimed or no PR', async () => {
  const w = world();
  const { snapshot, render } = await top();
  const keep = {};
  const good = await withPath(w.bin, () => snapshot({ ...w.opts, cache: keep }));
  assert.ok(good.github.ok);
  writeFileSync(join(w.bin, 'gh'), '#!/bin/sh\necho "HTTP 502" >&2\nexit 1\n');
  const later = await withPath(w.bin, () => snapshot({ ...w.opts, cache: keep, now: NOW + 61_000 }));
  assert.equal(later.github.ok, false);
  const text = render(later, { width: 200 });
  assert.match(text, /tuannd9288\/factory +gh failed 12:01, showing 12:00/);
  assert.match(text, /#174 .*PR #260 .*factory top, the repo view/);
  assert.ok(!/unclaimed|no PR/.test(text.split('\n').filter((l) => /#174 /.test(l)).join('\n')));
  const none = await withPath(w.bin, () => snapshot({ ...w.opts, cache: {} }));
  const row = render(none, { width: 200 }).split('\n').find((l) => /^\s*\S.* #170 /.test(l));
  assert.match(row, /^ {4}× stuck +#170 \? +\? +PR \? +\?$/, 'team, step, pull request and title are ?');
  assert.ok(!/unclaimed|no PR|idle/.test(row));
});

test('a repository without the kit lists verify alone; a PR with it green and reviewDecision REVIEW_REQUIRED waits on the Human', async () => {
  const w = world();
  const { rmSync } = await import('node:fs');
  rmSync(join(w.root, 'WORKSPACES/factory/.gate'), { recursive: true });
  writeFileSync(join(w.fx, 'prs.json'), JSON.stringify([
    { number: 260, title: 'top view', state: 'OPEN', headRefName: 'issue-174-top', body: 'Issue: #174\nTeam: alpha', labels: [], mergedAt: null, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  ]));
  const { text } = await frame(w);
  const row = text.split('\n').find((l) => / #174 /.test(l));
  assert.match(row, /^ {4}! on you #174 .*PR #260 verify✓ /);
  assert.ok(!/review|verdict|tier/.test(row));
  assert.match(readFileSync(w.log, 'utf8'), /pr list .*reviewDecision/);
});

test('small things: <synthetic> messages give no model or context; a negative age is 0s; control characters are stripped', async () => {
  const { parseLog, age } = await top();
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  const p = parseLog(assistant('m1', u) + line({ type: 'assistant', message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }));
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.equal(p.ctx, 1110);
  assert.equal(age(-5000), '0s');
  assert.equal(age(NaN), '?');
  const w = world();
  writeFileSync(join(w.fx, 'issues.json'), JSON.stringify([{ number: 174, title: 'evil\x1b[31m\x07 title', state: 'OPEN', labels: [] }]));
  const { text } = await frame(w);
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(text));
  assert.match(text, /evil\[31m title/);
});

test('a field the data does not give shows as ?', async () => {
  const w = world();
  const { text } = await frame(w);
  const lead = text.split('\n').find((l) => /^\s*aardvark /.test(l));
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
  assert.match(text, /badger/);
});

test('the queue and the alerts come from the state folder files', async () => {
  const w = world();
  const { queueOf } = await top();
  const q = queueOf(w.opts.state);
  assert.equal(q.lastSweep, '2026-10-31T11:59:00Z');
  assert.equal(q.failed.length, 1);
  assert.equal(queueOf(join(w.root, 'missing')).lastSweep, null);
});

test('the ledger\'s lastRecords is the one reader of "a session\'s last record", and Today counts a resumed session once (#311)', async () => {
  const { lastRecords } = await import('../bin/lib/ledger.mjs');
  const rec = (end, cost) => ({ session: 's1', role: 'worker', seat: 2, tag: 't', run: '/r', start: '2026-10-31T08:00:00Z', end, total_cost_usd: cost });
  assert.deepEqual(lastRecords([rec('2026-10-31T10:00:00Z', 1), rec('2026-10-31T09:00:00Z', 0.5)]).map((r) => r.total_cost_usd), [1]);
  const { todayOf } = await top();
  const accounts = [{ letter: 'a', name: 'acct-one', users: ['factory-lead'] }, { letter: 'b', name: 'acct-two', users: [] }];
  const t = todayOf({ now: NOW, repos: [], github: { repos: {} }, records: [rec('2026-10-31T09:00:00Z', 0.5), rec('2026-10-31T10:00:00Z', 1)], accounts, seatRows: { 2: 'acct-one' } });
  assert.deepEqual(t.cost, [['a', 1]], 'a record with no account of its own is its seat\'s old row\'s');
  const own = todayOf({ now: NOW, repos: [], github: { repos: {} }, records: [{ ...rec('2026-10-31T10:00:00Z', 2), account: 'acct-two', team: 'factory-b' }], accounts, seatRows: { 2: 'acct-one' } });
  assert.deepEqual(own.cost, [['b', 2]], 'a record\'s own account wins');
});

test('local times: HH:MM on the day of now, MM-DD HH:MM on another, ? for no time', async () => {
  const { local } = await top();
  assert.equal(local(Date.parse('2026-10-31T09:05:00Z'), NOW), '09:05');
  assert.equal(local(Date.parse('2026-10-30T23:59:00Z'), NOW), '10-30 23:59');
  assert.equal(local(NaN, NOW), '?');
});

test('ps\'s elapsed time reads as milliseconds: mm:ss, hh:mm:ss and dd-hh:mm:ss', async () => {
  const { etimeMs } = await top();
  assert.equal(etimeMs('05:30'), 330_000);
  assert.equal(etimeMs('1:02:03'), 3_723_000);
  assert.equal(etimeMs('2-03:04:05'), ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000);
  assert.equal(etimeMs('nonsense'), null);
});

const HOOKED = 'claude --model opus --name factory-lead --settings {"hooks":{"SessionStart":[{"hooks":[]}]}}';
const leadOf = async (w, proc, state) => {
  const dir = join(w.opts.runs, 'factory-lead');
  if (state === null) rmSync(join(dir, 'state.json'), { force: true });
  else if (state) writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const { snapshot } = await top();
  const snap = await withPath(w.bin, () => snapshot({ ...w.opts, processes: () => [proc] }));
  return { snap, lead: snap.sessions.find((s) => s.role === 'lead') };
};

test('a Lead\'s state is its newest hook event, through one table: a prompt that needs a person is waiting for you, a prompt for input or a stop is idle, a submitted prompt is working', async () => {
  const w = world();
  const at = new Date(NOW - 30_000).toISOString();
  for (const [event, type, state] of [
    ['Notification', 'permission_prompt', 'waiting'], ['Notification', 'elicitation_dialog', 'waiting'], ['Notification', 'idle_prompt', 'idle'],
    ['Stop', null, 'idle'], ['SessionStart', null, 'idle'], ['UserPromptSubmit', null, 'working'],
  ]) {
    const { lead } = await leadOf(w, { pid: 1, command: HOOKED, ageMs: 600_000 }, { event, type, at });
    assert.equal(lead.state, state, `${event} ${type}`);
    assert.equal(lead.stateAt, NOW - 30_000);
  }
  const { lead } = await leadOf(w, { pid: 1, command: HOOKED, ageMs: 600_000 }, { event: 'Notification', type: 'auth_success', at });
  assert.equal(lead.state, 'idle', 'an event the table does not name leaves the state the log gives');
});

test('a Lead with the new hooks, alive over a minute, with no event since its start, waits for you at the login or the folder trust; an older Lead never does', async () => {
  const w = world();
  const stale = { event: 'Stop', type: null, at: new Date(NOW - 1_000_000).toISOString() };
  writeFileSync(join(w.opts.runs, 'factory-lead/pane'), 'p-7\n');
  for (const state of [null, stale]) {
    const { lead, snap } = await leadOf(w, { pid: 1, command: HOOKED, ageMs: 120_000 }, state);
    assert.equal(lead.state, 'waiting');
    assert.equal(lead.waitNote, 'login or folder trust?');
    const text = (await top()).render(snap, { width: 200 });
    assert.match(text, /^ {2}answer {3}aardvark \(factory Lead, team lead\) {2}pane p-7 {2}login or folder trust\?$/m);
    assert.match(text.split('\n')[0], /1 agent waiting/);
  }
  assert.equal((await leadOf(w, { pid: 1, command: HOOKED, ageMs: 30_000 }, null)).lead.state, 'idle', 'not yet a minute');
  assert.equal((await leadOf(w, { pid: 1, command: 'claude --name factory-lead --settings {"hooks":{"Stop":[]}}', ageMs: 900_000 }, null)).lead.state, 'idle', 'started before the new hooks');
});

test('a Lead waiting on a prompt is listed as an item that names its pane; with no pane file the pane is its name', async () => {
  const w = world();
  const state = { event: 'Notification', type: 'permission_prompt', at: new Date(NOW - 5000).toISOString() };
  const { snap } = await leadOf(w, { pid: 1, command: HOOKED, ageMs: 600_000 }, state);
  const { render } = await top();
  assert.match(render(snap, { width: 200 }), /^ {2}answer {3}aardvark \(factory Lead, team lead\) {2}pane aardvark$/m);
});

test('the accounts come from the accounts file and each account\'s own newest event; their users are teams; none named, no section (#311)', async () => {
  const w = world();
  const { snap } = await frame(w);
  assert.deepEqual(snap.accounts.map((a) => [a.letter, a.name, a.users]), [['a', 'acct-one', ['factory-lead']], ['b', 'acct-two', ['factory-b']]]);
  rmSync(join(w.opts.state, 'accounts'));
  const none = (await frame(w)).text;
  assert.ok(!none.includes('Accounts'));
});

test('Today counts the pull requests merged today, the cost of the records that ended today by account letter, and the time pull requests waited on the Human, clipped to today', async () => {
  const w = world();
  const { snap } = await frame(w);
  assert.deepEqual(snap.today, { merged: 1, cost: [['b', 1.6]], waitedMs: 90 * 60_000 });
});

test('a snapshot with no sessions and no issues renders at 45 and 120 columns, plain and --full, and every line fits', async () => {
  const { cells, render } = await top();
  const empty = (repos) => ({
    now: NOW, load: [0, 0, 0], cores: 8, sessions: [], repos, github: { ok: true, at: NOW, error: null },
    queue: { lastSweep: null, queueFailed: 0, failed: [] }, accounts: [], today: { merged: 0, cost: [], waitedMs: 0 },
  });
  for (const snap of [empty([]), empty([{ repo: 'o/n', groups: [], other: [], ghStatus: null }])]) {
    for (const width of [45, 120]) {
      for (const full of [false, true]) {
        const lines = render(snap, { width, full, color: true, keys: true }).split('\n');
        assert.ok(lines.length > 3);
        for (const l of lines) assert.ok(cells(l) <= width, `${width}: ${l}`);
      }
    }
  }
});

test('at 45 columns a row\'s name keeps 8 cells: a long note is cut or dropped first', async () => {
  const w = world();
  writeFileSync(join(w.opts.runs, 'issue-174/run-reviewer.name'), 'hippopotamus\n');
  const { snap } = await leadOf(w, { pid: 1, command: HOOKED, ageMs: 120_000 }, null);
  assert.equal(snap.sessions.find((s) => s.role === 'lead').waitNote, 'login or folder trust?');
  const { cells, render } = await top();
  const lines = render(snap, { width: 45 }).split('\n');
  for (const l of lines) assert.ok(cells(l) <= 45, l);
  assert.match(lines.find((l) => /^ {6}hippo/.test(l)), /^ {6}hippopo… +✓ done/, 'eight cells of the name, ellipsis included');
  assert.match(lines.find((l) => /^ {2}aardvark/.test(l)), /^ {2}aardvark +! waiting/);
});

test('a folded repository line is whole items, wrapped onto an indented line, never cut inside an item', async () => {
  const w = world();
  const { snap } = await frame(w);
  const { cells, render } = await top();
  const base = snap.sessions.find((s) => s.name === 'beaver');
  const repo = 'tuannd9288/factory-pack-scratch';
  const old = { ...base, name: 'moth', repo, issue: null, folder: null, live: false, state: 'done', lastAt: NOW - 3 * 86400_000 };
  const quiet = { ...snap, sessions: [...snap.sessions, old], repos: [...snap.repos, { repo, groups: [{ ...snap.repos[0].groups[0], number: 9, done: false, active: false, recent: false, sessions: [] }], other: [old], ghStatus: null }] };
  const wide = render(quiet, { width: 200 }).split('\n');
  assert.equal(wide.filter((l) => l.startsWith(repo)).length, 1);
  assert.match(wide.find((l) => l.startsWith(repo)), /\b1\b.*\b1\b/, 'one line when it fits');
  const lines = render(quiet, { width: 45 }).split('\n');
  const at = lines.findIndex((l) => l.startsWith(repo));
  assert.ok(at > 0);
  for (const l of lines) assert.ok(cells(l) <= 45, l);
  assert.ok(!lines.slice(at, at + 2).some((l) => l.includes('…')), 'nothing is cut');
  assert.equal(lines[at], repo, 'the name alone on its line');
  assert.match(lines[at + 1], /^ {2}1 .*, 1 \S+$/, 'both counts, whole, on an indented line');
});

test('an open issue whose pull request merged is ✓ merged, dim, only where it would be idle: live work reads on team, a failure reads stuck', async () => {
  const w = world();
  const prs = JSON.parse(readFileSync(join(w.fx, 'prs.json'), 'utf8'));
  prs[0] = { ...prs[0], state: 'MERGED', mergedAt: '2026-10-31T10:00:00Z' };
  writeFileSync(join(w.fx, 'prs.json'), JSON.stringify(prs));
  const { snap } = await frame(w);
  const { render } = await top();
  const row = (s, opts = {}) => render(s, { width: 200, ...opts }).split('\n').find((l) => / #174 /.test(l));
  const variant = (sessions) => ({ ...snap, repos: snap.repos.map((r) => ({ ...r, groups: r.groups.map((g) => (g.number === 174 ? { ...g, sessions, waiting: '–' } : g)) })) });
  const done = snap.sessions.find((s) => s.name === 'beaver');
  assert.match(row(snap), /^ {4}● on team +#174 /, 'a worker still runs on its next round');
  assert.match(row(variant([{ ...done, name: 'ember', state: 'failed', lastAt: NOW - 1000 }])), /^ {4}× stuck +#174 /);
  assert.match(row(variant([done])), /^ {4}✓ merged +#174 /);
  assert.ok(row(variant([done]), { color: true }).includes('\x1b[2m✓ merged\x1b[0m'));
  assert.match(row(variant([])), /^ {4}✓ merged +#174 /, 'with no session at all');
});

test('at 45 columns each cost of Today is whole on its line, with its account, and no line of Today is cut', async () => {
  const w = world();
  const { snap } = await frame(w);
  const { render } = await top();
  const cost = [['a', 3.57], ['b', 30.01]];
  const lines = render({ ...snap, today: { ...snap.today, cost } }, { width: 45 }).split('\n');
  const today = lines.slice(lines.findIndex((l) => l.startsWith('Today')));
  assert.ok(today.length > 1);
  assert.ok(!today.some((l) => l.includes('…')), 'nothing is cut');
  for (const piece of ['$3.57 on account a', '$30.01 on account b']) assert.equal(today.filter((l) => l.includes(piece)).length, 1, piece);
  assert.equal(render({ ...snap, today: { ...snap.today, cost } }, { width: 200 }).split('\n').at(-1), 'Today  1 pull request merged · workers and reviewers cost $3.57 on account a, $30.01 on account b · waited on you 1h30');
});

test('the live loop reads until ten minutes pass without a key (#396)', async () => {
  const { readDue } = await top();
  const lastKeyAt = 1_000_000;
  const min = 60_000;
  assert.equal(readDue({ lastKeyAt, now: lastKeyAt + 9 * min }), true);
  assert.equal(readDue({ lastKeyAt, now: lastKeyAt + 10 * min }), false);
  assert.equal(readDue({ lastKeyAt, now: lastKeyAt + 30 * min }), false);
  assert.equal(readDue({ lastKeyAt: lastKeyAt + 30 * min, now: lastKeyAt + 30 * min }), true);
});
