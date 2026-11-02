// #309: the queue's sweep writes one line to $FACTORY_STATE/events.jsonl when one of five conditions begins and one when it ends;
// bin/factory-events prints the lines that begin one; `factory top` lists the new conditions under "Waiting on you". A fake gh and
// fixture folders; every tool started gets a state folder of its own, and nothing is written outside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

process.env.TZ = 'UTC';

const events = () => import('../bin/lib/events.mjs');

/** Runs body in a fresh folder and removes it when body is done: for an async body, once its promise has settled. */
function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = body(dir);
  } catch (error) {
    remove();
    throw error;
  }
  if (typeof result?.then !== 'function') {
    remove();
    return result;
  }
  return result.finally(remove);
}

const linesOf = (state) => {
  const file = join(state, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const shape = (state) => linesOf(state).map((l) => `${l.type} ${l.key}`);

const T0 = Date.parse('2026-11-02T10:00:00Z');
const MIN = 60_000;

const pr = (o = {}) => ({ number: 12, isDraft: false, autoMerge: true, mergeStateStatus: 'BLOCKED', labels: [], checks: {}, apps: {}, ...o });
const run = (status, conclusion = null) => ({ status, state: status === 'COMPLETED' ? conclusion : 'PENDING' });

/** One sweep's worth of what the sweep read for o/app, handed to record. */
async function sweepOf(state, prs, { required = ['verify'], issues = [], now, repo = 'o/app' }) {
  const e = await events();
  record(e, state, [...e.checksNotStarted({ repo, prs, required }), ...e.humanWaits({ repo, prs, issues })], new Set([repo]), now);
}
const record = (e, state, found, read, now) => e.record({ state, found, read, now });

test('condition 1: a required check missing or queued past the limit writes one start, nothing while it holds, one clear when it starts', async () => {
  const e = await events();
  for (const checks of [{}, { verify: run('QUEUED') }, { verify: run('PENDING') }]) {
    await withDir(async (state) => {
      const waiting = [pr({ checks })];
      await sweepOf(state, waiting, { now: T0 });
      await sweepOf(state, waiting, { now: T0 + e.NOT_STARTED_MS - 1 });
      assert.deepEqual(shape(state), [], 'before the limit it writes nothing');
      await sweepOf(state, waiting, { now: T0 + e.NOT_STARTED_MS });
      await sweepOf(state, waiting, { now: T0 + e.NOT_STARTED_MS + 5 * MIN });
      assert.deepEqual(shape(state), ['start check-not-started o/app#12 verify']);
      assert.equal(linesOf(state)[0].seq, 1);
      assert.equal(linesOf(state)[0].kind, 'check-not-started');
      assert.match(linesOf(state)[0].text, /o\/app#12.*verify/);
      await sweepOf(state, [pr({ checks: { verify: run('IN_PROGRESS') } })], { now: T0 + 40 * MIN });
      await sweepOf(state, [pr({ checks: { verify: run('IN_PROGRESS') } })], { now: T0 + 41 * MIN });
      assert.deepEqual(shape(state), ['start check-not-started o/app#12 verify', 'clear check-not-started o/app#12 verify']);
      assert.deepEqual(linesOf(state).map((l) => l.seq), [1, 2]);
    });
  }
});

test('condition 1: a check that started before the limit writes nothing at all, and a pull request that closed clears', async () => {
  const e = await events();
  await withDir(async (state) => {
    await sweepOf(state, [pr()], { now: T0 });
    await sweepOf(state, [pr({ checks: { verify: run('COMPLETED', 'SUCCESS') } })], { now: T0 + 10 * MIN });
    await sweepOf(state, [pr()], { now: T0 + 20 * MIN });
    await sweepOf(state, [pr()], { now: T0 + 20 * MIN + e.NOT_STARTED_MS - 1 });
    assert.deepEqual(shape(state), [], 'the wait counts again from the sweep that saw it again');
  });
  await withDir(async (state) => {
    await sweepOf(state, [pr()], { now: T0 });
    await sweepOf(state, [pr()], { now: T0 + e.NOT_STARTED_MS });
    await sweepOf(state, [], { now: T0 + e.NOT_STARTED_MS + MIN });
    assert.deepEqual(shape(state), ['start check-not-started o/app#12 verify', 'clear check-not-started o/app#12 verify']);
  });
});

test('condition 1: an App check (Entire Gates) is looked for as the sweep looks for it', async () => {
  const e = await events();
  await withDir(async (state) => {
    const p = pr({ checks: { verify: run('COMPLETED', 'SUCCESS') }, apps: { 'Entire Gates': run('IN_PROGRESS') } });
    await sweepOf(state, [p], { required: ['verify', 'Entire Gates'], now: T0 });
    await sweepOf(state, [p], { required: ['verify', 'Entire Gates'], now: T0 + e.NOT_STARTED_MS });
    assert.deepEqual(shape(state), []);
  });
});

test('condition 1: a draft, a pull request without auto-merge and a DIRTY one write nothing', async () => {
  const e = await events();
  await withDir(async (state) => {
    const quiet = [pr({ number: 1, isDraft: true }), pr({ number: 2, autoMerge: false }), pr({ number: 3, mergeStateStatus: 'DIRTY' })];
    await sweepOf(state, quiet, { now: T0 });
    await sweepOf(state, quiet, { now: T0 + 3 * e.NOT_STARTED_MS });
    assert.deepEqual(shape(state), []);
    assert.ok(!existsSync(join(state, 'events.jsonl')));
  });
});

test('condition 2: a tier-3 or needs-human pull request whose tier check did not succeed starts once and clears when it does', async () => {
  await withDir(async (state) => {
    const waiting = (labels, tier) => [pr({ labels, checks: { verify: run('COMPLETED', 'SUCCESS'), tier } })];
    await sweepOf(state, waiting(['tier-3'], run('COMPLETED', 'FAILURE')), { now: T0 });
    await sweepOf(state, waiting(['tier-3'], run('COMPLETED', 'FAILURE')), { now: T0 + MIN });
    await sweepOf(state, waiting(['tier-3'], run('IN_PROGRESS')), { now: T0 + 2 * MIN });
    assert.deepEqual(shape(state), ['start waiting-on-human o/app#12', 'clear waiting-on-human o/app#12'], 'a running tier check is not a wait');
    await sweepOf(state, waiting(['needs-human'], run('COMPLETED', 'FAILURE')), { now: T0 + 3 * MIN });
    await sweepOf(state, waiting(['needs-human'], run('COMPLETED', 'SUCCESS')), { now: T0 + 4 * MIN });
    assert.deepEqual(shape(state).slice(2), ['start waiting-on-human o/app#12', 'clear waiting-on-human o/app#12']);
    await sweepOf(state, waiting(['tier-2'], run('COMPLETED', 'FAILURE')), { now: T0 + 5 * MIN });
    assert.equal(shape(state).length, 4, 'a pull request with no human label is no wait');
  });
});

test('condition 2: an open issue labelled needs-human starts once and clears when its label goes or it closes', async () => {
  await withDir(async (state) => {
    const issue = { number: 40, title: 'Lead asks: which runner?' };
    await sweepOf(state, [], { issues: [issue], now: T0 });
    await sweepOf(state, [], { issues: [issue], now: T0 + MIN });
    assert.deepEqual(shape(state), ['start waiting-on-human o/app#40']);
    assert.match(linesOf(state)[0].text, /o\/app#40.*which runner/);
    await sweepOf(state, [], { issues: [], now: T0 + 2 * MIN });
    await sweepOf(state, [], { issues: [], now: T0 + 3 * MIN });
    assert.deepEqual(shape(state), ['start waiting-on-human o/app#40', 'clear waiting-on-human o/app#40']);
  });
});

/** A runs folder with one Lead's state.json, and the process list that names it. */
function leadWorld(dir, event) {
  const runs = join(dir, 'runs');
  mkdirSync(join(runs, 'app-lead'), { recursive: true });
  writeFileSync(join(runs, 'app-lead/name'), 'aardvark\n');
  const set = (ev) => writeFileSync(join(runs, 'app-lead/state.json'), `${JSON.stringify(ev)}\n`);
  set(event);
  return { runs, set, processes: () => [{ pid: 4242, ageMs: 3600_000, command: 'claude --model opus --name app-lead --continue' }] };
}

test('condition 3: a Lead whose newest hook event is a permission prompt or a dialog starts once, and clears when it works again', async () => {
  const e = await events();
  for (const type of ['permission_prompt', 'elicitation_dialog']) {
    await withDir(async (dir) => {
      const state = join(dir, 'state');
      const at = new Date(T0 - 5 * MIN).toISOString();
      const w = leadWorld(dir, { event: 'Notification', type, at });
      const seen = (now) => record(e, state, e.leadsAtDialog({ runs: w.runs, now, processes: w.processes }), new Set(['leads']), now);
      seen(T0);
      seen(T0 + MIN);
      assert.deepEqual(shape(state), ['start lead-at-dialog app-lead']);
      assert.match(linesOf(state)[0].text, /aardvark/);
      w.set({ event: 'UserPromptSubmit', type: null, at: new Date(T0 + 2 * MIN).toISOString() });
      seen(T0 + 3 * MIN);
      seen(T0 + 4 * MIN);
      assert.deepEqual(shape(state), ['start lead-at-dialog app-lead', 'clear lead-at-dialog app-lead']);
    });
  }
  await withDir(async (dir) => {
    const w = leadWorld(dir, { event: 'Stop', type: null, at: new Date(T0 - 5 * MIN).toISOString() });
    assert.deepEqual(e.leadsAtDialog({ runs: w.runs, now: T0, processes: w.processes }), [], 'a Stop is idle, not a dialog');
  });
});

test('condition 4: an account out of quota starts once for the account, not for each session, and clears when its reset passes', async () => {
  const e = await events();
  await withDir(async (dir) => {
    const state = join(dir, 'state');
    const runs = join(dir, 'runs');
    const profiles = join(dir, 'profiles');
    mkdirSync(state);
    mkdirSync(profiles);
    writeFileSync(join(state, 'accounts'), 'factory/factory-lead=acct-one\nfactory/factory-b=acct-two\n');
    const resetsAt = (T0 + 3600_000) / 1000;
    const limit = `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.2, resetsAt: resetsAt + 86400 } } } })}\n`;
    for (const tag of ['worker', 'reviewer']) {
      mkdirSync(join(runs, 'issue-1'), { recursive: true });
      writeFileSync(join(runs, 'issue-1', `run-${tag}.jsonl`), limit);
      writeFileSync(join(runs, 'issue-1', `run-${tag}.account`), 'acct-one\n');
    }
    const seen = (now) => record(e, state, e.accountsOut({ runs, state, agentProfiles: profiles, now }), new Set(['quota']), now);
    seen(T0);
    seen(T0 + MIN);
    assert.deepEqual(shape(state), ['start out-of-quota a']);
    assert.doesNotMatch(JSON.stringify(linesOf(state)), /acct-one/, 'the account is named by its letter');
    seen(T0 + 2 * 3600_000);
    seen(T0 + 2 * 3600_000 + MIN);
    assert.deepEqual(shape(state), ['start out-of-quota a', 'clear out-of-quota a']);
  });
});

test('condition 5: gh refused for a rate limit or a login is told; another error is not', async () => {
  const e = await events();
  const err = (stderr) => Object.assign(new Error('Command failed'), { stderr });
  for (const stderr of ['gh: API rate limit exceeded for user ID 1.\n', 'GraphQL: API rate limit already exceeded for user ID 1.', 'HTTP 403: You have exceeded a secondary rate limit', 'HTTP 429: too many requests', 'HTTP 401: Bad credentials (https://api.github.com/graphql)', 'To get started with GitHub CLI, please run:  gh auth login', 'gh: not logged in']) {
    const text = e.ghRefusal(['api', 'graphql', '-f', 'query=x'], err(stderr));
    assert.match(text, /^gh api graphql: /, stderr);
  }
  for (const stderr of ['HTTP 404: Not Found', 'HTTP 502: Bad Gateway', 'graphql down', '']) assert.equal(e.ghRefusal(['api', 'graphql'], err(stderr)), null, stderr);
  assert.equal(e.ghRefusal(['api', 'graphql'], Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' })), null);
});

/** A fake gh on PATH: `api user` and the rules answer; the graphql call answers $Q/graphql.json, or fails with $Q/graphql.err; every call is logged. */
function ghWorld(dir) {
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'runs'));
  mkdirSync(join(dir, 'profiles'));
  writeFileSync(
    join(dir, 'bin/gh'),
    '#!/bin/sh\necho "$*" >>"$Q/calls"\ncase "$*" in\n  "api user"*) if [ -f "$Q/user.err" ]; then cat "$Q/user.err" >&2; exit 1; fi; echo agent-bot ;;\n  *graphql*) if [ -f "$Q/graphql.err" ]; then cat "$Q/graphql.err" >&2; exit 1; fi; cat "$Q/graphql.json" ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n',
  );
  chmodSync(join(dir, 'bin/gh'), 0o755);
  const state = join(dir, 'state');
  const graphql = (nodes = [], issues = []) => writeFileSync(join(dir, 'graphql.json'), JSON.stringify({ data: { repository: { issues: { nodes: issues }, pullRequests: { nodes } } } }));
  graphql();
  const sweep = (...repos) => spawnSync(join(factory, 'bin/factory-queue'), ['sweep', ...(repos.length ? repos : ['o/app']).flatMap((r) => ['--repo', r])], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, Q: dir, HOME: join(dir, 'home'), FACTORY_STATE: state, FACTORY_RUNS: join(dir, 'runs'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_ROOT: join(dir, 'root') },
  });
  return { state, graphql, sweep, calls: () => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((l) => /^(api|pr|run|issue|repo) /.test(l)) };
}

test('condition 5: a rate-limited gh starts once, whatever else fails, and clears on the first sweep whose calls all succeed', () => {
  withDir((dir) => {
    const w = ghWorld(dir);
    writeFileSync(join(dir, 'graphql.err'), 'HTTP 403: API rate limit exceeded for user ID 1.\n');
    let r = w.sweep();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    r = w.sweep();
    assert.deepEqual(shape(w.state), ['start gh-refused']);
    assert.match(linesOf(w.state)[0].text, /^gh api graphql: HTTP 403: API rate limit exceeded/);
    writeFileSync(join(dir, 'graphql.err'), 'HTTP 502: Bad Gateway\n');
    w.sweep();
    assert.deepEqual(shape(w.state), ['start gh-refused'], 'a call that fails for another reason clears nothing');
    rmSync(join(dir, 'graphql.err'));
    r = w.sweep();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(shape(w.state), ['start gh-refused', 'clear gh-refused']);
  });
});

test('condition 5: a login refused before the repository loop is told as well', () => {
  withDir((dir) => {
    const w = ghWorld(dir);
    writeFileSync(join(dir, 'user.err'), 'gh: not logged in\n');
    const r = w.sweep();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.deepEqual(shape(w.state), ['start gh-refused']);
    assert.match(linesOf(w.state)[0].text, /^gh api user: gh: not logged in/);
  });
});

test('a gh error with a token-like string and an e-mail address leaves neither in the events file or its state', () => {
  withDir((dir) => {
    const w = ghWorld(dir);
    const secrets = ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789', 'someone.private@example.com'];
    writeFileSync(join(dir, 'graphql.err'), `HTTP 401: Bad credentials for ${secrets.join(' ')} (rate limit)\n`);
    w.sweep();
    const text = linesOf(w.state)[0].text;
    assert.match(text, /\[redacted\]/);
    assert.match(text, /\[account\]/);
    for (const file of ['events.jsonl', 'events-active.json']) {
      const body = readFileSync(join(w.state, file), 'utf8');
      for (const s of secrets) assert.ok(!body.includes(s), `${file} holds ${s}`);
      assert.ok(!body.includes('example.com'), file);
    }
  });
});

test('condition 2 comes from the sweep\'s one query: the calls of a sweep are the same as before, and a needs-human issue is told', () => {
  withDir((dir) => {
    const w = ghWorld(dir);
    w.graphql([], [{ number: 40, title: 'Lead asks' }]);
    const r = w.sweep();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = w.calls();
    assert.equal(calls.length, 3, calls.join('\n'));
    // The rules are read in full (#333: --paginate --slurp); it is the same one call.
    assert.deepEqual(calls.map((c) => c.replace(' --paginate --slurp', '').split(' ').slice(0, 2).join(' ')), ['api user', 'api repos/o/app/rules/branches/main', 'api graphql']);
    assert.match(calls[2], /issues\(states:OPEN,labels:\["needs-human"\]/);
    assert.deepEqual(shape(w.state), ['start waiting-on-human o/app#40']);
  });
});

test('a repository the sweep could not read keeps its conditions; only a read that succeeded ends one', () => {
  withDir((dir) => {
    const w = ghWorld(dir);
    w.graphql([], [{ number: 40, title: 'Lead asks' }]);
    w.sweep();
    writeFileSync(join(dir, 'graphql.err'), 'HTTP 502: Bad Gateway\n');
    const r = w.sweep();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(shape(w.state), ['start waiting-on-human o/app#40'], 'a failed read writes no clear');
    rmSync(join(dir, 'graphql.err'));
    w.graphql([], []);
    w.sweep();
    assert.deepEqual(shape(w.state), ['start waiting-on-human o/app#40', 'clear waiting-on-human o/app#40']);
  });
});

/** An events file with these lines, seq counting from 1. */
function seed(state, specs) {
  mkdirSync(state, { recursive: true });
  const lines = specs.map(([type, key], i) => JSON.stringify({ seq: i + 1, at: '2026-11-02T10:00:00.000Z', type, kind: key.split(' ')[0], key, text: `text of ${key}` }));
  writeFileSync(join(state, 'events.jsonl'), `${lines.join('\n')}\n`);
}
const append = (state, n, type, key) => appendFileSync(join(state, 'events.jsonl'), `${JSON.stringify({ seq: n, at: '2026-11-02T10:05:00.000Z', type, kind: key.split(' ')[0], key, text: `text of ${key}` })}\n`);

const eventsEnv = (state) => ({ ...process.env, FACTORY_STATE: state });

test('factory-events without --follow prints the start lines after the cursor and leaves the cursor where it was', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    seed(state, [['start', 'out-of-quota a'], ['clear', 'out-of-quota a'], ['start', 'gh-refused']]);
    const first = spawnSync(join(factory, 'bin/factory-events'), [], { encoding: 'utf8', env: eventsEnv(state) });
    assert.equal(first.status, 0, first.stderr);
    const printed = first.stdout.split('\n').filter(Boolean);
    assert.equal(printed.length, 2);
    assert.ok(printed.every((l) => JSON.parse(l).type === 'start'));
    assert.ok(!existsSync(join(state, 'events.cursor')), 'a look moves no cursor');
    const again = spawnSync(join(factory, 'bin/factory-events'), [], { encoding: 'utf8', env: eventsEnv(state) });
    assert.equal(again.stdout, first.stdout);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** factory-events --follow (with these args), with what it has printed so far. */
function follow(state, args = []) {
  const child = spawn(join(factory, 'bin/factory-events'), ['--follow', ...args], { env: eventsEnv(state), stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { out: '', err: '' };
  child.stdout.on('data', (d) => (seen.out += d));
  child.stderr.on('data', (d) => (seen.err += d));
  const lines = () => seen.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const until = async (n) => {
    for (let i = 0; i < 100 && lines().length < n; i += 1) await sleep(100);
    assert.equal(lines().length >= n, true, `waited for ${n} lines, saw ${seen.out}`);
  };
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  const stop = () => new Promise((r) => (ended() ? r() : (child.once('exit', r), child.kill())));
  const exits = async () => {
    for (let i = 0; i < 100 && !ended(); i += 1) await sleep(100);
    return ended();
  };
  return { child, lines, until, stop, exits, err: () => seen.err };
}

/** Runs body with a function that starts a follower; every follower it started is stopped when body ends, a failed body included. */
async function withFollowers(body) {
  const all = [];
  try {
    return await body((state, args) => {
      const f = follow(state, args);
      all.push(f);
      return f;
    });
  } finally {
    await Promise.all(all.map((f) => f.stop()));
  }
}

const cursorOf = (state) => readFileSync(join(state, 'events.cursor'), 'utf8').trim();

test('factory-events --follow prints each start line once and no clear line; started again it prints the ones it missed and none it printed', async () => {
  await withDir((dir) =>
    withFollowers(async (start) => {
      const state = join(dir, 'state');
      seed(state, [['start', 'out-of-quota a'], ['clear', 'out-of-quota a'], ['start', 'gh-refused']]);
      const first = start(state);
      await first.until(2);
      append(state, 4, 'clear', 'gh-refused');
      append(state, 5, 'start', 'waiting-on-human o/app#40');
      await first.until(3);
      await sleep(1200);
      assert.deepEqual(first.lines().map((l) => l.seq), [1, 3, 5]);
      assert.equal(cursorOf(state), '5');
      await first.stop();
      append(state, 6, 'start', 'lead-at-dialog app-lead');
      append(state, 7, 'clear', 'lead-at-dialog app-lead');
      append(state, 8, 'start', 'out-of-quota b');
      const second = start(state);
      await second.until(2);
      await sleep(1200);
      assert.deepEqual(second.lines().map((l) => l.seq), [6, 8]);
    }),
  );
});

test('a follower whose reader has gone leaves the cursor before the line it could not deliver, and the next follower prints that line', async () => {
  await withDir((dir) =>
    withFollowers(async (start) => {
      const state = join(dir, 'state');
      seed(state, [['start', 'out-of-quota a']]);
      const first = start(state);
      await first.until(1);
      first.child.stdout.destroy();
      append(state, 2, 'start', 'gh-refused');
      assert.equal(await first.exits(), true, 'the follower ends on its failed write');
      assert.equal(cursorOf(state), '1');
      const second = start(state);
      await second.until(1);
      assert.deepEqual(second.lines().map((l) => l.seq), [2]);
      assert.equal(cursorOf(state), '2');
    }),
  );
});

test('--after starts after that seq in place of the cursor, and still moves the cursor only with --follow', async () => {
  await withDir((dir) =>
    withFollowers(async (start) => {
      const state = join(dir, 'state');
      seed(state, [['start', 'out-of-quota a'], ['start', 'gh-refused'], ['clear', 'gh-refused'], ['start', 'lead-at-dialog app-lead']]);
      writeFileSync(join(state, 'events.cursor'), '1\n');
      const look = spawnSync(join(factory, 'bin/factory-events'), ['--after', '1'], { encoding: 'utf8', env: eventsEnv(state) });
      assert.equal(look.status, 0, look.stderr);
      assert.deepEqual(look.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).seq), [2, 4], 'the cursor at 1 is ignored');
      assert.equal(cursorOf(state), '1', 'a look leaves a lower cursor alone');
      const raising = start(state, ['--after', '2']);
      await raising.until(1);
      await sleep(800);
      assert.deepEqual(raising.lines().map((l) => l.seq), [4]);
      assert.equal(cursorOf(state), '4', 'a follower raises the cursor to what it printed');
      await raising.stop();
      const lower = start(state, ['--after', '0']);
      await lower.until(3);
      await sleep(800);
      assert.deepEqual(lower.lines().map((l) => l.seq), [1, 2, 4]);
      assert.equal(cursorOf(state), '4', 'printing lower seqs never lowers the cursor');
    }),
  );
});

test('--after above the highest seq starts from the first line and says so; so does a cursor above it', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    seed(state, [['start', 'out-of-quota a'], ['start', 'gh-refused']]);
    const after = spawnSync(join(factory, 'bin/factory-events'), ['--after', '9'], { encoding: 'utf8', env: eventsEnv(state) });
    assert.deepEqual(after.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).seq), [1, 2]);
    assert.match(after.stderr, /--after 9 is above the highest seq.*\(2\).*first line/);
    writeFileSync(join(state, 'events.cursor'), '9\n');
    const cursor = spawnSync(join(factory, 'bin/factory-events'), [], { encoding: 'utf8', env: eventsEnv(state) });
    assert.deepEqual(cursor.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).seq), [1, 2]);
    assert.match(cursor.stderr, /the cursor 9 is above the highest seq/);
  });
});

