// #96: the trusted read of the issues a pull request closes (kit/.gate/bin/lib/acceptance.mjs), against a fake `gh` on PATH.
// The shapes are the ones gh printed on 2026-10-26 for `gh pr view --json closingIssuesReferences` and `gh issue view
// --json number,title,labels,body`. No network and no real gh.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const FAKE_GH = (dir) => `#!/bin/sh
echo "$*" >>${JSON.stringify(dir)}/gh-calls
[ -e ${JSON.stringify(dir)}/gh-fails ] && { echo "gh: HTTP 502" >&2; exit 1; }
case "$1 $2" in
  "pr view") cat ${JSON.stringify(dir)}/closing.json ;;
  "issue view") cat ${JSON.stringify(dir)}/issue-"$3".json ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

const ref = (number, owner = 'tuannd9288', name = 'factory') => ({
  id: `I_${number}`,
  number,
  repository: { id: 'R_kgDOVSBtLA', name, owner: { id: 'U_kgDODX9Zkw', login: owner } },
  url: `https://github.com/${owner}/${name}/issues/${number}`,
});
const issue = (number, extra = {}) => ({
  body: `**Sublayer:** 1b.\n\n## Acceptance\n\n- The brief carries the quote of the Human.\n`,
  labels: [{ id: 'LA_kwDOVSBtLM8AAAAC_PMTZg', name: 'sublayer-1b', description: '1b System of record', color: '0969da' }, { id: 'LA_2', name: 'task', description: '', color: 'ffffff' }],
  number,
  title: 'Record the Human\'s words',
  ...extra,
});

