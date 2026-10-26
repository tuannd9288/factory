// #96: the review-verdict annotation carries `acc` (the hash of the closing issues the reviewer was handed), `verdict` accepts it, and
// `reuse` takes an earlier review only when its acc matches too. history.mjs against a fake `gh api` on PATH; no network.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const FAKE_GH = (dir) => `#!/bin/sh
case "$*" in
  *actions/runs/99/jobs*) cat ${JSON.stringify(dir)}/jobs.json ;;
  *check-runs/501/annotations*) cat ${JSON.stringify(dir)}/annotations.json ;;
  *actions/workflows/gate-trusted.yml/runs*) cat ${JSON.stringify(dir)}/runs.json ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ACC = '0123456789abcdef';
const note = (title, message) => ({ title, message, annotation_level: 'notice' });

describe('history.mjs and the acc of a review-verdict', () => {
  let dir;
  const T = join(factory, 'kit/scripts/lib/history.mjs');
  const annotate = (verdict, result = 'none') => writeFileSync(join(dir, 'annotations.json'), JSON.stringify([note('review-result', result), note('review-verdict', verdict)]));
  const history = (kind, ...extra) =>
    run(dir, process.execPath, [T, kind, '--repo', 'o/app', '--run', '99', '--head', HEAD, '--base', BASE, ...extra], { PATH: `${join(dir, 'bin')}:${process.env.PATH}` }).out.trim();
  const reuse = (acc) => history('reuse', '--nored', 'none', '--acc', acc, '--reviewer', 'claude');

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-acc-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), FAKE_GH(dir));
    chmodSync(join(dir, 'bin/gh'), 0o755);
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ total_count: 1, jobs: [{ id: 501, name: 'review', run_attempt: 1, status: 'completed', conclusion: 'success', completed_at: '2026-10-26T10:00:00Z', check_run_url: 'https://api.github.com/repos/o/app/check-runs/501' }] }));
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ total_count: 1, workflow_runs: [{ id: 99, event: 'pull_request_target' }] }));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('verdict reads the annotation with acc, with a hash or none, and still the older forms', () => {
    for (const verdict of [
      `head=${HEAD} base=${BASE} nored=none acc=${ACC} reviewer=claude pass`,
      `head=${HEAD} base=${BASE} nored=none acc=none reviewer=claude pass`,
      `head=${HEAD} base=${BASE} nored=none reviewer=claude pass`,
      `head=${HEAD} base=${BASE} pass`,
    ]) {
      annotate(verdict);
      assert.equal(history('verdict'), 'ok pass', verdict);
    }
    annotate(`head=${HEAD} base=${BASE} nored=none acc=${ACC} reviewer=claude block`);
    assert.equal(history('verdict'), 'ok block');
    annotate(`head=${'c'.repeat(40)} base=${BASE} nored=none acc=${ACC} reviewer=claude pass`);
    assert.equal(history('verdict'), 'ok mismatch');
    annotate(`head=${HEAD} base=${BASE} nored=none acc=XYZ reviewer=claude pass`);
    assert.match(history('verdict'), /^history: /);
  });

  test('reuse takes an earlier review only when its acc matches, and refuses it when the acc differs', () => {
    annotate(`head=${HEAD} base=${BASE} nored=none acc=${ACC} reviewer=claude pass`);
    assert.equal(reuse(ACC), 'reuse pass 99 none');
    assert.equal(reuse('fedcba9876543210'), 'none');
    assert.equal(reuse('none'), 'none');
    annotate(`head=${HEAD} base=${BASE} nored=none acc=none reviewer=claude block`);
    assert.equal(reuse('none'), 'reuse block 99 none');
    assert.equal(reuse(ACC), 'none');
  });

  test('a review written before acc existed is not reused: it was another question', () => {
    annotate(`head=${HEAD} base=${BASE} nored=none reviewer=claude pass`);
    assert.equal(reuse('none'), 'none');
  });

  test('reuse still needs the same head, base, No-red line and reviewer', () => {
    annotate(`head=${HEAD} base=${BASE} nored=none acc=${ACC} reviewer=claude pass`);
    assert.equal(history('reuse', '--nored', '0123456789abcdef', '--acc', ACC, '--reviewer', 'claude'), 'none');
    assert.equal(history('reuse', '--nored', 'none', '--acc', ACC, '--reviewer', 'stub'), 'none');
    annotate(`head=${HEAD} base=${BASE} nored=none acc=${ACC} reviewer=claude pass`, 'unavailable: quota');
    assert.equal(reuse(ACC), 'none');
  });
});