test('a remade events file does not mute --follow: a cursor above its highest seq starts it over, and the cursor follows', async () => {
  await withDir((dir) =>
    withFollowers(async (start) => {
      const state = join(dir, 'state');
      seed(state, [['start', 'out-of-quota a'], ['start', 'gh-refused']]);
      writeFileSync(join(state, 'events.cursor'), '9\n');
      const f = start(state);
      await f.until(2);
      await sleep(800);
      assert.deepEqual(f.lines().map((l) => l.seq), [1, 2]);
      assert.match(f.err(), /the cursor 9 is above the highest seq/);
      assert.equal(cursorOf(state), '2');
    }),
  );
});

test('a follower that is already running prints the lines of an events file made anew', async () => {
  await withDir((dir) =>
    withFollowers(async (start) => {
      const state = join(dir, 'state');
      seed(state, [['start', 'out-of-quota a'], ['start', 'gh-refused']]);
      const f = start(state);
      await f.until(2);
      seed(state, [['start', 'lead-at-dialog app-lead']]);
      await f.until(3);
      assert.deepEqual(f.lines().map((l) => l.key), ['out-of-quota a', 'gh-refused', 'lead-at-dialog app-lead']);
    }),
  );
});

test('--after takes a whole number of 0 or more; anything else is a usage error', () => {
  withDir((dir) => {
    const state = join(dir, 'state');
    seed(state, [['start', 'gh-refused']]);
    for (const args of [['--after'], ['--after', 'x'], ['--after', '-1'], ['--after', '1.5'], ['--after', ''], ['--after', '1e3'], ['--frob']]) {
      const r = spawnSync(join(factory, 'bin/factory-events'), args, { encoding: 'utf8', env: eventsEnv(state) });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /usage: factory-events \[--follow\] \[--after <seq>\]/);
      assert.equal(r.stdout, '');
    }
    const zero = spawnSync(join(factory, 'bin/factory-events'), ['--after', '0'], { encoding: 'utf8', env: eventsEnv(state) });
    assert.equal(zero.status, 0, zero.stderr);
    assert.equal(zero.stdout.split('\n').filter(Boolean).length, 1);
  });
});

