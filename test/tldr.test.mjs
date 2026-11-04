// bin/lib/tldr.mjs: the TL;DR that opens a kit pull request's body (#386).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { kitUpdateTldr, onboardTldr, settingsOf } from '../bin/lib/tldr.mjs';

const EVIDENCE = [
  'kit-evidence: PASS',
  "settings (the gate's, as the head's workflows hold them; a pull request changes one at tier 3):",
  '  the reviewer (.github/workflows/gate-trusted.yml): claude',
  "  main's runner (.github/workflows/main.yml): [\"self-hosted\",\"macOS\"], carried from the base",
  'replaced (the repository\'s own at the base, now the kit\'s):',
  '  none',
].join('\n');

const ORDER = ['What you will see', 'What changes', 'What it fixes', 'Risk', 'Recommendation'];
const heads = (text) => text.split('\n').slice(1).map((l) => l.match(/^- \*\*([^:]+):\*\* \S/)?.[1]);

describe('the TL;DR of a kit pull request', () => {
  test('names the gate\'s settings from the evidence, without the files that hold them, and stops at the block\'s end', () => {
    assert.equal(settingsOf(EVIDENCE), 'the reviewer: claude; main\'s runner: ["self-hosted","macOS"], carried from the base');
    assert.equal(settingsOf('kit-evidence: PASS\n'), '');
  });

  test('onboard\'s has the five bullets in order and names the settings', () => {
    const text = onboardTldr('app', EVIDENCE);
    assert.equal(text.split('\n')[0], '## TL;DR for the Human');
    assert.deepEqual(heads(text), ORDER);
    assert.match(text, /the reviewer: claude/);
  });

  test('kit-update\'s says whether it changes a file the repository has', () => {
    const counts = { added: 1, updated: 0, removed: 0, kept: 3 };
    let text = kitUpdateTldr('app', counts, EVIDENCE);
    assert.deepEqual(heads(text), ORDER);
    assert.match(text, /\*\*Risk:\*\* It changes no file the repository already has\./);
    text = kitUpdateTldr('app', { ...counts, updated: 2, removed: 1 }, EVIDENCE);
    assert.match(text, /\*\*Risk:\*\* It changes 3 files the repository already has: 2 replaced.*1 removed/);
  });

  test('the command reads the evidence on stdin and refuses a call it does not know', () => {
    const file = join(factory, 'bin/lib/tldr.mjs');
    const call = (...args) => spawnSync(process.execPath, [file, ...args], { input: EVIDENCE, encoding: 'utf8' });
    const out = call('kit-update', 'app', '1', '0', '0', '3');
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(heads(out.stdout.trim()), ORDER);
    assert.equal(call('kit-update', 'app', '1').status, 2);
  });
});
