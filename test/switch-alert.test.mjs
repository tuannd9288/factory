// #333: the sweep reports each move of a repository's merge switch (#309's events, `factory top`). A position file for each
// repository holds the last position and move; a move is a condition held for 24 hours. No network: a fake gh serves the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { observe, readActive, readLines } from '../bin/lib/events.mjs';
import { HOLD_MS, watchSwitch } from '../bin/lib/switch-watch.mjs';

const T0 = Date.parse('2026-11-02T13:00:00Z');
const HOUR = 60 * 60_000;

function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'switch-alert-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const positionFile = (state, repo) => join(state, `queue-${repo.replace('/', '-')}.position`);
const saved = (state, repo) => JSON.parse(readFileSync(positionFile(state, repo), 'utf8'));
const lines = (state) => readLines(state).map((e) => `${e.type} ${e.key}`);

/** One observe over the switches given, with nothing else to read. */
function watch(dir, state, switches, now) {
  mkdirSync(join(dir, 'runs'), { recursive: true });
  mkdirSync(join(dir, 'profiles'), { recursive: true });
  return observe({ state, reads: new Map(), switches, runs: join(dir, 'runs'), agentProfiles: join(dir, 'profiles'), now, processes: () => [] });
}

test('the first sight of a repository writes its position and reports nothing; the same position changes nothing', () =>
  withDir((dir) => {
    const state = join(dir, 'state');
    assert.equal(watchSwitch({ state, repo: 'o/app', position: '1-2', now: T0 }), null);
    assert.deepEqual(saved(state, 'o/app'), { position: '1-2', move: null });
    assert.equal(watchSwitch({ state, repo: 'o/app', position: '1-2', now: T0 + HOUR }), null);
    assert.deepEqual(saved(state, 'o/app'), { position: '1-2', move: null });
    watch(dir, state, new Map([['o/app', null]]), T0);
    assert.deepEqual(lines(state), []);
  }));

test('a file that cannot be parsed counts as no file: a first sight again', () =>
  withDir((dir) => {
    const state = join(dir, 'state');
    mkdirSync(state);
    for (const bad of ['{not json', '{"position":"sideways","move":null}', '']) {
      writeFileSync(positionFile(state, 'o/app'), bad);
      assert.equal(watchSwitch({ state, repo: 'o/app', position: 'all', now: T0 }), null, bad);
      assert.deepEqual(saved(state, 'o/app'), { position: 'all', move: null });
    }
  }));

test('a move takes the new position and the move with the sweep\'s time, and the next sweep keeps the move', () =>
  withDir((dir) => {
    const state = join(dir, 'state');
    watchSwitch({ state, repo: 'o/app', position: '1-2', now: T0 });
    const move = watchSwitch({ state, repo: 'o/app', position: 'all', now: T0 + HOUR });
    assert.deepEqual(move, { from: '1-2', to: 'all', at: new Date(T0 + HOUR).toISOString() });
    assert.deepEqual(saved(state, 'o/app'), { position: 'all', move });
    assert.deepEqual(watchSwitch({ state, repo: 'o/app', position: 'all', now: T0 + 2 * HOUR }), move);
  }));

test('a move starts one condition with its key, scope, top and both positions, and holds without more lines', () =>
  withDir((dir) => {
    const state = join(dir, 'state');
    const move = { from: '1-2', to: 'all', at: new Date(T0).toISOString() };
    watch(dir, state, new Map([['o/app', move]]), T0 + 60_000);
    watch(dir, state, new Map([['o/app', move]]), T0 + HOUR);
    assert.deepEqual(lines(state), [`start switch-moved o/app ${move.at}`]);
    const c = readActive(state).conditions[`switch-moved o/app ${move.at}`];
    assert.equal(c.kind, 'switch-moved');
    assert.equal(c.scope, 'switch o/app');
    assert.equal(c.top, true);
    assert.equal(c.url, 'https://github.com/o/app/rules');
    assert.match(c.text, /^o\/app merge switch moved from 1-2 to all, seen by the sweep at 2026-\d\d-\d\d \d\d:\d\d$/);
  }));