test('the Leads are read with the reader that throws when ps fails, not the one that shows none', async () => {
  const e = await events();
  const top = await import('../bin/lib/top.mjs');
  assert.equal(e.defaultProcesses, top.readProcesses);
  assert.throws(() => top.readProcesses(['/nonexistent/ps']), /ps is not on this host/);
  assert.throws(() => top.readProcesses(['/usr/bin/false']));
});

test('a process list or accounts that cannot be read leave their conditions as they were; a reading that succeeded ends them', async () => {
  const e = await events();
  await withDir(async (dir) => {
    const state = join(dir, 'state');
    const runs = join(dir, 'runs');
    const profiles = join(dir, 'profiles');
    mkdirSync(runs);
    mkdirSync(profiles);
    const lead = { key: 'lead-at-dialog app-lead', scope: 'leads', text: 'Lead waits' };
    const quota = { key: 'out-of-quota a', scope: 'quota', text: 'account a is out' };
    record(e, state, [lead, quota], new Set(['leads', 'quota']), T0);
    assert.deepEqual(shape(state), ['start lead-at-dialog app-lead', 'start out-of-quota a']);
    const observe = (processes) => e.observe({ state, reads: new Map(), runs, agentProfiles: profiles, now: T0 + MIN, processes });
    observe(() => {
      throw new Error('ps failed');
    });
    assert.deepEqual(shape(state), ['start lead-at-dialog app-lead', 'start out-of-quota a'], 'no process list and no accounts: neither clears');
    writeFileSync(join(state, 'accounts'), 'factory/factory-lead=acct-one\n');
    observe(() => []);
    assert.deepEqual(shape(state).slice(2).sort(), ['clear lead-at-dialog app-lead', 'clear out-of-quota a']);
  });
});

