// #333: the merge switch of a repository, the two review parameters of the rules in force on its main. The pure reading
// (kit/.gate/bin/lib/switch.mjs, which the gate, the queue and bin/onboard-owner share), its CLI, and the queue's
// sweep following a move. The gate's tier branch is in test/kit.test.mjs, bin/onboard-owner's in test/owner.test.mjs and
// the doctor's in test/doctor.test.mjs. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { PARAMETERS, pagesOf, positionOf } from '../kit/.gate/bin/lib/switch.mjs';
import { pickUpdate } from '../bin/lib/queue.mjs';

const rule = (count, owner) => ({ type: 'pull_request', parameters: { required_approving_review_count: count, require_code_owner_review: owner } });

test('each position is read from the two review parameters, the count first', () => {
  assert.equal(positionOf([rule(0, false)]), 'all');
  assert.equal(positionOf([rule(0, true)]), '1-2');
  assert.equal(positionOf([rule(1, false)]), 'none');
  assert.equal(positionOf([rule(1, true)]), 'none');
  assert.equal(positionOf([rule(2, false)]), 'none');
});

test('no pull_request rule in force reads as 1-2, the position of a switch nobody set', () => {
  assert.equal(positionOf([]), '1-2');
  assert.equal(positionOf([{ type: 'deletion' }, { type: 'non_fast_forward' }]), '1-2');
});

test('the bootstrap ruleset and the factory\'s own read as none; the kit\'s gate reads as 1-2', () => {
  const read = (path) => JSON.parse(readFileSync(join(factory, path), 'utf8')).rules;
  assert.equal(positionOf(read('bin/rulesets/bootstrap.json')), 'none');
  assert.equal(positionOf(read('.github/ruleset.json')), 'none');
  assert.equal(positionOf(read('kit/.gate/ruleset.json')), '1-2');
});

test('two pull_request rules apply together: the largest count, and any code-owner requirement', () => {
  assert.equal(positionOf([rule(0, false), rule(0, true)]), '1-2');
  assert.equal(positionOf([rule(0, false), rule(1, false)]), 'none');
  assert.equal(positionOf([rule(0, true), rule(0, false), { type: 'deletion' }]), '1-2');
  assert.equal(positionOf([rule(0, false), rule(0, false)]), 'all');
});

test('rules that cannot be read are an error, never a position', () => {
  for (const bad of [null, {}, 'x', [{ type: 'pull_request' }], [{ type: 'pull_request', parameters: {} }], [rule(0, 'yes')], [rule('0', false)], [rule(-1, false)], [rule(0, false), { type: 'pull_request', parameters: { require_code_owner_review: false } }]])
    assert.throws(() => positionOf(bad), Error, JSON.stringify(bad));
});

test('an error names the value it met, not only the field', () => {
  assert.throws(() => positionOf([rule('1', false)]), /required_approving_review_count "1"/);
  assert.throws(() => positionOf([rule(0, 'yes')]), /require_code_owner_review "yes"/);
  assert.throws(() => positionOf([{ type: 'pull_request', parameters: {} }]), /required_approving_review_count unset/);
  assert.throws(() => positionOf({ message: 'Not Found' }), /not a list: \{"message":"Not Found"\}/);
});

test('the pages of a paginated read are one list of rules', () => {
  assert.equal(positionOf(pagesOf([[rule(0, false)], [rule(1, true)]])), 'none');
  assert.equal(positionOf(pagesOf([[]])), '1-2');
  assert.equal(positionOf(pagesOf([rule(0, false)])), 'all');
  assert.equal(pagesOf('x'), 'x');
});

test('the parameters --merge sets read back as the position they were chosen for', () => {
  assert.deepEqual(Object.keys(PARAMETERS).sort(), ['1-2', 'all', 'none']);
  for (const [position, parameters] of Object.entries(PARAMETERS)) assert.equal(positionOf([{ type: 'pull_request', parameters }]), position);
});

