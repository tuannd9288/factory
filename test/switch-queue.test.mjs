// #333: the queue's sweep follows the merge switch by state. A finished `tier` check records the position it ran at (the
// annotation "merge switch" on its own check run), and each sweep re-runs, once, a `tier` whose record and the position in
// force differ in a way that changes its verdict: however many moves there were between two sweeps, and for a job that was
// still running at a move. A fake gh serves the rules and the open pull requests. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { pickUpdate, switchDue } from '../bin/lib/queue.mjs';

const rule = (count, owner) => ({ type: 'pull_request', parameters: { required_approving_review_count: count, require_code_owner_review: owner } });

/** A fake gh: the rules in force are $Q/rules.json, the open pull requests $Q/prs.json; every call is logged on one line. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'switch-'));
  writeFileSync(
    join(dir, 'gh'),
    // One line for each call: the GraphQL query has newlines of its own. A re-run of a job named in $Q/fail is refused.
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$(printf \'%s\' "$*" | tr \'\\n\' \' \')" >>"$Q/calls"',
      'case "$*" in',
      '  "api user"*) echo agent-bot ;;',
      // A call that does not ask for every page fails; with them the rules come as one page of a list of pages.
      '  *rules/branches*) case "$*" in *"--paginate --slurp"*) printf "["; cat "$Q/rules.json"; printf "]" ;; *) echo "fake gh: the rules are asked without --paginate --slurp" >&2; exit 1 ;; esac ;;',
      // The records of check runs, asked by node id apart from the pull requests (a few points, not a hundred times as many).
      '  *"nodes(ids"*) cat "$Q/records.json" ;;',
      '  *graphql*) cat "$Q/prs.json" ;;',
      '  "run rerun --job "*) case " $(cat "$Q/fail" 2>/dev/null) " in *" $4 "*) echo "HTTP 403: Workflow run cannot be rerun" >&2; exit 1 ;; esac ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const state = join(dir, 'state');
  const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  return {
    dir,
    state,
    rules: (position) => put('rules.json', position === 'all' ? [rule(0, false)] : position === 'none' ? [rule(1, true)] : [rule(0, true)]),
    rulesText: (text) => writeFileSync(join(dir, 'rules.json'), text),
    /** The jobs whose re-run GitHub refuses, space-separated; none with no argument. */
    refuse: (jobs = '') => writeFileSync(join(dir, 'fail'), jobs),
    // The annotations of the check runs go to the record query's answer, not into the pull requests' query, as in GitHub's.
    pulls: (list) => {
      const records = [];
      const bare = JSON.parse(JSON.stringify(list));
      for (const p of bare)
        for (const n of p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes) {
          records.push({ id: n.id, databaseId: n.databaseId, annotations: n.annotations });
          delete n.annotations;
        }
      put('prs.json', { data: { repository: { pullRequests: { nodes: bare } } } });
      put('records.json', { data: { nodes: records } });
    },
    /** One sweep, with the gh calls it made. */
    sweep: () => {
      writeFileSync(join(dir, 'calls'), '');
      const out = spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_STATE: state } });
      const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean);
      return { code: out.status, out: out.stdout + out.stderr, calls, reruns: calls.filter((c) => c.startsWith('run rerun')) };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** An open pull request as the queue's query returns it, with its latest `tier` job. `record` is the position that job
 * recorded on its check run (null: none); `notes` replaces its annotations; `running` leaves the job unfinished. */
const pull = (number, { labels = ['tier-3'], conclusion = 'FAILURE', running = false, record = null, notes = null, auto = true, draft = false, approvedBy = null, jobId = `${number}1`, head = `h${number}`, base = 'main', startedAt = '2026-11-02T01:00:00Z' } = {}) => ({
  number,
  isDraft: draft,
  createdAt: `2026-11-02T0${number % 10}:00:00Z`,
  mergeStateStatus: 'BLOCKED',
  baseRefName: base,
  autoMergeRequest: auto ? { enabledAt: '2026-11-02T00:00:00Z' } : null,
  author: { login: 'agent-bot' },
  headRefOid: head,
  labels: { nodes: labels.map((name) => ({ name })) },
  reviews: { nodes: approvedBy ? [{ author: { login: approvedBy }, commit: { oid: head }, submittedAt: '2026-11-02T02:00:00Z' }] : [] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  id: `CR_${jobId}`,
                  databaseId: Number(jobId),
                  name: 'tier',
                  status: running ? 'IN_PROGRESS' : 'COMPLETED',
                  conclusion: running ? null : conclusion,
                  startedAt,
                  detailsUrl: `https://github.com/o/app/actions/runs/1/job/${jobId}`,
                  annotations: { nodes: notes ?? (record ? [{ title: 'merge switch', message: record }] : []) },
                  checkSuite: { app: { slug: 'github-actions' } },
                },
              ],
            },
          },
        },
      },
    ],
  },
});

