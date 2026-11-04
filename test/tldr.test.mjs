// bin/lib/tldr.mjs: the summary that opens a kit pull request's body (#386).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { kitUpdateTldr, onboardTldr, settingsOf } from '../bin/lib/tldr.mjs';

// The rows as bin/kit-evidence prints them: a plain value, or the value and `, CHANGED from <value>`, or the value and
// `, CHANGED: the base held none in the kit's form (…)`.
const block = (...rows) =>
  ['kit-evidence: PASS', "settings (the gate's, as the head's workflows hold them; a pull request changes one at tier 3):", ...rows.map((r) => `  ${r}`), "replaced (the repository's own at the base, now the kit's):", '  none'].join('\n');
const NONE = 'none (review and verdict fail closed)';
const UNSEEN = ", CHANGED: the base held none in the kit's form (a repository variable, before #335)";
const rowsOf = (reviewer = 'claude', pr = '["ubuntu-latest"]') => [
  `the reviewer (.github/workflows/gate-trusted.yml): ${reviewer}`,
  "main's runner (.github/workflows/main.yml): [\"self-hosted\",\"macOS\"]",
  `the candidate's runner (.github/workflows/gate.yml): ${pr}`,
  'the trusted runner (.github/workflows/gate-trusted.yml): ["ubuntu-latest"]',
];
const STAY = block(...rowsOf());
const MOVED = block(
  `the reviewer (.github/workflows/gate-trusted.yml): claude, CHANGED from ${NONE}`,
  "main's runner (.github/workflows/main.yml): [\"ubuntu-latest\"]",
  "the candidate's runner (.github/workflows/gate.yml): [\"self-hosted\",\"macOS\"], CHANGED from [\"ubuntu-latest\"]",
  `the trusted runner (.github/workflows/gate-trusted.yml): ["ubuntu-latest"]${UNSEEN}`,
);
const ALL_UNSEEN = block(...rowsOf().map((r) => `${r}${UNSEEN}`));

