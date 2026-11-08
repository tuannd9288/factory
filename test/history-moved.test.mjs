// history.mjs moved (FAC-41), against a fake `gh api` on PATH; no network.
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
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;
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