test('the CLI reads the rules\' JSON on stdin and prints the position, or why it could not, exit 2', () => {
  const cli = (input) => spawnSync('node', [join(factory, 'kit/.gate/bin/lib/switch.mjs')], { input, encoding: 'utf8' });
  for (const [rules, position] of [[[rule(0, false)], 'all'], [[rule(0, true)], '1-2'], [[rule(1, true)], 'none'], [[], '1-2']]) {
    const out = cli(JSON.stringify(rules));
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `${position}\n`);
  }
  const pages = cli(JSON.stringify([[rule(0, false)], [rule(0, true)]]));
  assert.equal(pages.status, 0, pages.stderr);
  assert.equal(pages.stdout, '1-2\n', 'the pages gh api --paginate --slurp gives');
  for (const bad of ['', 'not json', '{}', JSON.stringify([{ type: 'pull_request', parameters: {} }])]) {
    const out = cli(bad);
    assert.equal(out.status, 2, bad);
    assert.ok((out.stdout + out.stderr).trim().length > 0, 'it says why');
    assert.doesNotMatch(out.stdout.trim(), /^(all|1-2|none)$/);
  }
});

// The queue's sweep follows a move (his 10:21 words: a move applies to the pull requests already open).
/** A fake gh: the rules in force are $Q/rules.json, the open pull requests $Q/prs.json; every call is logged. */
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
      '  *rules/branches*) cat "$Q/rules.json" ;;',
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
  const world = {
    dir,
    rules: (position) => put('rules.json', position === 'all' ? [rule(0, false)] : position === 'none' ? [rule(1, true)] : [rule(0, true)]),
    rulesText: (text) => writeFileSync(join(dir, 'rules.json'), text),
    /** The jobs whose re-run GitHub refuses, space-separated; none with no argument. */
    refuse: (jobs = '') => writeFileSync(join(dir, 'fail'), jobs),
    pulls: (list) => put('prs.json', { data: { repository: { pullRequests: { nodes: list } } } }),
    /** One sweep; the gh calls it made, apart from the three every sweep makes. */
    sweep: () => {
      writeFileSync(join(dir, 'calls'), '');
      const out = spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_STATE: state } });
      const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean);
      return { code: out.status, out: out.stdout + out.stderr, calls, reruns: calls.filter((c) => c.startsWith('run rerun')) };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return world;
}

/** An open pull request as the queue's query returns it, with its latest `tier` job. */
const pull = (number, { labels = ['tier-3'], conclusion = 'FAILURE', auto = true, draft = false, approvedBy = null, jobId = `${number}1`, head = `h${number}` } = {}) => ({
  number,
  isDraft: draft,
  createdAt: `2026-11-02T0${number % 10}:00:00Z`,
  mergeStateStatus: 'BLOCKED',
  autoMergeRequest: auto ? { enabledAt: '2026-11-02T00:00:00Z' } : null,
  author: { login: 'agent-bot' },
  headRefOid: head,
  labels: { nodes: labels.map((name) => ({ name })) },
  reviews: { nodes: approvedBy ? [{ author: { login: approvedBy }, commit: { oid: head }, submittedAt: '2026-11-02T02:00:00Z' }] : [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: 'tier', status: 'COMPLETED', conclusion, startedAt: '2026-11-02T01:00:00Z', detailsUrl: `https://github.com/o/app/actions/runs/1/job/${jobId}`, checkSuite: { app: { slug: 'github-actions' } } }] } } } }] },
});

const waiting = () => [
  pull(7, { conclusion: 'FAILURE' }),
  pull(8, { conclusion: 'SUCCESS' }),
  pull(9, { labels: ['tier-1'], conclusion: 'SUCCESS' }),
];

test('a move to all re-runs the tier job of each waiting tier-3 pull request once; a move back does again; no sweep after repeats', () => {
  const w = world();
  try {
    w.pulls(waiting());
    w.rules('1-2');
    let out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, [], 'the first sweep of a repository at 1-2 moves nothing');
    assert.equal(out.calls.length, 3, `the sweep's calls: ${out.calls.join(' | ')}`);
    w.rules('all');
    out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, ['run rerun --job 71 --repo o/app', 'run rerun --job 81 --repo o/app'], 'the red and the green one, not the tier-1 one');
    assert.equal(out.calls.length, 5);
    assert.match(out.out, /merge switch of o\/app moved from 1-2 to all/);
    out = w.sweep();
    assert.deepEqual(out.reruns, [], 'the same position, the same pull requests');
    assert.equal(out.calls.length, 3, 'no more calls than a sweep with no move');
    w.rules('1-2');
    out = w.sweep();
    assert.deepEqual(out.reruns, ['run rerun --job 71 --repo o/app', 'run rerun --job 81 --repo o/app'], 'the green one turns red again, since its approval was skipped');
    out = w.sweep();
    assert.deepEqual(out.reruns, []);
    w.rules('none');
    out = w.sweep();
    assert.equal(out.reruns.length, 2, 'a move to none too');
    assert.equal(w.sweep().reruns.length, 0);
  } finally {
    w.cleanup();
  }
});

