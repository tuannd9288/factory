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
  *BASE_REF_CHANGED_EVENT*) cat ${JSON.stringify(dir)}/moved.json ;;
  *"states:MERGED,headRefName"*) [ -e ${JSON.stringify(dir)}/parents-fail ] && { echo "HTTP 502" >&2; exit 1; }; node ${JSON.stringify(dir)}/parents.mjs "$@" ;;
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
  const T = join(factory, 'kit/.gate/bin/lib/history.mjs');
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

// FAC-41: `moved` names when the pull request's base last changed and the head of the old base's pull request that merged into the new base
// before then, the stack's parent whose patch an approval given before the move may carry. The fake answers the merged pull requests as
// GitHub does, only those whose head and base branches are the ones asked.
describe('history.mjs moved', () => {
  let dir;
  const T = join(factory, 'kit/.gate/bin/lib/history.mjs');
  const AT = '2026-11-06T10:41:10Z';
  const sha = (c) => c.repeat(40);
  const moved = () => run(dir, process.execPath, [T, 'moved', '--repo', 'o/app', '--pr', '7'], { PATH: `${join(dir, 'bin')}:${process.env.PATH}` });
  const change = (nodes) => writeFileSync(join(dir, 'moved.json'), JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes } } } } }));
  const parents = (list) => writeFileSync(join(dir, 'parents.json'), JSON.stringify(list));
  const pr = (head, mergedAt, over = {}) => ({ headRefName: 'parent', baseRefName: 'main', headRefOid: head, mergedAt, isCrossRepository: false, ...over });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-moved-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), FAKE_GH(dir));
    chmodSync(join(dir, 'bin/gh'), 0o755);
    writeFileSync(join(dir, 'parents.mjs'), `import { readFileSync } from 'node:fs';
const arg = (k) => process.argv.slice(2).find((a) => a.startsWith(k + '='))?.slice(k.length + 1);
const all = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'parents.json'))}, 'utf8'));
if (!Array.isArray(all)) { console.log(JSON.stringify(all)); process.exit(0); }
const nodes = all.filter((p) => p.headRefName === arg('head') && p.baseRefName === arg('base')).map(({ headRefName, baseRefName, ...rest }) => rest);
console.log(JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }));
`);
    change([{ previousRefName: 'parent', currentRefName: 'main', createdAt: AT }]);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('a base that never changed prints nothing', () => {
    change([]);
    const out = moved();
    assert.equal(out.code, 0, out.out);
    assert.equal(out.out.trim(), '');
    change([{ previousRefName: 'parent', currentRefName: 'main', createdAt: AT }]);
  });

  test('the parent is the latest pull request from the old base merged into the new one, never one into another base', () => {
    parents([pr(sha('1'), '2026-11-06T08:00:00Z'), pr(sha('2'), '2026-11-06T09:00:00Z'), pr(sha('3'), '2026-11-06T10:00:00Z', { baseRefName: 'release' })]);
    assert.equal(moved().out.trim(), `${AT} ${sha('2')}`);
  });

  test('a pull request merged after the move is not the parent', () => {
    parents([pr(sha('1'), '2026-11-06T08:00:00Z'), pr(sha('4'), '2026-11-06T14:17:04Z')]);
    assert.equal(moved().out.trim(), `${AT} ${sha('1')}`);
    parents([pr(sha('4'), '2026-11-06T14:17:04Z')]);
    assert.equal(moved().out.trim(), `${AT} none`, 'as for #490, moved by hand before #487 landed');
  });

  test("a fork's pull request from a branch of the same name is not the parent", () => {
    parents([pr(sha('1'), '2026-11-06T08:00:00Z'), pr(sha('5'), '2026-11-06T09:00:00Z', { isCrossRepository: true })]);
    assert.equal(moved().out.trim(), `${AT} ${sha('1')}`);
  });

  test('an answer it cannot read fails closed, exit 2, and names no parent', () => {
    for (const fail of [
      () => parents({ data: { repository: null } }),
      () => writeFileSync(join(dir, 'parents-fail'), ''),
      () => change([{ previousRefName: 'parent', currentRefName: 'main' }]),
    ]) {
      parents([pr(sha('1'), '2026-11-06T08:00:00Z')]);
      fail();
      const out = moved();
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /^history: /);
      rmSync(join(dir, 'parents-fail'), { force: true });
      change([{ previousRefName: 'parent', currentRefName: 'main', createdAt: AT }]);
    }
  });
});
