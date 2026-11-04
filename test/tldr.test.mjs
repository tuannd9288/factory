// bin/lib/tldr.mjs: the TL;DR that opens a kit pull request's body (#386).
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
const UNSEEN = ", CHANGED: the base held none in the kit's form (a repository variable, before #335)";
const rowsOf = (reviewer = 'claude', pr = '["ubuntu-latest"]') => [
  `the reviewer (.github/workflows/gate-trusted.yml): ${reviewer}`,
  "main's runner (.github/workflows/main.yml): [\"self-hosted\",\"macOS\"]",
  `the candidate's runner (.github/workflows/gate.yml): ${pr}`,
  'the trusted runner (.github/workflows/gate-trusted.yml): ["ubuntu-latest"]',
];
const STAY = block(...rowsOf());
const MOVED = block(
  'the reviewer (.github/workflows/gate-trusted.yml): claude, CHANGED from none (review and verdict fail closed)',
  "main's runner (.github/workflows/main.yml): [\"ubuntu-latest\"]",
  "the candidate's runner (.github/workflows/gate.yml): [\"self-hosted\",\"macOS\"], CHANGED from [\"ubuntu-latest\"]",
  `the trusted runner (.github/workflows/gate-trusted.yml): ["ubuntu-latest"]${UNSEEN}`,
);
const ALL_UNSEEN = block(...rowsOf().map((r) => `${r}${UNSEEN}`));

const ORDER = ['What you will see', 'What changes', 'What it fixes', 'Risk and how to undo', 'Recommendation', 'Tier and evidence', 'Decisions for you'];
const heads = (text) => text.split('\n').slice(1).map((l) => l.match(/^- \*\*([^:]+):\*\* \S/)?.[1]);
const bullet = (text, key) => text.split('\n').find((l) => l.startsWith(`- **${key}:**`));
const decisions = (text) => [...bullet(text, 'Decisions for you').matchAll(/(?:^|\s)\d+\. /g)].length;
const without = (text, key) => text.split('\n').filter((l) => !l.startsWith(`- **${key}:**`)).join('\n');
const times = (text, pattern) => [...text.matchAll(pattern)].length;
const COUNTS = { added: 1, updated: 0, removed: 0, kept: 3 };

