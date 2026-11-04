// bin/lib/tldr.mjs: the TL;DR that opens a kit pull request's body (#386).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { kitUpdateTldr, onboardTldr, settingsOf } from '../bin/lib/tldr.mjs';

// The rows as bin/kit-evidence prints them: the suffixes `carried from the base`, `CHANGED from <value>` and the base held none.
const block = (...rows) =>
  ['kit-evidence: PASS', "settings (the gate's, as the head's workflows hold them; a pull request changes one at tier 3):", ...rows.map((r) => `  ${r}`), "replaced (the repository's own at the base, now the kit's):", '  none'].join('\n');
const STAY = block(
  'the reviewer (.github/workflows/gate-trusted.yml): claude',
  "main's runner (.github/workflows/main.yml): [\"self-hosted\",\"macOS\"], carried from the base",
  "the candidate's runner (.github/workflows/gate.yml): [\"ubuntu-latest\"]",
  'the trusted runner (.github/workflows/gate-trusted.yml): ["ubuntu-latest"]',
);
const MOVED = block(
  'the reviewer (.github/workflows/gate-trusted.yml): claude, CHANGED from none (review and verdict fail closed)',
  "main's runner (.github/workflows/main.yml): [\"ubuntu-latest\"]",
  "the candidate's runner (.github/workflows/gate.yml): [\"self-hosted\",\"macOS\"], CHANGED from [\"ubuntu-latest\"]",
  "the trusted runner (.github/workflows/gate-trusted.yml): [\"ubuntu-latest\"], CHANGED: the base held none in the kit's form (a repository variable, before #335)",
);

const ORDER = ['What you will see', 'What changes', 'What it fixes', 'Risk and how to undo', 'Recommendation', 'Tier and evidence', 'Decisions for you'];
const heads = (text) => text.split('\n').slice(1).map((l) => l.match(/^- \*\*([^:]+):\*\* \S/)?.[1]);
const bullet = (text, key) => text.split('\n').find((l) => l.startsWith(`- **${key}:**`));
const decisions = (text) => [...bullet(text, 'Decisions for you').matchAll(/(?:^|\s)\d+\. /g)].length;
const COUNTS = { added: 1, updated: 0, removed: 0, kept: 3 };

describe('the TL;DR of a kit pull request', () => {
  test('reads the gate\'s settings from the evidence as rows, marking those the pull request changes', () => {
    assert.deepEqual(settingsOf(STAY).map((r) => r.changed), [false, false, false, false]);
    assert.deepEqual(settingsOf(MOVED).map((r) => r.changed), [true, false, true, true]);
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

  test('a reviewer of none is said as no reviewer yet', () => {
    const text = onboardTldr('app', block('the reviewer (.github/workflows/gate-trusted.yml): none (review and verdict fail closed)'));
    assert.match(bullet(text, 'What changes'), /no reviewer yet, so nothing merges by itself/);
  });

  test('kit-update\'s says whether it changes a file the repository has, and keeps the settings when none changed', () => {
    let text = kitUpdateTldr('app', COUNTS, STAY);
    assert.deepEqual(heads(text), ORDER);
    assert.match(bullet(text, 'Risk and how to undo'), /It changes no file the repository already has\./);
    assert.match(bullet(text, 'What changes'), /settings stay/);
    assert.equal(decisions(text), 0);
    assert.match(bullet(text, 'Decisions for you'), /none$/);
    text = kitUpdateTldr('app', { ...COUNTS, updated: 2, removed: 1 }, STAY);
    assert.match(bullet(text, 'Risk and how to undo'), /It changes 3 files the repository already has: 2 replaced.*1 removed/);
  });

  test('kit-update\'s names each changed setting, from what and to what, as one decision each, and never says they stay', () => {
    const text = kitUpdateTldr('app', COUNTS, MOVED);
    assert.deepEqual(heads(text), ORDER);
    assert.equal(decisions(text), 3);
    assert.doesNotMatch(bullet(text, 'What changes'), /settings stay\b/);
    assert.match(bullet(text, 'What you will see'), /no reviewer yet.*the claude reviewer/);
    assert.match(bullet(text, 'What changes'), /GitHub's own machines.*your own machine labelled self-hosted, macOS/);
    assert.match(bullet(text, 'Decisions for you'), /the machine that holds the reviewer's key/);
    assert.notEqual(bullet(text, 'Recommendation'), bullet(kitUpdateTldr('app', COUNTS, STAY), 'Recommendation'));
    assert.doesNotMatch(text, /#335|before #|variable|\.yml/);
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
