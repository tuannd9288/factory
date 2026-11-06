// Shared session and status readers, using fixture folders and commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local times are shown in the machine's zone; the fixtures are in UTC, so a local time reads as the fixture's.
process.env.TZ = 'UTC';

const top = () => import('../bin/lib/colly-status.mjs');

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

const readSnapshot = async (w) => {
  const { snapshot } = await top();
  const snap = await withPath(w.bin, () => snapshot(w.opts));
  return { snap };
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
  const { snap } = await readSnapshot(w);
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
  const { snap } = await readSnapshot(w);
  const names = snap.sessions.map((s) => s.name);
  for (const n of ['badger', 'beaver', 'aardvark', '170-worker', '150-worker']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('174-worker') && !names.includes('factory-lead'));
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

test('the queue and the alerts come from the state folder files', async () => {
  const w = world();
  const { queueOf } = await top();
  const q = queueOf(w.opts.state);
  assert.equal(q.lastSweep, '2026-10-31T11:59:00Z');
  assert.equal(q.failed.length, 1);
  assert.equal(queueOf(join(w.root, 'missing')).lastSweep, null);
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
});

test('a Lead with the new hooks, alive over a minute, with no event since its start, waits for you at the login or the folder trust; an older Lead never does', async () => {
  const w = world();
  const stale = { event: 'Stop', type: null, at: new Date(NOW - 1_000_000).toISOString() };
  writeFileSync(join(w.opts.runs, 'factory-lead/pane'), 'p-7\n');
  for (const state of [null, stale]) {
    const { lead, snap } = await leadOf(w, { pid: 1, command: HOOKED, ageMs: 120_000 }, state);
    assert.equal(lead.state, 'waiting');
    assert.equal(lead.waitNote, 'login or folder trust?');
  }
  assert.equal((await leadOf(w, { pid: 1, command: HOOKED, ageMs: 30_000 }, null)).lead.state, 'idle', 'not yet a minute');
  assert.equal((await leadOf(w, { pid: 1, command: 'claude --name factory-lead --settings {"hooks":{"Stop":[]}}', ageMs: 900_000 }, null)).lead.state, 'idle', 'started before the new hooks');
});