test('24 hours on it clears; a second move within the hours ends the first and starts its own', () =>
  withDir((dir) => {
    const state = join(dir, 'state');
    const first = { from: '1-2', to: 'all', at: new Date(T0).toISOString() };
    const second = { from: 'all', to: 'none', at: new Date(T0 + 2 * HOUR).toISOString() };
    watch(dir, state, new Map([['o/app', first]]), T0);
    watch(dir, state, new Map([['o/app', second]]), T0 + 2 * HOUR);
    assert.deepEqual(lines(state), [`start switch-moved o/app ${first.at}`, `clear switch-moved o/app ${first.at}`, `start switch-moved o/app ${second.at}`]);
    watch(dir, state, new Map([['o/app', second]]), T0 + 2 * HOUR + HOLD_MS - 1);
    assert.equal(lines(state).length, 3, 'held to the last millisecond');
    watch(dir, state, new Map([['o/app', second]]), T0 + 2 * HOUR + HOLD_MS);
    assert.equal(lines(state).at(-1), `clear switch-moved o/app ${second.at}`);
  }));

test('a repository whose switch was not read keeps its condition as it was', () =>
  withDir((dir) => {
    const state = join(dir, 'state');
    const move = { from: '1-2', to: 'none', at: new Date(T0).toISOString() };
    watch(dir, state, new Map([['o/app', move]]), T0);
    watch(dir, state, new Map(), T0 + 30 * HOUR);
    assert.deepEqual(lines(state), [`start switch-moved o/app ${move.at}`], 'not read: neither held nor cleared');
    watch(dir, state, new Map([['o/app', move]]), T0 + 30 * HOUR);
    assert.equal(lines(state).at(-1), `clear switch-moved o/app ${move.at}`);
  }));

test('factory top lists the move as an alert with the repository, both positions and the rules page, and drops it once it clears', async () =>
  withDir(async (dir) => {
    const top = await import('../bin/lib/top.mjs');
    const state = join(dir, 'state');
    for (const d of ['root']) mkdirSync(join(dir, d));
    const move = { from: '1-2', to: 'all', at: new Date(T0).toISOString() };
    const frame = async (now) => {
      const snap = await top.snapshot({ now, runs: join(dir, 'runs'), state, root: join(dir, 'root'), clones: new Map(), repos: [], live: () => false, processes: () => [], load: [0, 0, 0], cores: 1, agentProfiles: join(dir, 'profiles') });
      return top.render(snap, { width: 200 });
    };
    watch(dir, state, new Map([['o/app', move]]), T0);
    assert.match(await frame(T0 + 60_000), /Waiting on you\n(?:.*\n)*? {2}alert +o\/app merge switch moved from 1-2 to all, seen by the sweep at \S+ \S+ {2}https:\/\/github\.com\/o\/app\/rules/);
    watch(dir, state, new Map([['o/app', move]]), T0 + HOLD_MS);
    assert.doesNotMatch(await frame(T0 + HOLD_MS), /merge switch moved/);
  }));

