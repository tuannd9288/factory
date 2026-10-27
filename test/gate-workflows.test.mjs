// #133: what GitHub and bash read in the kit's workflows and in .gate/bin/verify-timeout: the fork guard of `review`, the
// timeout that comes from .gate/config.sh, and the runner a candidate's code gets. Nothing here reads the wording of a rule.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const yaml = (file) => JSON.parse(spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', join(factory, 'kit/.github/workflows', file)], { encoding: 'utf8' }).stdout);
const gate = yaml('gate.yml');
const trusted = yaml('gate-trusted.yml');
const TIMEOUT = join(factory, 'kit/.gate/bin/verify-timeout');

describe('the fork guard of review (item 12)', () => {
  const steps = trusted.jobs.review.steps;
  const guard = steps[0];

  test('review is not skipped by a condition: a skipped required job passes', () => {
    assert.equal(trusted.jobs.review.if, undefined);
    assert.equal(guard.if, undefined);
  });

  test('the first step compares the repository ids of the head and the base, before the checkout, the install and any secret', () => {
    assert.equal(guard.uses, undefined);
    assert.equal(typeof guard.run, 'string');
    assert.deepEqual(Object.keys(guard.env).sort(), ['BASE_REPO', 'HEAD_REPO']);
    assert.equal(guard.env.HEAD_REPO, '${{ github.event.pull_request.head.repo.id }}');
    assert.equal(guard.env.BASE_REPO, '${{ github.event.pull_request.base.repo.id }}');
    assert.doesNotMatch(JSON.stringify(guard), /secrets\./);
    const withSecret = steps.findIndex((s) => /secrets\./.test(JSON.stringify(s)));
    assert.ok(withSecret > 0, 'the credential is read by a later step');
    assert.equal(steps.filter((s) => /secrets\./.test(JSON.stringify(s))).length, 1, 'one step holds the credential');
    assert.ok(steps.findIndex((s) => String(s.uses).startsWith('actions/checkout')) > 0);
    assert.ok(steps.findIndex((s) => /npm ci/.test(String(s.run))) > 0);
  });

  const guarded = (env) => spawnSync('bash', ['-c', guard.run], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

  test('the step passes for one repository and fails for another, an empty head (a deleted fork) or no ids at all', () => {
    assert.equal(guarded({ HEAD_REPO: '42', BASE_REPO: '42' }).status, 0);
    assert.equal(guarded({ HEAD_REPO: '99', BASE_REPO: '42' }).status, 1);
    assert.equal(guarded({ HEAD_REPO: '', BASE_REPO: '42' }).status, 1);
    assert.equal(guarded({ HEAD_REPO: '', BASE_REPO: '' }).status, 1);
    assert.equal(guarded({ BASE_REPO: '42' }).status, 1);
  });

  test('a refusal is a review result of class fork, which `rounds` does not count as a red head', () => {
    const out = guarded({ HEAD_REPO: '99', BASE_REPO: '42' }).stdout;
    assert.match(out, /^::notice title=review-result::unavailable: fork$/m);
  });
});

describe('the runner of the candidate\'s code (item 10)', () => {
  test('gate.yml reads GATE_PR_RUNNER, and with it unset the runner is GitHub-hosted', () => {
    const runsOn = gate.jobs.verify['runs-on'];
    const m = /^\$\{\{ fromJSON\(vars\.GATE_PR_RUNNER \|\| '(.+)'\) \}\}$/.exec(runsOn);
    assert.ok(m, runsOn);
    assert.equal(JSON.parse(m[1]), 'ubuntu-latest');
    assert.doesNotMatch(JSON.stringify(gate), /self-hosted/);
  });
});

describe('.gate/bin/verify-timeout (item 9)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-timeout-'));
  const kit = (config) => {
    rmSync(join(dir, '.gate'), { recursive: true, force: true });
    mkdirSync(join(dir, '.gate/bin'), { recursive: true });
    cpSync(TIMEOUT, join(dir, '.gate/bin/verify-timeout'));
    chmodSync(join(dir, '.gate/bin/verify-timeout'), 0o755);
    writeFileSync(join(dir, '.gate/config.sh'), config);
    return (...args) => run(dir, join(dir, '.gate/bin/verify-timeout'), args);
  };

  test('prints the minutes .gate/config.sh gives, 30 when it gives none, and the seconds with --seconds', () => {
    assert.equal(kit('GATE_CHECKS=""\n')().out.trim(), '30');
    assert.equal(kit('GATE_VERIFY_TIMEOUT=45\n')().out.trim(), '45');
    assert.equal(kit('GATE_VERIFY_TIMEOUT=45\n')('--seconds').out.trim(), '2700');
    assert.equal(kit('GATE_VERIFY_TIMEOUT=60\n')().out.trim(), '60');
    assert.equal(kit('')('--max').out.trim(), '60');
  });

  test('a value that is not a whole number of minutes from 1 to 60 is exit 2 and prints no number', () => {
    for (const bad of ['0', '61', '-5', 'abc', '4.5', '"1 2"', '09']) {
      const r = kit(`GATE_VERIFY_TIMEOUT=${bad}\n`)();
      assert.equal(r.code, 2, `${bad}: ${r.out}`);
      assert.doesNotMatch(r.out, /^\d+$/m, bad);
    }
    assert.equal(kit('GATE_VERIFY_TIMEOUT=abc\n')('--seconds').code, 2);
  });

  test('a config that cannot be read is exit 2', () => {
    const r = kit('this is not shell (\n')();
    assert.equal(r.code, 2, r.out);
  });
});

describe('the ceilings that follow the timeout (item 9)', () => {
  const max = Number(run(factory, TIMEOUT, ['--max']).out.trim());
  const jobs = { ...gate.jobs, ...trusted.jobs };

  test('the verify step takes its timeout from the config through a step output, under a job ceiling that holds the largest value and setup', () => {
    assert.equal(max, 60);
    const steps = gate.jobs.verify.steps;
    const cfg = steps.findIndex((s) => s.id === 'cfg');
    const verify = steps.findIndex((s) => /verify-trusted/.test(String(s.run)));
    assert.ok(cfg >= 0 && verify > cfg, 'cfg runs before the step that runs verify-trusted');
    assert.match(String(steps[cfg].run), /verify-timeout/);
    assert.equal(steps[cfg]['working-directory'], 'trusted');
    assert.equal(steps[verify]['timeout-minutes'], '${{ fromJSON(steps.cfg.outputs.minutes) }}');
    assert.ok(gate.jobs.verify['timeout-minutes'] >= max + 30);
  });

  test('review has room to wait for the longest verify and still run the reviewer; verdict and tier outlast review', () => {
    const review = jobs.review['timeout-minutes'];
    assert.equal(max, 60);
    assert.ok(review >= max + 30, `review ${review}`);
    assert.equal(String(jobs.review.steps.at(-1).env.GATE_JOB_MINUTES), String(review));
    assert.ok(jobs.verdict['timeout-minutes'] >= review + 10);
    assert.ok(jobs.tier['timeout-minutes'] >= jobs.verdict['timeout-minutes'] + 5);
    const script = readFileSync(join(factory, 'kit/.gate/bin/review'), 'utf8');
    const waits = [...script.matchAll(/GATE_REVIEW_WAIT:-(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(waits.length >= 2);
    for (const w of waits) assert.ok(w / 60 >= review + 10, `GATE_REVIEW_WAIT ${w}`);
    for (const w of waits) assert.ok(w / 60 + 5 <= jobs.tier['timeout-minutes'], `tier ends before a wait of ${w}`);
  });
});