test('a repository the queue first sees at all has its waiting tier-3 pull requests re-run once, as a move from the default', () => {
  const w = world();
  try {
    w.pulls(waiting());
    w.rules('all');
    assert.equal(w.sweep().reruns.length, 2);
    assert.equal(w.sweep().reruns.length, 0);
  } finally {
    w.cleanup();
  }
});

test('a pull request that appears after a move is not re-run for it: its tier ran at the new position', () => {
  const w = world();
  try {
    w.pulls(waiting());
    w.rules('1-2');
    w.sweep();
    w.rules('all');
    assert.equal(w.sweep().reruns.length, 2);
    w.pulls([...waiting(), pull(11, { conclusion: 'FAILURE' })]);
    assert.deepEqual(w.sweep().reruns, [], 'a pull request opened at all ran its tier at all');
  } finally {
    w.cleanup();
  }
});

test('a move away from all re-runs the tier job of a tier-3 pull request not armed yet, and of a draft one', () => {
  const w = world();
  try {
    w.pulls([pull(7), pull(10, { auto: false, conclusion: 'SUCCESS' }), pull(12, { draft: true, conclusion: 'SUCCESS' }), pull(13, { labels: ['tier-2'], auto: false, conclusion: 'SUCCESS' })]);
    w.rules('all');
    w.sweep();
    w.rules('1-2');
    const out = w.sweep();
    assert.deepEqual(out.reruns, ['run rerun --job 71 --repo o/app', 'run rerun --job 101 --repo o/app', 'run rerun --job 121 --repo o/app'], 'every open tier-3 one, armed or not, a draft or not');
    assert.deepEqual(w.sweep().reruns, []);
  } finally {
    w.cleanup();
  }
});

test('a re-run GitHub refuses is told in one line and stops no sweep; the switch\'s is tried again next time, only for what is left', () => {
  const w = world();
  try {
    w.pulls(waiting());
    w.rules('1-2');
    w.sweep();
    w.rules('all');
    w.refuse('71');
    let out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, ['run rerun --job 71 --repo o/app', 'run rerun --job 81 --repo o/app']);
    assert.match(out.out, /could not re-run the tier check of o\/app#7 after the merge switch moved to all: HTTP 403/);
    assert.match(out.out, /re-ran the tier check of o\/app#8 after the merge switch moved to all/);
    out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, ['run rerun --job 71 --repo o/app'], 'the one that failed, and not the one that worked');
    w.refuse();
    out = w.sweep();
    assert.deepEqual(out.reruns, ['run rerun --job 71 --repo o/app']);
    assert.match(out.out, /re-ran the tier check of o\/app#7 after the merge switch moved to all/);
    assert.deepEqual(w.sweep().reruns, []);
  } finally {
    w.cleanup();
  }
});

test('an approval\'s re-run that GitHub refuses is told in one line, and the sweep goes on', () => {
  const w = world();
  try {
    w.pulls([pull(7, { approvedBy: 'boss' }), pull(8, { approvedBy: 'boss', jobId: '82' })]);
    w.rules('1-2');
    w.refuse('71');
    const out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, ['run rerun --job 71 --repo o/app', 'run rerun --job 82 --repo o/app']);
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

test('rules the sweep cannot read as a position re-run nothing, say so, and leave the position it kept', () => {
  const w = world();
  try {
    w.pulls(waiting());
    w.rules('1-2');
    w.sweep();
    w.rulesText(JSON.stringify([{ type: 'pull_request', parameters: {} }]));
    let out = w.sweep();
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(out.reruns, []);
    assert.match(out.out, /merge switch of o\/app could not be read/);
    w.rules('all');
    out = w.sweep();
    assert.equal(out.reruns.length, 2, 'the move is still seen once the rules can be read');
    assert.match(out.out, /moved from 1-2 to all/);
  } finally {
    w.cleanup();
  }
});