describe('the TL;DR of a kit pull request', () => {
  test('reads the gate\'s settings from the evidence as rows, marking those the pull request changes', () => {
    assert.deepEqual(settingsOf(STAY).map((r) => r.changed), [false, false, false, false]);
    assert.deepEqual(settingsOf(MOVED).map((r) => r.changed), [true, false, true, true]);
    assert.deepEqual(settingsOf(MOVED).map((r) => r.from !== ''), [true, false, true, false]);
    assert.deepEqual(settingsOf('kit-evidence: PASS\n'), []);
    assert.equal(settingsOf(STAY).length, 4);
  });

  test('onboard\'s has the seven bullets in order, names the settings in plain words and asks one decision', () => {
    const text = onboardTldr('app', STAY);
    assert.equal(text.split('\n')[0], '## TL;DR for the Human');
    assert.deepEqual(heads(text), ORDER);
    assert.match(bullet(text, 'What changes'), /GitHub's own machines/);
    assert.match(bullet(text, 'What changes'), /your own machine labelled self-hosted, macOS/);
    assert.match(bullet(text, 'What changes'), /the machine that checks each change/);
    assert.match(bullet(text, 'What changes'), /the machine that holds the reviewer's key/);
    assert.doesNotMatch(text, /ubuntu-latest|\.yml|\.github|\.gate/);
    assert.equal(decisions(text), 1);
  });

  test('a reviewer is named in plain English, and none as no reviewer', () => {
    const said = (reviewer) => bullet(onboardTldr('app', block(`the reviewer (.github/workflows/gate-trusted.yml): ${reviewer}`)), 'What changes');
    assert.match(said('none (review and verdict fail closed)'), /no reviewer/);
    assert.match(said('claude'), /Claude/);
    assert.match(said('entire'), /Entire/);
    assert.doesNotMatch(said('entire'), /the entire reviewer/);
    assert.match(said('stub'), /stand-in/);
    assert.doesNotMatch(said('stub'), /the stub reviewer/);
  });

  test('a GitHub-hosted runner is GitHub\'s machine whatever its label, and any other is the repository\'s own', () => {
    const said = (labels) => bullet(onboardTldr('app', block(`the candidate's runner (.github/workflows/gate.yml): ${labels}`)), 'What changes');
    for (const hosted of ['["macos-15"]', '["ubuntu-24.04"]']) {
      assert.match(said(hosted), /GitHub's own machines/);
      assert.match(said(hosted), new RegExp(hosted.slice(2, -2)));
      assert.doesNotMatch(said(hosted), /your own machine/);
    }
    assert.match(said('["self-hosted","macOS"]'), /your own machine/);
    assert.doesNotMatch(said('["ubuntu-latest"]'), /ubuntu/);
  });

  test('kit-update\'s Risk bullet follows the files it touches, and the settings it keeps are named when none changed', () => {
    const none = kitUpdateTldr('app', COUNTS, STAY);
    assert.deepEqual(heads(none), ORDER);
    assert.equal(decisions(none), 0);
    assert.match(bullet(none, 'Decisions for you'), /none$/);
    assert.match(bullet(none, 'What changes'), /the machine that checks each change/);
    const touched = kitUpdateTldr('app', { ...COUNTS, updated: 2, removed: 1 }, STAY);
    assert.notEqual(bullet(touched, 'Risk and how to undo'), bullet(none, 'Risk and how to undo'));
    assert.match(bullet(touched, 'Risk and how to undo'), /\b3\b/);
    assert.match(bullet(touched, 'Risk and how to undo'), /\b2\b/);
    assert.match(bullet(touched, 'Risk and how to undo'), /\b1\b/);
    assert.doesNotMatch(bullet(none, 'Risk and how to undo'), /\b[1-9]\b/);
  });

  test('kit-update\'s names each changed setting once, in its decision, and points to the decisions elsewhere', () => {
    const text = kitUpdateTldr('app', COUNTS, MOVED);
    assert.deepEqual(heads(text), ORDER);
    assert.equal(decisions(text), 3);
    const outside = without(text, 'Decisions for you');
    const changed = [/the reviewer(?!')/g, /the machine that checks each change/g, /the machine that holds the reviewer's key/g];
    for (const name of changed) {
      assert.ok(times(bullet(text, 'Decisions for you'), name) > 0, String(name));
      assert.equal(times(outside, name), 0, String(name));
    }
    assert.match(bullet(text, 'What changes'), /the machine that runs the main branch's jobs/);
    assert.match(bullet(text, 'Decisions for you'), /no reviewer/);
    assert.match(bullet(text, 'Decisions for you'), /Claude/);
    assert.match(bullet(text, 'Decisions for you'), /GitHub's own machines.*your own machine labelled self-hosted, macOS/);
    assert.doesNotMatch(text, /the new the|#335|before #|variable|\.yml/);
    assert.notEqual(bullet(text, 'Recommendation'), bullet(kitUpdateTldr('app', COUNTS, STAY), 'Recommendation'));
    assert.notEqual(bullet(text, 'What you will see'), bullet(kitUpdateTldr('app', COUNTS, STAY), 'What you will see'));
  });

  test('a setting the base held outside the kit\'s form is one decision about all of them, and the gate is not said to differ', () => {
    const text = kitUpdateTldr('app', COUNTS, ALL_UNSEEN);
    assert.equal(decisions(text), 1);
    const outside = without(text, 'Decisions for you');
    for (const name of [/the reviewer(?!')/g, /the machine that checks each change/g, /the machine that holds the reviewer's key/g, /the machine that runs the main branch's jobs/g]) {
      assert.equal(times(bullet(text, 'Decisions for you'), name), 1, String(name));
      assert.equal(times(outside, name), 0, String(name));
    }
    assert.doesNotMatch(bullet(text, 'What you will see'), /differently/);
    assert.notEqual(bullet(text, 'What you will see'), bullet(kitUpdateTldr('app', COUNTS, MOVED), 'What you will see'));
    assert.notEqual(bullet(text, 'What you will see'), bullet(kitUpdateTldr('app', COUNTS, STAY), 'What you will see'));
    assert.doesNotMatch(text, /the new the|#335|before #|variable|\.yml/);
  });

  test('Tier and evidence follows what runs: onboard has no review, and kit-update\'s follows the reviewer', () => {
    const tier = (reviewer) => bullet(kitUpdateTldr('app', COUNTS, block(...rowsOf(reviewer))), 'Tier and evidence');
    const none = tier('none (review and verdict fail closed)');
    const claude = tier('claude');
    const stub = tier('stub');
    assert.notEqual(none, claude);
    assert.notEqual(stub, claude);
    assert.notEqual(stub, none);
    assert.equal(tier('entire'), claude);
    assert.notEqual(bullet(onboardTldr('app', STAY), 'Tier and evidence'), claude);
    assert.equal(bullet(onboardTldr('app', STAY), 'Tier and evidence'), bullet(onboardTldr('app', block(...rowsOf('none (review and verdict fail closed)'))), 'Tier and evidence'));
  });

  test('the command reads the evidence on stdin, and a call it does not know prints no TL;DR', () => {
    const file = join(factory, 'bin/lib/tldr.mjs');
    const call = (...args) => spawnSync(process.execPath, [file, ...args], { input: STAY, encoding: 'utf8' });
    const out = call('kit-update', 'app', '1', '0', '0', '3');
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(heads(out.stdout.trim()), ORDER);
    const bad = call('kit-update', 'app', '1');
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');
  });
});