test('bin/factory-events finds node itself under the PATH of a non-login ssh command', () => {
  if (!['/opt/homebrew/bin/node', '/usr/local/bin/node'].some((n) => existsSync(n))) return;
  withDir((dir) => {
    const state = join(dir, 'state');
    seed(state, [['start', 'gh-refused']]);
    const r = spawnSync('/bin/bash', [join(factory, 'bin/factory-events')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', FACTORY_STATE: state } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).key, 'gh-refused');
  });
});

test('factory top lists a condition-1 line with the repository, the pull request and the check, and drops it once the condition clears', async () => {
  const e = await events();
  const top = await import('../bin/lib/top.mjs');
  await withDir(async (dir) => {
    const state = join(dir, 'state');
    for (const d of ['runs', 'root', 'profiles']) mkdirSync(join(dir, d));
    const now = Date.parse('2026-11-02T11:00:00Z');
    const frame = async () => {
      const snap = await top.snapshot({ now, runs: join(dir, 'runs'), state, root: join(dir, 'root'), clones: new Map(), repos: [], live: () => false, processes: () => [], load: [0, 0, 0], cores: 1, agentProfiles: join(dir, 'profiles') });
      return top.render(snap, { width: 200 });
    };
    const seen = (prs, at) => record(e, state, e.checksNotStarted({ repo: 'o/app', prs, required: ['verify'] }), new Set(['o/app']), at);
    seen([pr()], now - 2 * e.NOT_STARTED_MS);
    seen([pr()], now - e.NOT_STARTED_MS);
    const shown = await frame();
    assert.match(shown, /Waiting on you\n.*o\/app#12.*verify.*https:\/\/github\.com\/o\/app\/pull\/12/);
    seen([pr({ checks: { verify: run('IN_PROGRESS') } })], now);
    assert.doesNotMatch(await frame(), /verify has not started/);
    assert.match(await frame(), /Nothing waits on you/);
  });
});