const ORDER = ['Thay đổi', 'Rủi ro', 'Đề xuất'];
const heads = (text) => text.split('\n').slice(1).map((l) => l.match(/^- \*\*([^:]+):\*\* \S/)?.[1]);
const bullet = (text, key) => text.split('\n').find((l) => l.startsWith(`- **${key}:**`));
const decisions = (text) => [...bullet(text, 'Đề xuất').matchAll(/(?:^|\s)\d+\. /g)].length;
const without = (text, key) => text.split('\n').filter((l) => !l.startsWith(`- **${key}:**`)).join('\n');
const times = (text, pattern) => [...text.matchAll(pattern)].length;
const COUNTS = { added: 1, updated: 0, removed: 0, kept: 3 };
// The four settings' names in the summary; the reviewer's is a word of other names too, so it is told apart by its colon.
const NAMES = [/máy chạy việc của main/g, /máy kiểm từng thay đổi/g, /máy giữ key của reviewer/g, /(?<!của )reviewer:/g];
const structure = (text) => {
  assert.equal(text.split('\n')[0], '**Tóm tắt cho anh**');
  assert.deepEqual(heads(text), ORDER);
  assert.doesNotMatch(text, /TL;DR for the Human|Summary for the Human|^## /m);
};

describe('the summary of a kit pull request', () => {
  test('reads the gate\'s settings from the evidence as rows, marking those the pull request changes', () => {
    assert.deepEqual(settingsOf(STAY).map((r) => r.changed), [false, false, false, false]);
    assert.deepEqual(settingsOf(MOVED).map((r) => r.changed), [true, false, true, true]);
    assert.deepEqual(settingsOf(MOVED).map((r) => r.from !== ''), [true, false, true, false]);
    assert.deepEqual(settingsOf('kit-evidence: PASS\n'), []);
    assert.equal(settingsOf(STAY).length, 4);
  });

  test('onboard\'s has the three bullets in order and names each setting once, with no file or path', () => {
    const text = onboardTldr('app', STAY);
    structure(text);
    for (const name of NAMES) assert.equal(times(text, name), 1, String(name));
    assert.doesNotMatch(text, /ubuntu-latest|\.yml|\.github|\.gate/);
    assert.equal(decisions(text), 0);
  });

  test('a reviewer, and a GitHub-hosted runner whatever its label, are told apart from the repository\'s own', () => {
    const said = (reviewer) => bullet(onboardTldr('app', block(`the reviewer (.github/workflows/gate-trusted.yml): ${reviewer}`)), 'Thay đổi');
    const all = [NONE, 'claude', 'entire', 'stub'].map(said);
    assert.equal(new Set(all).size, 4);
    const runner = (labels) => bullet(onboardTldr('app', block(`the candidate's runner (.github/workflows/gate.yml): ${labels}`)), 'Thay đổi');
    assert.notEqual(runner('["macos-15"]'), runner('["ubuntu-latest"]'));
    assert.match(runner('["macos-15"]'), /macos-15/);
    assert.match(runner('["ubuntu-24.04"]'), /ubuntu-24\.04/);
    assert.notEqual(runner('["self-hosted","macOS"]'), runner('["macos-15"]'));
    assert.match(runner('["self-hosted","macOS"]'), /self-hosted, macOS/);
    assert.doesNotMatch(runner('["ubuntu-latest"]'), /ubuntu/);
  });

  test('kit-update\'s Rủi ro follows the files it touches, and its Thay đổi the settings it keeps', () => {
    const none = kitUpdateTldr('app', COUNTS, STAY);
    structure(none);
    assert.equal(bullet(none, 'Đề xuất'), '- **Đề xuất:** Approve.');
    for (const name of NAMES) assert.equal(times(none, name), 0, String(name));
    const touched = kitUpdateTldr('app', { ...COUNTS, updated: 2, removed: 1 }, STAY);
    assert.notEqual(bullet(touched, 'Rủi ro'), bullet(none, 'Rủi ro'));
    assert.match(bullet(touched, 'Rủi ro'), /\b3\b/);
    assert.doesNotMatch(bullet(none, 'Rủi ro'), /\b[1-9]\b/);
    const counts = kitUpdateTldr('app', { added: 4, updated: 5, removed: 6, kept: 7 }, STAY);
    assert.match(bullet(counts, 'Thay đổi'), /\b4\b.*\b5\b.*\b6\b.*\b7\b/);
    assert.notEqual(bullet(kitUpdateTldr('app', COUNTS, MOVED), 'Thay đổi'), bullet(none, 'Thay đổi'));
  });

  test('kit-update\'s names each changed setting once, in Đề xuất, and numbers a decision for each', () => {
    const text = kitUpdateTldr('app', COUNTS, MOVED);
    structure(text);
    assert.equal(decisions(text), 3);
    const outside = without(text, 'Đề xuất');
    // MOVED changes the reviewer, the candidate's runner and the trusted runner, not main's.
    for (const [i, name] of NAMES.entries()) {
      assert.equal(times(bullet(text, 'Đề xuất'), name), i === 0 ? 0 : 1, String(name));
      assert.equal(times(outside, name), 0, String(name));
    }
    assert.doesNotMatch(text, /#335|before #|variable|\.yml/);
    assert.notEqual(bullet(text, 'Đề xuất'), bullet(kitUpdateTldr('app', COUNTS, STAY), 'Đề xuất'));
  });

  test('a setting the base held outside the kit\'s form is one decision for each, and the gate is not said to differ', () => {
    const text = kitUpdateTldr('app', COUNTS, ALL_UNSEEN);
    structure(text);
    assert.equal(decisions(text), 4);
    const outside = without(text, 'Đề xuất');
    for (const name of NAMES) {
      assert.equal(times(bullet(text, 'Đề xuất'), name), 1, String(name));
      assert.equal(times(outside, name), 0, String(name));
    }
    assert.notEqual(bullet(text, 'Thay đổi'), bullet(kitUpdateTldr('app', COUNTS, MOVED), 'Thay đổi'));
    assert.notEqual(bullet(text, 'Thay đổi'), bullet(kitUpdateTldr('app', COUNTS, STAY), 'Thay đổi'));
    assert.doesNotMatch(text, /#335|before #|variable|\.yml/);
  });

  test('Rủi ro follows what runs: onboard has no review, and kit-update\'s follows the reviewer', () => {
    const risk = (reviewer) => bullet(kitUpdateTldr('app', COUNTS, block(...rowsOf(reviewer))), 'Rủi ro');
    const none = risk(NONE);
    const claude = risk('claude');
    const stub = risk('stub');
    assert.notEqual(none, claude);
    assert.notEqual(stub, claude);
    assert.notEqual(stub, none);
    assert.equal(risk('entire'), claude);
    assert.notEqual(bullet(onboardTldr('app', STAY), 'Rủi ro'), claude);
    assert.equal(bullet(onboardTldr('app', STAY), 'Rủi ro'), bullet(onboardTldr('app', block(...rowsOf(NONE))), 'Rủi ro'));
  });

  test('the command reads the evidence on stdin, and a call it does not know prints no summary', () => {
    const file = join(factory, 'bin/lib/tldr.mjs');
    const call = (...args) => spawnSync(process.execPath, [file, ...args], { input: STAY, encoding: 'utf8' });
    const out = call('kit-update', 'app', '1', '0', '0', '3');
    assert.equal(out.status, 0, out.stderr);
    structure(out.stdout.trim());
    const bad = call('kit-update', 'app', '1');
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');
  });
});