const job = (n) => `run rerun --job ${n} --repo o/app`;

test('switchDue: a finished tier check is due only when its record and the position in force change its verdict', () => {
  const p = (labels, state, recorded) => ({ labels, checks: { tier: { jobId: '1', state, recorded } } });
  const T3 = ['tier-3'];
  assert.equal(switchDue(p(T3, 'SUCCESS', 'all'), '1-2'), 'tighter');
  assert.equal(switchDue(p(T3, 'SUCCESS', 'all'), 'none'), 'tighter');
  assert.equal(switchDue(p(T3, 'SUCCESS', '1-2'), 'none'), null, '1-2 and none ask the approval alike');
  assert.equal(switchDue(p(T3, 'FAILURE', 'all'), '1-2'), null, 'red stays red when tighter');
  assert.equal(switchDue(p(T3, 'FAILURE', '1-2'), 'all'), 'looser');
  assert.equal(switchDue(p(T3, 'FAILURE', 'none'), 'all'), 'looser');
  assert.equal(switchDue(p(T3, 'FAILURE', 'none'), '1-2'), null);
  assert.equal(switchDue(p(T3, 'SUCCESS', 'none'), '1-2'), null);
  assert.equal(switchDue(p(T3, 'SUCCESS', '1-2'), 'all'), null, 'green stays green when looser');
  assert.equal(switchDue(p(T3, 'SUCCESS', '1-2'), '1-2'), null);
  assert.equal(switchDue(p(T3, 'PENDING', 'all'), '1-2'), null, 'a running check is left to finish');
  assert.equal(switchDue(p(T3, 'SUCCESS', undefined), '1-2'), 'bare');
  assert.equal(switchDue(p(T3, 'FAILURE', undefined), '1-2'), null, 'a red check with no record failed before it read the switch');
  for (const labels of [['tier-1'], ['tier-2'], []]) {
    for (const [state, position] of [['SUCCESS', 'none'], ['SUCCESS', 'all'], ['FAILURE', '1-2']])
      assert.equal(switchDue(p(labels, state, undefined), position), null, `${labels} ${state} -> ${position}: only tier 3 follows the switch`);
  }
  assert.equal(switchDue(p([], 'SUCCESS', 'all'), '1-2'), 'tighter', 'a check with a record is tier 3 whatever its labels say');
  assert.equal(switchDue(p(['tier-1'], 'FAILURE', '1-2'), 'all'), 'looser');
  assert.equal(switchDue({ labels: T3, checks: { tier: { jobId: '1', state: 'SUCCESS', recorded: 'all', unread: true } } }, '1-2'), null, 'a record not read is no record');
  assert.equal(switchDue(p(T3, 'SUCCESS', 'all'), undefined), null, 'no position read, nothing');
  assert.equal(switchDue({ labels: T3, checks: {} }, '1-2'), null);
});

test('a tier job still running at a move is judged when it ends: green with all recorded while 1-2 is in force is re-run', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { running: true })]);
    assert.deepEqual(w.sweep().reruns, [], 'left to finish');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: 'all' })]);
    const out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, [job(71)]);
    assert.match(out.out, /re-ran the tier check of o\/app#7 because it ran at the merge switch's position all and 1-2 is in force/);
  } finally {
    w.cleanup();
  }
});