// Through the real command: a fake gh serves the rules in force ($Q/rules.json) and no pull request, and logs every call.
function world(dir) {
  mkdirSync(join(dir, 'bin'));
  writeFileSync(
    join(dir, 'bin/gh'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$(printf \'%s\' "$*" | tr \'\\n\' \' \')" >>"$Q/calls"',
      'case "$*" in',
      '  "api user"*) echo agent-bot ;;',
      '  *rules/branches*) if [ -e "$Q/rulesfail" ]; then echo "HTTP 502" >&2; exit 1; fi; printf "["; cat "$Q/rules.json"; printf "]" ;;',
      '  *graphql*) echo \'{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\' ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'bin/gh'), 0o755);
  const state = join(dir, 'state');
  const home = join(dir, 'home');
  mkdirSync(home);
  mkdirSync(join(dir, 'root'));
  // The factory's own checkout: origin names github.com/o/factory in a folder that is no remote, so nothing leaves the host.
  const checkout = join(dir, 'checkout');
  mkdirSync(checkout);
  spawnSync('git', ['init', '-q', checkout]);
  spawnSync('git', ['-C', checkout, 'remote', 'add', 'origin', join(dir, 'github.com/o/factory')]);
  const rules = (position) =>
    writeFileSync(join(dir, 'rules.json'), JSON.stringify([{ type: 'pull_request', parameters: { required_approving_review_count: position === 'none' ? 1 : 0, require_code_owner_review: position !== 'all' } }]));
  const sweep = (extra = {}, repos = ['o/app']) => {
    writeFileSync(join(dir, 'calls'), '');
    const env = {
      ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, Q: dir, HOME: home, FACTORY_STATE: state, FACTORY_RUNS: join(dir, 'runs'),
      FACTORY_ROOT: join(dir, 'root'), FACTORY_CHECKOUT: '', FACTORY_PLIST_DIR: join(dir, 'no-plists'), AGENT_PROFILES: join(dir, 'profiles'), ...extra,
    };
    const out = spawnSync(join(factory, 'bin/factory-queue'), ['sweep', ...repos.flatMap((r) => ['--repo', r])], { encoding: 'utf8', env });
    const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean);
    return { code: out.status, out: out.stdout + out.stderr, calls, of: (repo) => calls.filter((c) => c.includes(`repos/${repo}/`) || c.includes(`name=${repo.split('/')[1]}`)) };
  };
  return { state, rules, sweep, checkout };
}

test('a sweep keeps the position of a swept repository and starts a condition on a move, with no call more than before', () =>
  withDir((dir) => {
    const w = world(dir);
    w.rules('1-2');
    let r = w.sweep();
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(saved(w.state, 'o/app'), { position: '1-2', move: null });
    assert.deepEqual(lines(w.state), [], 'the first sight reports nothing');
    // Before: one rules call and one query for the repository. After: the same.
    assert.deepEqual(r.of('o/app').filter((c) => c.includes('rules/branches')).length, 1);
    assert.equal(r.calls.filter((c) => c.includes('graphql')).length, 1);
    r = w.sweep();
    assert.deepEqual(lines(w.state), []);
    w.rules('all');
    r = w.sweep();
    assert.equal(r.code, 0, r.out);
    const [start] = readLines(w.state);
    assert.equal(start.type, 'start');
    assert.equal(start.kind, 'switch-moved');
    assert.match(start.key, /^switch-moved o\/app 2\d{3}-/);
    assert.match(start.text, /^o\/app merge switch moved from 1-2 to all, seen by the sweep at /);
    assert.equal(r.calls.filter((c) => c.includes('rules/branches')).length, 1, 'the position comes from the rules the sweep fetched already');
    assert.equal(r.calls.filter((c) => c.includes('graphql')).length, 1);
  }));

test('a failed read leaves the position file and the condition as they were', () =>
  withDir((dir) => {
    const w = world(dir);
    w.rules('1-2');
    w.sweep();
    w.rules('none');
    w.sweep();
    assert.equal(lines(w.state).length, 1);
    writeFileSync(join(dir, 'rulesfail'), '');
    w.rules('all');
    const r = w.sweep();
    assert.equal(r.code, 1, r.out);
    assert.equal(saved(w.state, 'o/app').position, 'none');
    assert.equal(lines(w.state).length, 1, 'neither started again nor cleared');
    rmSync(join(dir, 'rulesfail'));
    w.sweep();
    assert.equal(saved(w.state, 'o/app').position, 'all');
    assert.deepEqual(
      lines(w.state).map((l) => l.split(' ')[0]),
      ['start', 'clear', 'start'],
      'the second move ends the first condition and starts its own',
    );
  }));

test('the factory\'s own repository: its rules are read once a sweep and none of its pull requests; no checkout, no read', () =>
  withDir((dir) => {
    const w = world(dir);
    w.rules('1-2');
    const withOwn = { FACTORY_CHECKOUT: w.checkout };
    let r = w.sweep(withOwn);
    assert.equal(r.code, 0, r.out);
    const own =r.calls.filter((c) => c.includes('repos/o/factory/rules/branches/main'));
    assert.equal(own.length, 1);
    assert.match(own[0], /^api --paginate --slurp /);
    assert.ok(!r.calls.some((c) => c.includes('graphql') && c.includes('name=factory')), 'no pull request of its own is listed');
    assert.deepEqual(saved(w.state, 'o/factory'), { position: '1-2', move: null });
    w.rules('all');
    r = w.sweep(withOwn);
    assert.ok(readLines(w.state).some((e) => e.type === 'start' && e.key.startsWith('switch-moved o/factory ')));
    r = w.sweep(withOwn, ['o/app', 'o/factory']);
    assert.equal(r.calls.filter((c) => c.includes('repos/o/factory/rules/branches/main')).length, 1, 'a repository named twice is read once');
    rmSync(w.state, { recursive: true, force: true });
    r = w.sweep();
    assert.ok(!r.calls.some((c) => c.includes('o/factory')), 'no checkout, no read');
    assert.ok(!existsSync(positionFile(w.state, 'o/factory')));
  }));
