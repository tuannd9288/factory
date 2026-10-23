// probes/score.mjs: scores probe pull requests from the gate's own runs, stops at the first unavailable reviewer, and
// reports the billed minutes per job. Against a fake gh; no GitHub, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');
// gh: pr view N, run list --commit SHA, run view ID --json jobs | --log, all answered from $D/<what>.json or .log.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const d = process.env.D;
fs.appendFileSync(d + '/calls', a.join(' ') + '\n');
if (a[0] === 'api') { console.error('gh api is not allowed'); process.exit(9); }
const show = (f) => { process.stdout.write(fs.readFileSync(d + '/' + f, 'utf8')); process.exit(0); };
if (a[0] === 'pr' && a[1] === 'view') show('pr' + a[2] + '.json');
if (a[0] === 'run' && a[1] === 'list') show('list-' + a[a.indexOf('--commit') + 1] + '.json');
if (a[0] === 'run' && a[1] === 'view' && a.includes('--log')) show('log' + a[2] + '.log');
if (a[0] === 'run' && a[1] === 'view') show('jobs' + a[2] + '.json');
process.exit(1);
`;

function world(prs) {
  const dir = mkdtempSync(join(tmpdir(), 'score-'));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  for (const p of prs) {
    writeFileSync(join(dir, `pr${p.n}.json`), JSON.stringify({ state: p.state ?? 'OPEN', headRefOid: p.sha, statusCheckRollup: p.checks }));
    writeFileSync(join(dir, `list-${p.sha}.json`), JSON.stringify([{ databaseId: p.run }]));
    writeFileSync(join(dir, `jobs${p.run}.json`), JSON.stringify({ jobs: p.jobs }));
    writeFileSync(join(dir, `log${p.run}.log`), p.log);
  }
  const score = (args) => spawnSync(process.execPath, [join(factory, 'probes/score.mjs'), '--repo', 'o/scratch', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, D: dir } });
  return { dir, score, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const job = (name, start, end, conclusion = 'success') => ({ databaseId: 1, name, startedAt: start, completedAt: end, conclusion });
const checks = (...failed) => ['verify', 'review', 'verdict', 'tier'].map((name) => ({ name, conclusion: failed.includes(name) ? 'FAILURE' : 'SUCCESS' }));
const OK = 'reviewer: no quota or rate-limit event in the stream\nreview (claude-opus-5-5): passes\n';

test('a probe is caught when it did not merge and a required check failed; billed minutes round each job up', () => {
  const w = world([
    { n: 11, sha: 'a'.repeat(40), run: 100, checks: checks('review'), log: OK, jobs: [job('review', '2026-10-25T10:00:00Z', '2026-10-25T10:03:01Z', 'failure'), job('tier', '2026-10-25T10:00:00Z', '2026-10-25T10:00:20Z')] },
    { n: 12, sha: 'b'.repeat(40), state: 'MERGED', run: 101, checks: checks(), log: 'review\tRun the reviewer\t2026-10-25T11:04:00.1234567Z reviewer: quota event: {"status":"allowed"}\n', jobs: [job('review', '2026-10-25T11:00:00Z', '2026-10-25T11:05:00Z')] },
  ]);
  try {
    const out = w.score(['11', '12']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^pr\t11\tcaught$/m);
    assert.match(out.stdout, /^job\t11\treview\tfailure\t4$/m);
    assert.match(out.stdout, /^job\t11\ttier\tsuccess\t1$/m);
    assert.match(out.stdout, /^pr\t12\tmissed$/m);
    assert.match(out.stdout, /^job\t12\treview\tsuccess\t5$/m);
    assert.match(out.stdout, /^quota\t11\treviewer: no quota or rate-limit event in the stream$/m);
    assert.match(out.stdout, /^quota\t12\treviewer: quota event: \{"status":"allowed"\}$/m);
    assert.match(out.stdout, /^minutes\t11\t5\tgate-trusted\.yml jobs only, not gate\.yml's verify$/m);
    assert.doesNotMatch(readCalls(w), /^api /m);
  } finally {
    w.cleanup();
  }
});

test('it stops at the first unavailable reviewer, scores that head as nothing, and reads no later pull request', () => {
  const w = world([
    { n: 11, sha: 'a'.repeat(40), run: 100, checks: checks(), log: OK, jobs: [job('review', '2026-10-25T10:00:00Z', '2026-10-25T10:01:00Z')] },
    { n: 12, sha: 'b'.repeat(40), run: 101, checks: checks('review'), log: '::notice title=review-result::unavailable: quota\nreview: reviewer unavailable (quota); this is not a finding on the change\n', jobs: [job('review', '2026-10-25T11:00:00Z', '2026-10-25T11:01:00Z', 'failure')] },
    { n: 13, sha: 'c'.repeat(40), run: 102, checks: checks(), log: OK, jobs: [] },
  ]);
  try {
    const out = w.score(['11', '12', '13']);
    assert.equal(out.status, 3, out.stdout + out.stderr);
    assert.match(out.stdout, /^pr\t11\tmissed$/m);
    assert.match(out.stdout, /^STOP\t12\treviewer unavailable \(quota\); this head is not scored$/m);
    assert.doesNotMatch(out.stdout, /^pr\t12\t/m);
    assert.doesNotMatch(readCalls(w), /pr view 13/);
  } finally {
    w.cleanup();
  }
});

test('it can score the first four heads alone: only the pull requests named are read', () => {
  const w = world(['11', '12', '13', '14', '15'].map((n, i) => ({ n, sha: String(i).repeat(40), run: 200 + i, checks: checks('verify'), log: OK, jobs: [job('review', '2026-10-25T10:00:00Z', '2026-10-25T10:01:00Z')] })));
  try {
    const out = w.score(['11', '12', '13', '14']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal([...out.stdout.matchAll(/^pr\t/gm)].length, 4);
    assert.doesNotMatch(readCalls(w), /pr view 15/);
  } finally {
    w.cleanup();
  }
});

test('a model claim that quotes the unavailable wording is not the reviewer saying so', () => {
  const claim = 'review\tRun the reviewer\t2026-10-25T10:03:00.1234567Z review (claude-opus-5-5): f1: the log says "reviewer unavailable (quota)" but it was there\n';
  const w = world([{ n: 11, sha: 'a'.repeat(40), run: 100, checks: checks('review'), log: `${claim}${OK}`, jobs: [job('review', '2026-10-25T10:00:00Z', '2026-10-25T10:01:00Z', 'failure')] }]);
  try {
    const out = w.score(['11']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^pr\t11\tcaught$/m);
  } finally {
    w.cleanup();
  }
});

test('a skipped job bills nothing, a job with no times is not guessed, and the quota line has no timestamp', () => {
  const w = world([
    {
      n: 11,
      sha: 'a'.repeat(40),
      run: 100,
      checks: checks(),
      log: 'review\tRun the reviewer\t2026-10-25T10:03:00.1234567Z reviewer: quota event: {"status":"allowed"}\n',
      jobs: [job('review', '2026-10-25T10:00:00Z', '2026-10-25T10:02:00Z'), job('rounds', '2026-10-25T10:02:00Z', '2026-10-25T10:02:01Z', 'skipped'), { name: 'verdict', conclusion: 'success' }],
    },
  ]);
  try {
    const out = w.score(['11']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^job\t11\trounds\tskipped\t0$/m);
    assert.match(out.stdout, /^job\t11\tverdict\tsuccess\t\?$/m);
    assert.match(out.stdout, /^minutes\t11\t2\t/m);
    assert.match(out.stdout, /^quota\t11\treviewer: quota event: \{"status":"allowed"\}$/m);
  } finally {
    w.cleanup();
  }
});

test('the head it stops at still gets its quota line, before STOP; a run still in progress is pending, not a crash', () => {
  const w = world([
    {
      n: 12,
      sha: 'b'.repeat(40),
      run: 101,
      checks: checks('review'),
      log: 'review\tRun the reviewer\t2026-10-25T11:00:00.1Z review: reviewer unavailable (quota); this is not a finding on the change\nreview\tRun the reviewer\t2026-10-25T11:00:01.1Z reviewer: quota event: {"status":"rejected"}\n',
      jobs: [job('review', '2026-10-25T11:00:00Z', '2026-10-25T11:01:00Z', 'failure')],
    },
  ]);
  try {
    const out = w.score(['12']);
    assert.equal(out.status, 3, out.stdout + out.stderr);
    assert.match(out.stdout, /^quota\t12\treviewer: quota event: \{"status":"rejected"\}\nSTOP\t12\t/m);
    rmSync(join(w.dir, 'log101.log'));
    const again = w.score(['12']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /^pr\t12\tpending$/m);
  } finally {
    w.cleanup();
  }
});

function readCalls(w) {
  return readFileSync(join(w.dir, 'calls'), 'utf8');
}