test('two moves between sweeps are seen through the record: both sweeps read 1-2, and a green tier recorded at all is re-run', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: '1-2' })]);
    assert.deepEqual(w.sweep().reruns, []);
    assert.deepEqual(w.sweep().reruns, []);
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: 'all', jobId: '72' })]);
    assert.deepEqual(w.sweep().reruns, [job(72)]);
  } finally {
    w.cleanup();
  }
});

test('a red tier-3 tier recorded at 1-2 while all is in force is re-run; a green one is not', () => {
  const w = world();
  try {
    w.rules('all');
    w.pulls([pull(7, { conclusion: 'FAILURE', record: '1-2' }), pull(8, { conclusion: 'SUCCESS', record: '1-2' }), pull(9, { conclusion: 'SUCCESS', record: 'all' })]);
    assert.deepEqual(w.sweep().reruns, [job(71)]);
  } finally {
    w.cleanup();
  }
});

test('no loop: equal record and position re-run nothing, a re-run is not repeated while it shows, and its record clears the condition', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: '1-2' })]);
    const quiet = w.sweep();
    assert.deepEqual(quiet.reruns, []);
    assert.equal(quiet.calls.length, 4, `the first sweep reads the record once: ${quiet.calls.join(' | ')}`);
    assert.equal(w.sweep().calls.length, 3, 'a known record is not read again');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: 'all', jobId: '72' })]);
    assert.deepEqual(w.sweep().reruns, [job(72)]);
    assert.deepEqual(w.sweep().reruns, [], 'the same check run is re-run at most once');
    assert.deepEqual(w.sweep().reruns, []);
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: '1-2', jobId: '73' })]);
    assert.deepEqual(w.sweep().reruns, [], 'the new run records the position in force');
  } finally {
    w.cleanup();
  }
});

test('a tier-1 or 2 check, which records nothing, never follows the switch, at any position', () => {
  const w = world();
  try {
    for (const position of ['none', '1-2', 'all']) {
      w.rules(position);
      w.pulls([pull(5, { labels: ['tier-1'], conclusion: 'SUCCESS', jobId: `5${position.length}` }), pull(8, { labels: ['tier-2'], conclusion: 'FAILURE', jobId: `8${position.length}` })]);
      for (let k = 0; k < 2; k += 1) {
        const out = w.sweep();
        assert.deepEqual(out.reruns, [], position);
        assert.doesNotMatch(out.out, /does not record/);
      }
    }
  } finally {
    w.cleanup();
  }
});

test('a move between 1-2 and none re-runs nothing: tier asks the approval at both', () => {
  const w = world();
  try {
    w.rules('none');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: '1-2' }), pull(8, { conclusion: 'FAILURE', record: '1-2', jobId: '82' })]);
    assert.deepEqual(w.sweep().reruns, []);
    w.rules('1-2');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: 'none', jobId: '73' }), pull(8, { conclusion: 'FAILURE', record: 'none', jobId: '83' })]);
    assert.deepEqual(w.sweep().reruns, []);
  } finally {
    w.cleanup();
  }
});

test('a check with a record is tier 3 whatever its labels say, and is followed', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { labels: [], conclusion: 'SUCCESS', record: 'all' })]);
    assert.deepEqual(w.sweep().reruns, [job(71)]);
  } finally {
    w.cleanup();
  }
});

test('only the pull requests on the branch the rules were read for are judged, at any position', () => {
  const w = world();
  try {
    for (const position of ['all', '1-2', 'none']) {
      w.rules(position);
      w.pulls([pull(7, { base: 'dev', conclusion: position === 'all' ? 'FAILURE' : 'SUCCESS', record: position === 'all' ? '1-2' : 'all', jobId: `7${position.length}` })]);
      for (let k = 0; k < 2; k += 1) {
        const out = w.sweep();
        assert.deepEqual(out.reruns, [], position);
        assert.ok(!out.calls.some((c) => c.includes('nodes(ids')), 'its record was not even read');
      }
    }
  } finally {
    w.cleanup();
  }
});