describe('acceptance reader', () => {
  let dir;
  const T = join(factory, 'kit/.gate/bin/lib/acceptance.mjs');
  const out = () => join(dir, 'acceptance.json');
  // What the body says, as gh prints it beside the closing references (#133: the Issue: line).
  let bodyText = '';
  const closing = (...refs) => writeFileSync(join(dir, 'closing.json'), JSON.stringify({ closingIssuesReferences: refs, body: bodyText }));
  const issueFile = (number, value) => writeFileSync(join(dir, `issue-${number}.json`), typeof value === 'string' ? value : JSON.stringify(value));
  const calls = () => readFileSync(join(dir, 'gh-calls'), 'utf8').split('\n').filter(Boolean);
  const read = () => run(dir, process.execPath, [T, '--repo', 'tuannd9288/factory', '--pr', '104', '--out', out()], { PATH: `${join(dir, 'bin')}:${process.env.PATH}` });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'acceptance-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), FAKE_GH(dir));
    chmodSync(join(dir, 'bin/gh'), 0o755);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    bodyText = '';
    for (const f of ['gh-fails', 'acceptance.json']) rmSync(join(dir, f), { force: true });
    writeFileSync(join(dir, 'gh-calls'), '');
  });

  test('reads a closing issue of this repository with two porcelain commands: number, title, label names and body', () => {
    closing(ref(90));
    issueFile(90, issue(90));
    const r = read();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out.trim(), /^[0-9a-f]{16}$/);
    assert.deepEqual(calls(), ['pr view 104 --repo tuannd9288/factory --json closingIssuesReferences,body', 'issue view 90 --repo tuannd9288/factory --json number,title,labels,body']);
    const file = JSON.parse(readFileSync(out(), 'utf8'));
    assert.deepEqual(file, { issues: [{ number: 90, title: "Record the Human's words", labels: ['sublayer-1b', 'task'], body: issue(90).body, length: issue(90).body.length }], elsewhere: [] });
  });

  test('with no closing issue it writes an empty file and prints none', () => {
    closing();
    const r = read();
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out.trim(), 'none');
    assert.deepEqual(JSON.parse(readFileSync(out(), 'utf8')), { issues: [], elsewhere: [] });
    assert.equal(calls().length, 1);
  });

  test('a reference to another repository is named and its text is never fetched', () => {
    closing(ref(90), ref(5, 'someone', 'else'));
    issueFile(90, issue(90));
    issueFile(5, issue(5));
    const r = read();
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(out(), 'utf8')).elsewhere, ['someone/else#5']);
    assert.ok(!calls().some((c) => c.startsWith('issue view 5')), calls().join('\n'));
    // Only another repository's reference: nothing read, but the brief is not the same question as with none.
    closing(ref(5, 'someone', 'else'));
    const only = read();
    assert.equal(only.code, 0, only.out);
    assert.match(only.out.trim(), /^[0-9a-f]{16}$/);
  });

  test('the owner and the name are compared without regard to case, as GitHub does', () => {
    closing(ref(90, 'TuanND9288', 'Factory'));
    issueFile(90, issue(90));
    assert.equal(read().code, 0);
    assert.equal(JSON.parse(readFileSync(out(), 'utf8')).issues.length, 1);
  });

  test('a body over 30,000 characters is cut there, and its full length is kept', () => {
    closing(ref(90));
    issueFile(90, issue(90, { body: 'x'.repeat(40_000) }));
    assert.equal(read().code, 0);
    const [one] = JSON.parse(readFileSync(out(), 'utf8')).issues;
    assert.equal(one.body.length, 30_000);
    assert.equal(one.length, 40_000);
  });

  test('the hash follows what the reviewer is handed: a changed body, title or label is another hash', () => {
    const hashOf = (value) => {
      closing(ref(90));
      issueFile(90, value);
      const r = read();
      assert.equal(r.code, 0, r.out);
      return r.out.trim();
    };
    const first = hashOf(issue(90));
    assert.equal(hashOf(issue(90)), first);
    assert.notEqual(hashOf(issue(90, { body: 'another acceptance\n' })), first);
    assert.notEqual(hashOf(issue(90, { title: 'another title' })), first);
    assert.notEqual(hashOf(issue(90, { labels: [] })), first);
  });

  test('a pull request that names its issue only by Issue: #<n> and closes nothing has that issue read for the reviewer', () => {
    bodyText = 'Summary\nIssue: #90\nTeam: team-x\n';
    closing();
    issueFile(90, issue(90));
    const r = read();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out.trim(), /^[0-9a-f]{16}$/);
    assert.deepEqual(JSON.parse(readFileSync(out(), 'utf8')).issues.map((i) => i.number), [90]);
    assert.deepEqual(calls().slice(1), ['issue view 90 --repo tuannd9288/factory --json number,title,labels,body']);
  });

  test('an issue named by Issue: and also closed is read once; one named and another closed are both read', () => {
    bodyText = 'Issue: #90\n';
    closing(ref(90));
    issueFile(90, issue(90));
    assert.equal(read().code, 0);
    assert.deepEqual(JSON.parse(readFileSync(out(), 'utf8')).issues.map((i) => i.number), [90]);
    bodyText = 'Issue: #90\n';
    closing(ref(91));
    issueFile(91, issue(91));
    assert.equal(read().code, 0);
    assert.deepEqual(JSON.parse(readFileSync(out(), 'utf8')).issues.map((i) => i.number).sort(), [90, 91]);
  });

  test('Issue: none, a placeholder, or no Issue: line adds nothing, and the hash follows the issue named', () => {
    for (const text of ['Issue: none\n', 'Issue: #<issue labelled task>\n', 'Closes #90\n']) {
      bodyText = text;
      closing();
      const r = read();
      assert.equal(r.code, 0, r.out);
      assert.equal(r.out.trim(), 'none', text);
    }
    closing(ref(90));
    issueFile(90, issue(90));
    const closed = read().out.trim();
    bodyText = 'Issue: #90\n';
    closing();
    assert.equal(read().out.trim(), closed, 'the same issue by either route is the same question');
  });

  test('an Issue: that names an issue gh cannot read, or a listing with no body, is exit 3', () => {
    bodyText = 'Issue: #404\n';
    closing();
    const r = read();
    assert.equal(r.code, 3, r.out);
    assert.ok(!existsSync(out()));
    writeFileSync(join(dir, 'closing.json'), JSON.stringify({ closingIssuesReferences: [] }));
    assert.equal(read().code, 3);
  });

  test('gh failing, or printing what is not the recorded shape, is exit 3 with a one-line reason and no file', () => {
    closing(ref(90));
    issueFile(90, issue(90));
    writeFileSync(join(dir, 'gh-fails'), '');
    let r = read();
    assert.equal(r.code, 3, r.out);
    assert.ok(!existsSync(out()));
    rmSync(join(dir, 'gh-fails'));
    for (const [what, set] of [
      ['not JSON', () => writeFileSync(join(dir, 'closing.json'), 'not json')],
      ['no closingIssuesReferences', () => writeFileSync(join(dir, 'closing.json'), '{}')],
      ['a reference without a repository', () => closing({ number: 90, url: 'x' })],
      ['a number that is not an integer', () => closing({ ...ref(90), number: '90' })],
      ['an issue without a body', () => { closing(ref(90)); issueFile(90, { number: 90, title: 't', labels: [] }); }],
      ['an issue of another number', () => { closing(ref(90)); issueFile(90, issue(91)); }],
      ['a label without a name', () => { closing(ref(90)); issueFile(90, issue(90, { labels: [{ id: 'x' }] })); }],
    ]) {
      set();
      r = read();
      assert.equal(r.code, 3, `${what}: ${r.out}`);
      assert.ok(!existsSync(out()), what);
      assert.equal(r.out.trim().split('\n').length, 1, what);
      assert.match(r.out, /^acceptance: /, what);
    }
  });
});
