// A reviewer finding of one kind on two merged pull requests of one repository is listed in the weekly digest, with its
// enforcer issue if one exists (#408).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, enforcerLookup, mergedPullLookup } from '../bin/lib/ledger.mjs';
import { enforcerIndex, kindsOf, knownKinds, repeatedKinds, reviewerFindings, rolePrompt, validKind } from '../bin/lib/findings.mjs';
import { SCHEMA, buildArgs } from '../bin/lib/seat.mjs';

let n = 0;
const rec = (repo, branch, kinds, extra = {}) => {
  n += 1;
  const findings = kinds === null ? {} : { findings: kinds.map((kind) => ({ kind, claim: `claim ${n}`, blocking: false })) };
  return {
    session: `s${n}`, role: 'reviewer', tag: `review${n}`, run: '/r', repo, branch, start: `2026-11-0${1 + (n % 7)}T00:00:00Z`, end: `2026-11-0${1 + (n % 7)}T00:10:00Z`,
    structured: { conclusion: 'PASS', evidence: [], couldNotRead: [], needsHuman: [], foundOutside: [], ...findings }, ...extra,
  };
};
const PRS = { 'o/app\nb1': 11, 'o/app\nb2': 12, 'o/app\nb3': null, 'o/app\nb4': 14, 'o/lib\nc1': 21 };
const mergedOf = (repo, branch) => PRS[`${repo}\n${branch}`] ?? null;
const enforcerOf = (repo, kind) => (repo === 'o/app' && kind === 'edit-through-heredoc' ? { number: 40, state: 'open' } : null);

const records = [
  rec('o/app', 'b1', ['edit-through-heredoc', 'subject-over-72', 'only-once']),
  rec('o/app', 'b2', ['edit-through-heredoc', 'subject-over-72']),
  rec('o/app', 'b3', ['edit-through-heredoc', 'open-and-one-merged']), // still open: not a merged pull request
  rec('o/app', 'b1', ['open-and-one-merged']),
  rec('o/app', 'b4', ['subject-over-72']),
  rec('o/app', 'b4', ['subject-over-72']), // a second review of the same pull request counts once
  rec('o/app', 'b2', null), // an older record, without the field
  rec('o/lib', 'c1', ['edit-through-heredoc']),
  rec('o/app', 'b1', ['edit-through-heredoc'], { role: 'worker' }), // only a reviewer's findings count
  rec('o/app', 'b2', ['Bad Kind', 'x'.repeat(41), '', 7]),
];

