// #370: the sweep's wake of a Lead on its news (bin/lib/news-wake.mjs): the events it writes and the lines it posts, from fixtures of what the
// queue's one query reads, with a fake post and a socket file in a temporary folder. The wording of a line is not tested (#112).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observe, readLines, NOT_STARTED_MS } from '../bin/lib/events.mjs';
import { SEAT_GRACE_MS, detect, teamOfBody, wakeOnNews, wakeOnSeats, wakeStarted } from '../bin/lib/news-wake.mjs';
import { QUERY } from '../bin/lib/queue.mjs';
import { newsLine } from '../bin/lib/wake.mjs';

const REPO = 'o/app';
const REQUIRED = ['verify', 'tier'];
const ok = (state = 'SUCCESS') => ({ state, status: state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED', startedAt: 't', completedAt: 't' });
const pr = (number, over = {}) => ({ number, head: `${String(number).repeat(8)}`, body: `Issue: #${number}\nTeam: pstack\n`, mergeable: 'MERGEABLE', isDraft: false, labels: [], autoMerge: false, mergeStateStatus: 'CLEAN', checks: { verify: ok('PENDING'), tier: ok('PENDING') }, apps: {}, ...over });
const claim = (n, team) => ({ name: String(n), target: { messageHeadline: `claim ${n} ${team}` } });

/** A world: a state folder, a runs folder where the Lead app-pstack has a socket file, and a post that keeps what it was given. */
function world(body, { socket = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const [state, runs] = [join(dir, 'state'), join(dir, 'runs')];
  mkdirSync(state);
  if (socket) {
    mkdirSync(join(runs, 'app-pstack'), { recursive: true });
    writeFileSync(join(runs, 'app-pstack', 'socket'), `${join(dir, 's.sock')}\n`);
  }
  const posts = [];
  const post = (file, line) => {
    posts.push({ file, content: JSON.parse(line).message.content });
    return { posted: true };
  };
  try {
    return body({ dir, state, runs, posts, post });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sweep = (w, prs, { now, ...over } = {}) => wakeOnNews({ repo: REPO, folder: 'app', state: w.state, runs: w.runs, post: w.post, now, data: { prs, merged: [], required: REQUIRED, claims: [], ...over } });
const start = (w) => readLines(w.state).filter((e) => e.type === 'start');

test('each kind writes one line and posts one wake, and a second sweep with the same state writes and posts nothing', () => {
  world((w) => {
    sweep(w, [pr(1), pr(2), pr(3)]);
    assert.deepEqual([start(w).length, w.posts.length], [0, 0]);
    const prs = [pr(1, { checks: { verify: ok('FAILURE'), tier: ok('PENDING') } }), pr(2, { checks: { verify: ok(), tier: ok() } }), pr(3, { mergeable: 'CONFLICTING' })];
    const merged = [{ number: 9, head: 'abc', body: 'Issue: #9\nTeam: pstack\n' }];
    assert.equal(sweep(w, prs, { merged }).length, 4);
    assert.deepEqual(start(w).map((e) => e.kind).sort(), ['checks-green', 'checks-red', 'conflict', 'merged']);
    assert.equal(w.posts.length, 4);
    assert.ok(w.posts.every((p) => p.file === join(w.runs, 'app-pstack', 'socket')));
    assert.ok(start(w).every((e) => /woken/.test(e.text) && !/not woken/.test(e.text)));
    const again = sweep(w, prs, { merged });
    assert.deepEqual([again.length, start(w).length, w.posts.length], [0, 4, 4]);
  });
});

test('the first sweep of a repository records what is there and wakes nothing', () => {
  world((w) => {
    const prs = [pr(1, { checks: { verify: ok('FAILURE'), tier: ok() } }), pr(2, { mergeable: 'CONFLICTING' })];
    assert.deepEqual(sweep(w, prs, { merged: [{ number: 9, body: '' }] }), []);
    assert.deepEqual([start(w).length, w.posts.length], [0, 0]);
    assert.ok(existsSync(join(w.state, 'queue-o-app.news')));
    assert.deepEqual(sweep(w, prs, { merged: [{ number: 9, body: '' }] }), []);
  });
});

test('UNKNOWN is no conflict, and CONFLICTING is, once the head is the same', () => {
  const found = (mergeable) => detect({ repo: REPO, prs: [pr(1, { mergeable })], required: REQUIRED }).filter((e) => e.kind === 'conflict');
  assert.equal(found('UNKNOWN').length, 0);
  assert.equal(found('MERGEABLE').length, 0);
  assert.equal(found('CONFLICTING').length, 1);
});

test('a required check that fails wakes at once, though another is still running; `tier` red does not while the pull request waits on the Human', () => {
  const kinds = (checks, labels = []) => detect({ repo: REPO, prs: [pr(1, { checks, labels })], required: REQUIRED }).map((e) => e.kind);
  assert.deepEqual(kinds({ verify: ok('FAILURE'), tier: ok('PENDING') }), ['checks-red']);
  assert.deepEqual(kinds({ verify: ok(), tier: ok('FAILURE') }, ['tier-3']), []);
  assert.deepEqual(kinds({ verify: ok(), tier: ok('FAILURE') }, ['needs-human']), []);
  assert.deepEqual(kinds({ verify: ok(), tier: ok() }), ['checks-green']);
  assert.deepEqual(kinds({ verify: ok() }), []);
});

test('a red `tier` of a pull request that waits on no one is red: a Lead has a claim or a Team: line to fix', () => {
  assert.deepEqual(detect({ repo: REPO, prs: [pr(1, { checks: { verify: ok(), tier: ok('FAILURE') } })], required: REQUIRED }).map((e) => e.kind), ['checks-red']);
  world((w) => {
    sweep(w, [pr(1)]);
    sweep(w, [pr(1, { checks: { verify: ok(), tier: ok('FAILURE') } })]);
    assert.deepEqual(start(w).map((e) => e.kind), ['checks-red']);
  });
});

test('a conflict wakes once per head, though GitHub reads UNKNOWN in between', () => {
  world((w) => {
    sweep(w, [pr(1)]);
    sweep(w, [pr(1, { mergeable: 'CONFLICTING' })]);
    sweep(w, [pr(1, { mergeable: 'UNKNOWN' })]);
    sweep(w, [pr(1, { mergeable: 'CONFLICTING' })]);
    assert.equal(w.posts.length, 1);
    assert.equal(start(w).length, 1);
    // Another head is another conflict.
    sweep(w, [pr(1, { mergeable: 'CONFLICTING', head: 'f'.repeat(8) })]);
    assert.equal(w.posts.length, 2);
  });
});

test('a red check wakes again when it fails in another run of the same head, even if no sweep saw it not red; a second check failing is no news', () => {
  const red = (id, extra = {}) => pr(1, { checks: { verify: { ...ok('FAILURE'), id, startedAt: `t${id}` }, tier: ok('PENDING'), ...extra } });
  world((w) => {
    sweep(w, [pr(1)]);
    sweep(w, [red(1)]);
    assert.equal(w.posts.length, 1);
    sweep(w, [red(1)]);
    assert.equal(w.posts.length, 1, 'a queued re-run leaves the old failed run in the rollup: the same run');
    sweep(w, [red(2)]);
    assert.equal(w.posts.length, 2, 'the re-run failed in a new run');
    sweep(w, [red(2)]);
    assert.equal(w.posts.length, 2);
  });
  world((w) => {
    const two = (id) => pr(1, { checks: { verify: { ...ok('FAILURE'), id: 1, startedAt: 't1' }, extra: { ...ok('FAILURE'), id, startedAt: `t${id}` } } });
    sweep(w, [pr(1)], { required: ['verify', 'extra'] });
    sweep(w, [pr(1, { checks: { verify: { ...ok('FAILURE'), id: 1, startedAt: 't1' }, extra: ok('PENDING') } })], { required: ['verify', 'extra'] });
    assert.equal(w.posts.length, 1);
    sweep(w, [two(5)], { required: ['verify', 'extra'] });
    assert.equal(w.posts.length, 1, 'the second check failing is not the first one failing again');
  });
});

test('a merged pull request that leaves the list and comes back wakes once; the key is kept for 14 days', () => {
  world((w) => {
    const m = (at) => ({ number: 9, head: 'abc', body: 'Issue: #9\nTeam: pstack\n', mergedAt: at });
    const other = (n, at) => ({ number: n, head: 'x', body: '', mergedAt: at });
    const day = 24 * 60 * 60_000;
    const t0 = Date.parse('2026-11-03T00:00:00Z');
    const at = (d) => new Date(t0 + d * day).toISOString();
    const go = (merged, d) => sweep(w, [], { merged, now: t0 + d * day });
    go([], 0);
    go([m(at(1))], 1);
    assert.equal(w.posts.length, 1);
    go([other(10, at(2)), other(11, at(2))], 2);
    go([m(at(1)), other(10, at(2))], 3);
    assert.equal(w.posts.length, 1, 'back in the list, it is not news (the others name no Lead, so they post nothing)');
    go([other(10, at(2))], 20);
    go([m(at(1))], 21);
    assert.equal(w.posts.length, 2, 'after 14 days the key is gone and the pull request wakes again');
  });
});

test('a Team: line counts only when it is a team name', () => {
  assert.equal(teamOfBody('Team: ../../x\n', new Map()), null);
  assert.equal(teamOfBody('Team: Pstack\n', new Map()), null);
  assert.equal(teamOfBody('Team: pstack\n', new Map()), 'pstack');
});

test('a team with no socket file is not woken: the line says so and nothing is posted', () => {
  world(
    (w) => {
      sweep(w, [pr(1)]);
      sweep(w, [pr(1, { mergeable: 'CONFLICTING' })]);
      assert.equal(w.posts.length, 0);
      assert.equal(start(w).length, 1);
      assert.match(start(w)[0].text, /not woken \(no socket file on this machine\)/);
    },
    { socket: false },
  );
});

test("the claim's team wins over the Team: line, and with neither the line says no Lead was found", () => {
  assert.equal(teamOfBody('Issue: #4\nTeam: other\n', new Map([[4, 'pstack']])), 'pstack');
  assert.equal(teamOfBody('Issue: #4\nTeam: other\n', new Map()), 'other');
  assert.equal(teamOfBody('Issue: none\n', new Map()), null);
  world((w) => {
    sweep(w, [pr(1)]);
    sweep(w, [pr(1, { mergeable: 'CONFLICTING', body: 'Issue: #1\nTeam: other\n' })], { claims: [claim(1, 'pstack')] });
    assert.deepEqual(w.posts.map((p) => p.file), [join(w.runs, 'app-pstack', 'socket')]);
  });
  world((w) => {
    sweep(w, [pr(1)]);
    sweep(w, [pr(1, { mergeable: 'CONFLICTING', body: 'Issue: none\n' })]);
    assert.equal(w.posts.length, 0);
    assert.match(start(w)[0].text, /no Lead found/);
  });
});

test('a post that fails is said in the line and not tried again', () => {
  world((w) => {
    let calls = 0;
    const post = () => {
      calls += 1;
      return { posted: false, why: 'refused' };
    };
    const run = (prs) => wakeOnNews({ repo: REPO, folder: 'app', state: w.state, runs: w.runs, post, data: { prs, merged: [], required: REQUIRED, claims: [] } });
    run([pr(1)]);
    run([pr(1, { mergeable: 'CONFLICTING' })]);
    run([pr(1, { mergeable: 'CONFLICTING' })]);
    assert.equal(calls, 1);
    assert.equal(start(w).length, 1);
    assert.match(start(w)[0].text, /not woken \(refused\)/);
  });
});

test('each line names its Lead and the delivery as data: woke, and the reason code when it did not; none for no Lead', () => {
  const run = (w, post, body) => {
    const call = (mergeable) => wakeOnNews({ repo: REPO, folder: 'app', state: w.state, runs: w.runs, post, data: { prs: [pr(1, { mergeable, body })], merged: [], required: REQUIRED, claims: [] } });
    call('MERGEABLE');
    call('CONFLICTING');
    return start(w)[0];
  };
  world((w) => {
    const e = run(w, w.post, 'Issue: #1\nTeam: pstack\n');
    assert.deepEqual([e.lead, e.woke, 'why' in e], ['app-pstack', true, false]);
    assert.equal(e.where, 'https://github.com/o/app/pull/1');
  });
  world((w) => {
    const e = run(w, () => ({ posted: false, why: 'timed out' }), 'Issue: #1\nTeam: pstack\n');
    assert.deepEqual([e.lead, e.woke, e.why], ['app-pstack', false, 'timed out']);
  });
  world((w) => {
    const e = run(w, w.post, 'Issue: none\n');
    assert.deepEqual([e.lead, e.woke, 'why' in e], [null, false, false]);
  });
  world(
    (w) => {
      const e = run(w, w.post, 'Issue: #1\nTeam: pstack\n');
      assert.deepEqual([e.lead, e.woke, e.why], ['app-pstack', false, 'no file']);
    },
    { socket: false },
  );
});

test("check-not-started's start wakes the pull request's Lead, once", () => {
  world((w) => {
    const prs = [pr(5, { autoMerge: true, checks: {} })];
    const reads = new Map([[REPO, { required: ['verify'], prs, issues: [], claims: [claim(5, 'pstack')], folder: 'app' }]]);
    const args = { state: w.state, reads, runs: w.runs, agentProfiles: join(w.dir, 'profiles'), processes: () => [], onStart: (condition) => wakeStarted({ condition, reads, runs: w.runs, post: w.post }) };
    observe({ ...args, now: 1_000_000 });
    assert.equal(w.posts.length, 0);
    observe({ ...args, now: 1_000_000 + NOT_STARTED_MS + 1 });
    assert.equal(w.posts.length, 1);
    assert.match(w.posts[0].content, /check-not-started/);
    assert.equal(start(w).filter((e) => e.kind === 'check-not-started').length, 1);
    observe({ ...args, now: 1_000_000 + NOT_STARTED_MS + 60_000 });
    assert.equal(w.posts.length, 1);
  });
});

test('a pull request with two unstarted checks wakes its Lead once in a sweep', () => {
  world((w) => {
    const prs = [pr(5, { autoMerge: true, checks: {} })];
    const reads = new Map([[REPO, { required: REQUIRED, prs, issues: [], claims: [claim(5, 'pstack')], folder: 'app' }]]);
    const args = () => {
      const seen = new Set();
      return { state: w.state, reads, runs: w.runs, agentProfiles: join(w.dir, 'profiles'), processes: () => [], onStart: (condition) => wakeStarted({ condition, reads, runs: w.runs, post: w.post, seen }) };
    };
    observe({ ...args(), now: 1_000_000 });
    observe({ ...args(), now: 1_000_000 + NOT_STARTED_MS + 1 });
    assert.equal(start(w).filter((e) => e.kind === 'check-not-started').length, 2);
    assert.equal(w.posts.length, 1);
  });
});

const record = (w, over) => appendFileSync(join(w.state, 'sessions.jsonl'), `${JSON.stringify({ role: 'worker', tag: 'worker', team: 'app-pstack', run: join(w.runs, 'app-5'), structured: { done: true }, end: new Date().toISOString(), ...over })}\n`);
const seats = (w, over = {}) => wakeOnSeats({ state: w.state, runs: w.runs, post: w.post, live: () => false, ...over });

test('a record that ended wakes its team once, with a structured result or without; the first sweep wakes nothing', () => {
  world((w) => {
    record(w, { tag: 'old' });
    assert.deepEqual(seats(w), []);
    record(w, { tag: 'worker' });
    record(w, { tag: 'reviewer', role: 'reviewer', structured: null });
    assert.equal(seats(w).length, 2);
    assert.deepEqual(start(w).map((e) => e.kind), ['seat-ended', 'seat-no-result']);
    assert.equal(w.posts.length, 2);
    assert.deepEqual(seats(w), []);
    assert.equal(w.posts.length, 2);
  });
});

test('a run whose process is gone with no record counts after the grace, once; a record for it cancels it', () => {
  world((w) => {
    mkdirSync(join(w.runs, 'app-5'));
    seats(w);
    writeFileSync(join(w.runs, 'app-5', 'run-lost.pid'), '999999\n');
    writeFileSync(join(w.runs, 'app-5', 'run-done.pid'), '999998\n');
    const t0 = Date.now();
    const heldBy = new Map([['app', new Map([[5, 'pstack']])]]);
    assert.deepEqual(seats(w, { now: t0, heldBy }), []);
    record(w, { tag: 'done' });
    // Only the record's own seat-ended: the run it ended is not also lost, and the other one is still inside the grace.
    assert.equal(seats(w, { now: t0 + SEAT_GRACE_MS - 1000, heldBy }).length, 1);
    assert.deepEqual(start(w).map((e) => e.kind), ['seat-ended']);
    assert.equal(seats(w, { now: t0 + SEAT_GRACE_MS + 1000, heldBy }).length, 1);
    assert.match(start(w).at(-1).key, /^seat-no-result .*\/app-5 lost$/);
    assert.equal(w.posts.length, 2);
    assert.deepEqual(seats(w, { now: t0 + 2 * SEAT_GRACE_MS, heldBy }), []);
    assert.equal(w.posts.length, 2);
  });
});

test('a live run is no news', () => {
  world((w) => {
    mkdirSync(join(w.runs, 'app-5'));
    seats(w);
    writeFileSync(join(w.runs, 'app-5', 'run-w.pid'), '1\n');
    assert.deepEqual(seats(w, { live: () => true, now: Date.now() + 10 * SEAT_GRACE_MS }), []);
  });
});

test('the news line names its kind and where to read, differs on every post, and the query asks for the new fields', () => {
  const a = JSON.parse(newsLine('merged', 'o/app#1 merged', 'https://x/pull/1', 5)).message.content;
  const b = JSON.parse(newsLine('merged', 'o/app#1 merged', 'https://x/pull/1', 5)).message.content;
  assert.notEqual(a, b);
  assert.ok(a.includes('merged') && a.includes('https://x/pull/1'));
  assert.ok(/mergeable/.test(QUERY) && /states:MERGED/.test(QUERY));
});
