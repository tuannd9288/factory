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
  mkdirSync(join(root, 'WORKSPACES/factory/.gate/bin'), { recursive: true });
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  session(runs, 'issue-174', 'worker', { log: init(cwd) + assistant('m1', u) + assistant('m2', { ...u, output_tokens: 7 }) });
  session(runs, 'issue-174', 'reviewer', { log: init(cwd) + assistant('m1', u) + result({ total_cost_usd: 1.5, num_turns: 4 }), ageSecs: 4000 });
  session(runs, 'issue-170', 'worker', { log: init(cwd) + assistant('m1', u) + limit('rejected', NOW / 1000 + 3600) + result({ is_error: true, subtype: 'error', api_error_status: 429 }), seat: '1', ageSecs: 600 });
  session(runs, 'issue-169', 'worker', { log: init(cwd) + assistant('m1', u), ageSecs: 90000 });
  session(runs, 'issue-174', 'old', { log: init(cwd) + assistant('m1', u), ageSecs: 90000 });
  session(runs, 'issue-150', 'worker', { log: init(cwd) + assistant('m1', u) + result({ is_error: true, subtype: 'error_during_execution' }), ageSecs: 7200 });
  const lead = join(runs, 'factory-lead/transcripts');
  mkdirSync(lead, { recursive: true });
  writeFileSync(join(lead, 'abc.jsonl'), assistant('l1', u));
  utimesSync(join(lead, 'abc.jsonl'), NOW / 1000 - 10000, NOW / 1000 - 10000);
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
    { number: 151, title: 'Closed with no PR', state: 'CLOSED', labels: [] },
    { number: 17, title: 'A quiet open issue', state: 'OPEN', labels: [] },
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
    branchOf: () => 'issue-174-top', originOf: () => null, load: [2.31, 1.98, 1.5], claims,
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
  assert.match(lines[1], /\[1 All\] .*\[2 factory 4\].*\[3 Done 2\]/);
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

test('under an issue, sessions that ended over a day ago fold into one "N gone" row', async () => {
  const w = world();
  const lines = (await frame(w, 0)).text.split('\n');
  const group = lines.findIndex((l) => /#174 factory top/.test(l));
  const gone = lines.findIndex((l, i) => i > group && /^\s+1 gone$/.test(l));
  assert.ok(gone > group, 'the gone row sits under #174');
  assert.ok(!lines.some((l) => /^\s*174-old /.test(l)));
});

test('All shows an issue only while it has a live session, a claim, an open PR or a recent session; the rest fold into "N older"', async () => {
  const w = world();
  const all = (await frame(w, 0)).text;
  for (const n of [174, 170]) assert.match(all, new RegExp(`#${n} `));
  assert.ok(!/#17 A quiet/.test(all));
  assert.ok(!/#169 /.test(all));
  assert.match(all, /^\s*2 older$/m);
  assert.ok(!/#15[01] /.test(all));
});

test('the Done tab holds the closed issues, merged or not', async () => {
  const w = world();
  const done = (await frame(w, 2)).text;
  assert.match(done, /#150 An old task.*step merged/);
  assert.match(done, /#151 Closed with no PR.*step closed/);
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

test('every line of the frame, the column header included, is cut to the width', async () => {
  const w = world();
  const { text } = await frame(w, 0, 80);
  for (const l of text.split('\n')) assert.ok(l.length <= 80, `${l.length}: ${l}`);
});

test('a frame given the terminal\'s rows keeps the header, tabs and column header, cuts the tree, and says how much is left out', async () => {
  const w = world();
  const { snapshot, render } = await top();
  const snap = await withPath(w.bin, () => snapshot(w.opts));
  const full = render(snap, { width: 200 }).split('\n');
  const cut = render(snap, { width: 200, rows: 12 }).split('\n');
  assert.equal(cut.length, 12);
  assert.deepEqual(cut.slice(0, 4), full.slice(0, 4));
  assert.match(cut.at(-1), /^… \d+ more rows/);
  assert.match(cut.at(-1), /a repository's tab shows fewer/);
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
  assert.match(text, /#174 factory top, the repo view .*PR #260/);
  assert.ok(!/step unclaimed|no PR/.test(text.split('\n').filter((l) => /#174 /.test(l)).join('\n')));
  const none = await withPath(w.bin, () => snapshot({ ...w.opts, cache: {} }));
  const row = render(none, { width: 200 }).split('\n').find((l) => /^\s*#170 /.test(l));
  assert.match(row, /step \?/);
  assert.match(row, /PR \?/);
  assert.match(row, /waiting on \?/);
  assert.ok(!/unclaimed|no PR|waiting on –/.test(row));
});

test('a repository without the kit lists verify alone; a PR with it green and reviewDecision REVIEW_REQUIRED waits on the Human', async () => {
  const w = world();
  const { rmSync } = await import('node:fs');
  rmSync(join(w.root, 'WORKSPACES/factory/.gate'), { recursive: true });
  writeFileSync(join(w.fx, 'prs.json'), JSON.stringify([
    { number: 260, title: 'top view', state: 'OPEN', headRefName: 'issue-174-top', body: 'Issue: #174\nTeam: alpha', labels: [], mergedAt: null, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  ]));
  const { text } = await frame(w);
  const row = text.split('\n').find((l) => /^\s*#174 /.test(l));
  assert.match(row, /PR #260 verify✓\s+waiting on the Human/);
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