test('a kind on two merged pull requests is listed with their numbers, and its Kind: issue is named (#408)', () => {
  const list = repeatedKinds(records, { mergedOf, enforcerOf });
  assert.deepEqual(list, [
    { repo: 'o/app', kind: 'edit-through-heredoc', prs: [11, 12], enforcer: { number: 40, state: 'open' } },
    { repo: 'o/app', kind: 'subject-over-72', prs: [11, 12, 14], enforcer: null },
  ]);
  const text = digest([], { since: '2026-11-01', until: '2026-11-07', findings: list });
  assert.match(text, /\n## Findings seen on two merged pull requests\n/);
  assert.match(text, /- o\/app `edit-through-heredoc`: #11, #12 — enforcer #40 \(open\)\n/);
  assert.match(text, /- o\/app `subject-over-72`: #11, #12, #14 — no enforcer issue yet\n/);
  assert.doesNotMatch(text, /only-once|open-and-one-merged/);
});

test('with no repeat the section says none, and a failed read says so (#408)', () => {
  assert.match(digest([], { since: 'a', until: 'b', findings: repeatedKinds([], { mergedOf, enforcerOf }) }), /## Findings seen on two merged pull requests\n\n- None\.\n/);
  assert.match(digest([], { since: 'a', until: 'b', findings: { error: 'gh refused' } }), /## Findings seen on two merged pull requests\n\n- gh refused\n/);
  assert.doesNotMatch(digest([], { since: 'a', until: 'b' }), /Findings seen/);
});

test('only a kind seen on two branches asks GitHub which pull request merged', () => {
  const asked = [];
  repeatedKinds(records, { mergedOf: (repo, branch) => (asked.push(`${repo} ${branch}`), mergedOf(repo, branch)), enforcerOf });
  assert.ok(!asked.includes('o/lib c1'));
});

test('a record without the field, a worker, or a bad kind adds nothing (#408)', () => {
  assert.deepEqual(reviewerFindings([rec('o/app', 'b1', null), rec('o/app', 'b1', ['a-kind'], { role: 'worker' }), rec('o/app', 'b1', ['A', 'a--b', '-a'])]), []);
  assert.deepEqual(reviewerFindings([rec('o/app', 'b1', ['a-kind'], { repo: null })]), []);
  assert.deepEqual([validKind('a-b-2'), validKind('a_b'), validKind('x'.repeat(40)), validKind('x'.repeat(41))], [true, false, true, false]);
});

test('an issue is found by its Kind: line, an open one before a closed one (#408)', () => {
  const issues = [
    { number: 5, state: 'closed', body: 'Why.\nKind: edit-through-heredoc\n' },
    { number: 9, state: 'open', body: 'Kind: edit-through-heredoc  \nmore' },
    { number: 3, state: 'closed', body: 'About Kind: subject-over-72 in a sentence' },
    { number: 7, state: 'closed', body: null },
  ];
  assert.deepEqual(kindsOf('x\nKind: a-b\nKind: c\nKind: Bad'), ['a-b', 'c']);
  const index = enforcerIndex(issues);
  assert.deepEqual(index.get('edit-through-heredoc'), { number: 9, state: 'open' });
  assert.equal(index.has('subject-over-72'), false);
});

test('a reviewer is told the kinds its repository already uses, the most used first (#408)', () => {
  assert.deepEqual(knownKinds(records, 'o/app'), ['subject-over-72', 'edit-through-heredoc', 'open-and-one-merged', 'only-once']);
  assert.deepEqual(knownKinds(records, 'o/none'), []);
  assert.deepEqual(knownKinds(records, null), []);
  assert.deepEqual(knownKinds(records, 'o/app', 2), ['subject-over-72', 'edit-through-heredoc']);
  assert.ok(rolePrompt(['aa-bb', 'cc']).includes('aa-bb, cc'));
  const args = buildArgs({ role: 'reviewer', run: '/r', home: '/h', work: '/w', rolePrompt: 'the prompt' });
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'the prompt');
  assert.ok(!buildArgs({ role: 'reviewer', run: '/r', home: '/h', work: '/w' }).includes('--append-system-prompt'));
});

test('a repository that cannot be read gets one line, and the others are listed as usual (#408)', () => {
  const two = [rec('o/a', 'a1', ['k-one']), rec('o/a', 'a2', ['k-one']), rec('o/b', 'b1', ['k-two']), rec('o/b', 'b2', ['k-two'])];
  const merged = (repo, branch) => ({ a1: 1, a2: 2, b1: 3, b2: 4 })[branch];
  const list = repeatedKinds(two, { mergedOf: merged, enforcerOf: (repo) => { if (repo === 'o/a') throw new Error('HTTP 404: Not Found\nmore'); return null; } });
  assert.deepEqual(list, [{ repo: 'o/a', error: 'HTTP 404: Not Found' }, { repo: 'o/b', kind: 'k-two', prs: [3, 4], enforcer: null }]);
  const text = digest([], { since: 'a', until: 'b', findings: list });
  assert.match(text, /\n- o\/a: could not be read \(HTTP 404: Not Found\)\n- o\/b `k-two`: #3, #4 — no enforcer issue yet\n/);
  const none = repeatedKinds(two, { mergedOf: () => { throw new Error('gh refused'); }, enforcerOf });
  assert.match(digest([], { since: 'a', until: 'b', findings: none }), /## Findings seen on two merged pull requests\n\n- The findings could not be read for any repository \(gh refused\)\.\n/);
});

test('a resumed reviewer counts the findings of each round (#408)', () => {
  const round1 = rec('o/app', 'b1', ['a-kind'], { session: 'resumed', end: '2026-11-01T00:10:00Z' });
  const round2 = rec('o/app', 'b1', [], { session: 'resumed', end: '2026-11-01T01:10:00Z' });
  assert.deepEqual(reviewerFindings([round1, round2]), [{ repo: 'o/app', branch: 'b1', kind: 'a-kind' }]);
});

test('a Kind: line is found with a bold label or a kind in backticks (#408)', () => {
  assert.deepEqual(kindsOf('**Kind:** `edit-through-heredoc`'), ['edit-through-heredoc']);
  assert.deepEqual(kindsOf('Kind: edit-through-heredoc\r\nnext'), ['edit-through-heredoc']);
  assert.deepEqual(kindsOf('**Kind: a-b**\nKinds: c\nKind: two words'), ['a-b']);
});

test('the merged-pull lookup asks for the branch under the owner and returns only a merged number (#408)', () => {
  const asked = [];
  const lookup = mergedPullLookup((args) => (asked.push(args), JSON.stringify([{ number: 7, merged_at: null }, { number: 8, merged_at: '2026-11-01T00:00:00Z' }])));
  assert.equal(lookup('own/app', 'issue-1/x'), 8);
  assert.equal(lookup('own/app', 'issue-1/x'), 8);
  assert.equal(asked.length, 1, 'asked once');
  assert.equal(asked[0][0], 'api');
  assert.match(asked[0][1], /^repos\/own\/app\/pulls\?.*state=all/);
  assert.ok(asked[0][1].includes('head=own:issue-1%2Fx'));
  assert.equal(mergedPullLookup(() => '[{"number":9,"merged_at":null}]')('o/r', 'b'), null);
  assert.equal(mergedPullLookup(() => '[]')('o/r', 'b'), null);
});

test('the enforcer lookup reads every page, drops pull requests and reads a repository once (#408)', () => {
  const asked = [];
  const pages = [[{ number: 1, state: 'closed', body: 'Kind: k-one' }, { number: 2, state: 'open', body: 'Kind: k-two', pull_request: {} }], [{ number: 3, state: 'open', body: '**Kind:** `k-one`' }]];
  const lookup = enforcerLookup((args) => (asked.push(args), JSON.stringify(pages)));
  assert.deepEqual(lookup('o/r', 'k-one'), { number: 3, state: 'open' });
  assert.equal(lookup('o/r', 'k-two'), null);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes('--paginate') && asked[0].includes('--slurp'));
  assert.match(asked[0].at(-1), /^repos\/o\/r\/issues\?.*state=all/);
});

test('the report schema asks for findings with a kebab-case kind (#408)', () => {
  assert.ok(SCHEMA.required.includes('findings'));
  const kind = SCHEMA.properties.findings.items.properties.kind;
  assert.deepEqual(SCHEMA.properties.findings.items.required, ['kind', 'claim', 'blocking']);
  assert.ok(new RegExp(kind.pattern).test('subject-over-72') && !new RegExp(kind.pattern).test('Subject over 72'));
  assert.equal(kind.maxLength, 40);
});