test('the pull requests\' query asks no annotations; the record query is made only for finished check runs not known yet', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: '1-2' }), pull(8, { running: true })]);
    let out = w.sweep();
    const main = out.calls.filter((c) => c.includes('pullRequests'));
    assert.equal(main.length, 1);
    assert.doesNotMatch(main[0], /annotations/);
    assert.match(main[0], /baseRefName/);
    let records = out.calls.filter((c) => c.includes('nodes(ids'));
    assert.equal(records.length, 1, out.calls.join('\n'));
    assert.match(records[0], /CR_71/);
    assert.doesNotMatch(records[0], /CR_81/, 'a running check has no record to read yet');
    assert.match(records[0], /annotations\(first:10\)\{nodes\{title message\}\}/);
    assert.equal(w.sweep().calls.filter((c) => c.includes('nodes(ids')).length, 0, 'every record is known');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: '1-2' }), pull(8, { conclusion: 'SUCCESS', record: '1-2' }), pull(9, { conclusion: 'SUCCESS', record: '1-2' })]);
    out = w.sweep();
    records = out.calls.filter((c) => c.includes('nodes(ids'));
    assert.equal(records.length, 1);
    assert.ok(/CR_81/.test(records[0]) && /CR_91/.test(records[0]) && !/CR_71/.test(records[0]), 'only the runs not known');
  } finally {
    w.cleanup();
  }
});

test('the record is the last "merge switch" annotation that is a position, and a re-run that kept its id but started again is judged', () => {
  const w = world();
  try {
    w.rules('1-2');
    const lone = [{ title: 'merge switch', message: 'banana' }, { title: 'merge switch', message: 'all' }, { title: 'merge switch', message: 'not a position' }];
    w.pulls([pull(7, { conclusion: 'SUCCESS', notes: lone })]);
    assert.deepEqual(w.sweep().reruns, [job(71)], 'a non-position first or last does not hide the real one');
    assert.deepEqual(w.sweep().reruns, []);
    w.pulls([pull(7, { conclusion: 'SUCCESS', notes: lone, startedAt: '2026-11-02T05:00:00Z' })]);
    assert.deepEqual(w.sweep().reruns, [job(71)], 'the same id, started again, is another run');
  } finally {
    w.cleanup();
  }
});

test('a pull request not armed, and a draft, are judged too', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { auto: false, conclusion: 'SUCCESS', record: 'all' }), pull(8, { draft: true, conclusion: 'SUCCESS', record: 'all' })]);
    assert.deepEqual(w.sweep().reruns, [job(71), job(81)]);
  } finally {
    w.cleanup();
  }
});

test('a tier-3 check that records no position is not re-run: one line for each head says so, never every sweep', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { conclusion: 'SUCCESS' })]);
    const lines = [];
    let total = 0;
    for (let k = 0; k < 3; k += 1) {
      const out = w.sweep();
      assert.equal(out.code, 0, out.out);
      total += out.reruns.length;
      lines.push(...out.out.split('\n').filter((l) => /does not record its position yet/.test(l)));
    }
    assert.equal(total, 0, 'a re-run would keep the old gate');
    assert.equal(lines.length, 1, lines.join('\n'));
    w.pulls([pull(7, { conclusion: 'SUCCESS', head: 'pushed', jobId: '72' })]);
    const out = w.sweep();
    assert.deepEqual(out.reruns, []);
    assert.equal(out.out.split('\n').filter((l) => /does not record its position yet/.test(l)).length, 1, 'a new head is said once more');
    assert.equal(w.sweep().out.split('\n').filter((l) => /does not record/.test(l)).length, 0);
  } finally {
    w.cleanup();
  }
});

test('a re-run GitHub refuses stays due: tried on each sweep, its line printed once, made when GitHub takes it', () => {
  const w = world();
  try {
    w.rules('1-2');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: 'all' })]);
    w.refuse('71');
    const told = [];
    for (let k = 0; k < 3; k += 1) {
      const out = w.sweep();
      assert.equal(out.code, 0, out.out);
      assert.deepEqual(out.reruns, [job(71)], 'tried each time');
      told.push(...out.out.split('\n').filter((l) => /could not re-run/.test(l)));
    }
    assert.equal(told.length, 1, told.join('\n'));
    assert.match(told[0], /could not re-run the tier check of o\/app#7 .*HTTP 403/);
    w.refuse();
    const out = w.sweep();
    assert.deepEqual(out.reruns, [job(71)]);
    assert.match(out.out, /re-ran the tier check of o\/app#7/);
    assert.deepEqual(w.sweep().reruns, [], 'made, so no longer due');
  } finally {
    w.cleanup();
  }
});

