// #370 slice 2: a repository with a team row that is not taken in, the factory's own among them, is read by the queue's sweep for the news
// wake alone. A fake gh serves the rules and the one query; the sweep runs as a process, twice (the first records what is there). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { readLines } from '../bin/lib/events.mjs';
import { leadOnly } from '../bin/lib/queue.mjs';
import { wakeOnNews } from '../bin/lib/news-wake.mjs';

const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'verify' }, { context: 'tier' }] } }];
const STARTED = '2026-11-03T00:00:00Z';
const run = (name, conclusion, job = '') => ({ id: `CR_${name}`, databaseId: 1, name, status: 'COMPLETED', conclusion, startedAt: STARTED, completedAt: STARTED, detailsUrl: job ? `https://github.com/o/factory/actions/runs/1/job/${job}` : '', checkSuite: { app: { slug: 'github-actions' } } });
/** An open pull request as the one query returns it, `Team: lead`, that a full sweep would act on twice: `verify` green, behind its base with
 * auto-merge armed (so its branch would be updated), and a finished red `tier` with a job, approved by someone else on its head after the
 * tier check started (so the tier job would be re-run). */
const pull = (number, over = {}) => ({
  number, isDraft: false, body: `Issue: none\nTeam: lead\n`, mergeable: 'MERGEABLE', createdAt: '2026-11-03T00:00:00Z', mergeStateStatus: 'BEHIND', baseRefName: 'main',
  autoMergeRequest: { enabledAt: 't' }, author: { login: 'agent-bot' }, headRefOid: `h${number}`, labels: { nodes: [] },
  reviews: { nodes: [{ author: { login: 'someone' }, commit: { oid: `h${number}` }, submittedAt: '2026-11-03T01:00:00Z' }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [run('verify', 'SUCCESS'), run('tier', 'FAILURE', '99')] } } } }] }, ...over,
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lead-only-'));
  const [root, state, runs] = [join(dir, 'root'), join(dir, 'state'), join(dir, 'runs')];
  for (const d of [root, state, runs]) mkdirSync(d);
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/o/factory.git');
  writeFileSync(join(state, 'accounts'), 'factory/factory-lead=acct\n');
  writeFileSync(join(dir, 'gh'), ['#!/bin/sh', 'printf \'%s\\n\' "$(printf \'%s\' "$*" | tr \'\\n\' \' \')" >>"$Q/calls"', 'case "$*" in', '  "api user"*) echo agent-bot ;;', '  *rules/branches*) printf "["; cat "$Q/rules.json"; printf "]" ;;', '  *graphql*) cat "$Q/prs.json" ;;', '  "run rerun "*) exit 0 ;;', '  *) exit 1 ;;', 'esac', ''].join('\n'));
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules));
  const put = (nodes) => writeFileSync(join(dir, 'prs.json'), JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }));
  return {
    dir, root, state, put,
    sweep: (args = ['sweep', '--once']) => {
      writeFileSync(join(dir, 'calls'), '');
      const out = spawnSync(join(factory, 'bin/factory-queue'), args, { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_STATE: state, FACTORY_RUNS: runs, FACTORY_ROOT: root, FACTORY_CHECKOUT: '' } });
      return { out: out.stdout + out.stderr, calls: readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('the repositories with a team row that are not taken in are named, the factory by its own clone', () => {
  const w = world();
  try {
    const origin = (dir) => (dir === w.root ? 'o/factory' : 'o/other');
    assert.deepEqual(leadOnly({ state: w.state, root: w.root, taken: new Set(), origin }), [{ repo: 'o/factory', folder: 'factory' }]);
    assert.deepEqual(leadOnly({ state: w.state, root: w.root, taken: new Set(['factory']), origin }), []);
    assert.deepEqual(leadOnly({ state: w.state, root: w.root, taken: new Set(), swept: ['o/factory'], origin }), []);
    assert.deepEqual(leadOnly({ state: w.state, root: w.root, taken: new Set(), origin: () => { throw new Error('no origin'); } }), []);
  } finally {
    w.cleanup();
  }
});

test('such a repository gets news wakes and nothing else from the sweep', () => {
  const w = world();
  try {
    w.put([pull(7, { mergeable: 'MERGEABLE' })]);
    const first = w.sweep();
    assert.equal(readLines(w.state).filter((e) => e.type === 'start').length, 0, first.out);
    w.put([pull(7, { mergeable: 'CONFLICTING' })]);
    const second = w.sweep();
    const news = readLines(w.state).filter((e) => e.kind === 'conflict');
    assert.equal(news.length, 1, second.out);
    assert.equal(news[0].lead, 'factory-lead');
    assert.equal(news[0].woke, false);
    // The one query and the rules were asked; the branch was not updated, no tier check re-run, and no condition was written.
    assert.ok(second.calls.some((c) => c.includes('graphql')));
    assert.ok(!second.calls.some((c) => c.startsWith('pr update-branch') || c.startsWith('run rerun')));
    assert.deepEqual(readLines(w.state).filter((e) => !['conflict', 'checks-red'].includes(e.kind)), []);
  } finally {
    w.cleanup();
  }
});

test('the fixture is one a full sweep acts on: it updates the branch and re-runs the tier job', () => {
  const w = world();
  try {
    w.put([pull(7)]);
    const { calls } = w.sweep(['sweep', '--repo', 'o/factory']);
    assert.ok(calls.some((c) => c.startsWith('pr update-branch 7')));
    assert.ok(calls.some((c) => c.startsWith('run rerun --job 99')));
  } finally {
    w.cleanup();
  }
});

test("a pull request of the factory's repository with `Team: lead` names the Lead factory-lead", () => {
  const w = world();
  try {
    const posts = [];
    mkdirSync(join(w.dir, 'runs', 'factory-lead'), { recursive: true });
    writeFileSync(join(w.dir, 'runs', 'factory-lead', 'socket'), `${join(w.dir, 's.sock')}\n`);
    const data = (mergeable) => ({ prs: [{ number: 3, head: 'abc1234', body: 'Issue: none\nTeam: lead\n', mergeable, labels: [], checks: {}, apps: {} }], merged: [], required: ['verify'], claims: [] });
    const args = (mergeable) => ({ repo: 'o/factory', folder: 'factory', state: w.state, runs: join(w.dir, 'runs'), data: data(mergeable), post: (file) => (posts.push(file), { posted: true }) });
    wakeOnNews(args('MERGEABLE'));
    wakeOnNews(args('CONFLICTING'));
    assert.deepEqual(posts, [join(w.dir, 'runs', 'factory-lead', 'socket')]);
    const [line] = readLines(w.state);
    assert.deepEqual([line.lead, line.woke, 'why' in line], ['factory-lead', true, false]);
  } finally {
    w.cleanup();
  }
});

test('the factory queue re-runs only its failed approval job after a fresh head approval (#456)', () => {
  const w = world();
  try {
    const candidate = (number, conclusion = 'FAILURE', over = {}) => pull(number, {
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [run('verify', 'SUCCESS'), run('approval', conclusion, String(100 + number)), run('tier', 'FAILURE', '99')] } } } }] },
      ...over,
    });
    w.put([
      candidate(7),
      candidate(8, 'SUCCESS'),
      candidate(9, 'FAILURE', { reviews: { nodes: [] } }),
      candidate(10, 'FAILURE', { reviews: { nodes: [{ author: { login: 'someone' }, commit: { oid: 'h10' }, submittedAt: STARTED }] } }),
      candidate(11, 'FAILURE', { reviews: { nodes: [{ author: { login: 'someone' }, commit: { oid: 'old' }, submittedAt: '2026-11-03T01:00:00Z' }] } }),
    ]);
    const first = w.sweep();
    assert.deepEqual(first.calls.filter((c) => c.startsWith('run rerun')), ['run rerun --job 107 --repo o/factory']);
    assert.ok(!first.calls.some((c) => c.startsWith('pr update-branch')));
    w.put([candidate(7, 'SUCCESS')]);
    assert.deepEqual(w.sweep().calls.filter((c) => c.startsWith('run rerun')), []);
  } finally {
    w.cleanup();
  }
});