test('another notice on the same check run does not confuse the match, and a title or a message that is not the record counts for nothing', () => {
  const w = world();
  try {
    w.rules('1-2');
    const noise = [{ title: '', message: 'Process completed with exit code 1.' }, { title: 'review-result', message: 'none' }];
    w.pulls([
      pull(7, { conclusion: 'SUCCESS', notes: [...noise, { title: 'merge switch', message: 'all' }] }),
      pull(8, { conclusion: 'SUCCESS', notes: [...noise, { title: 'merge switch', message: '1-2' }] }),
    ]);
    assert.deepEqual(w.sweep().reruns, [job(71)], 'only the one that recorded all');
    w.pulls([pull(9, { conclusion: 'SUCCESS', notes: [{ title: 'other', message: 'all' }] }), pull(10, { conclusion: 'SUCCESS', notes: [{ title: 'merge switch', message: 'banana' }] })]);
    const out = w.sweep();
    assert.deepEqual(out.reruns, [], 'neither is a record: each is told as unrecorded, not re-run');
    assert.equal(out.out.split('\n').filter((l) => /does not record its position yet/.test(l)).length, 2);
  } finally {
    w.cleanup();
  }
});

test('rules the sweep cannot read as a position re-run nothing and say so', () => {
  const w = world();
  try {
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: 'all' })]);
    w.rulesText(JSON.stringify([{ type: 'pull_request', parameters: {} }]));
    const out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, []);
    assert.match(out.out, /merge switch of o\/app could not be read/);
  } finally {
    w.cleanup();
  }
});

test('a state file left by the earlier, move-based form does not break a sweep', () => {
  const w = world();
  try {
    mkdirSync(w.state, { recursive: true });
    writeFileSync(join(w.state, 'queue-o-app.switch'), JSON.stringify({ position: 'all', reran: [{ number: 7, head: 'h7', position: 'all' }], pending: [{ number: 7, head: 'h7', position: 'all' }] }));
    w.rules('1-2');
    w.pulls([pull(7, { conclusion: 'SUCCESS', record: 'all' })]);
    const out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, [job(71)]);
    writeFileSync(join(w.state, 'queue-o-app.switch'), 'not json');
    assert.equal(w.sweep().code, 0);
  } finally {
    w.cleanup();
  }
});

test('an approval\'s re-run that GitHub refuses is told in one line, and the sweep goes on', () => {
  const w = world();
  try {
    w.pulls([pull(7, { approvedBy: 'boss', record: '1-2' }), pull(8, { approvedBy: 'boss', jobId: '82', record: '1-2' })]);
    w.rules('1-2');
    w.refuse('71');
    const out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, [job(71), job(82)]);
    assert.match(out.out, /could not re-run the tier check of o\/app#7 after its approval or Entire's check/);
    assert.match(out.out, /re-ran the tier check of o\/app#8 after its approval/);
  } finally {
    w.cleanup();
  }
});

/** A pull request behind its base, waiting on auto-merge, as pickUpdate reads it. */
const behind = (number, approvals = [], labels = []) => ({ number, isDraft: false, autoMerge: true, mergeStateStatus: 'BEHIND', createdAt: `2026-11-02T0${number}:00:00Z`, author: 'agent-bot', labels, checks: {}, apps: {}, approvals });

test('at none the queue updates no pull request that lacks an approval of someone other than its author', () => {
  const approved = [{ login: 'boss', oid: 'h', at: '2026-11-02T02:00:00Z' }];
  const own = [{ login: 'agent-bot', oid: 'h', at: '2026-11-02T02:00:00Z' }];
  assert.equal(pickUpdate([behind(1)], [], 'none'), null);
  assert.equal(pickUpdate([behind(1, own)], [], 'none'), null, 'its author\'s own approval is none');
  assert.equal(pickUpdate([behind(1), behind(2, approved)], [], 'none')?.number, 2);
  for (const position of ['1-2', 'all', undefined]) assert.equal(pickUpdate([behind(1)], [], position)?.number, 1, String(position));
});
