import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORDS, freeWord, wordStart, pickTeam, teamsOf } from '../bin/lib/team-names.mjs';
import { parseArgs } from '../packs/pstack/bin/lead.mjs';

test('an omitted team is resolved from repository state, not a fixed default (#416 regression)', () => {
  assert.equal(parseArgs(['factory']).team, null);
  assert.deepEqual(parseArgs(['factory', '--new-team']).flags, ['--new-team']);
  assert.ok(parseArgs(['factory', '--new-team', '--team', 'otter']).error);
});

test('FNV-1a nickname is stable and scans from the first word, wrapping when taken', () => {
  assert.equal(wordStart('factory'), 149);
  assert.equal(freeWord('factory', []), 'thyme');
  assert.equal(freeWord('factory', []), freeWord('factory', []));
  assert.equal(freeWord('factory', ['thyme']), 'bay');
  assert.equal(freeWord('factory', WORDS), 'thyme2');
});

test('no team picks a name; one resumes; several refuse; new-team scans all team sources', () => {
  const home = mkdtempSync(join(tmpdir(), 'team-names-'));
  const options = { home, state: join(home, 'state'), runs: join(home, 'runs'), processes: () => [] };
  try {
    mkdirSync(options.state);
    assert.equal(pickTeam('factory', options), 'thyme');
    mkdirSync(join(options.runs, 'factory-thyme'), { recursive: true });
    assert.equal(pickTeam('factory', options), 'thyme');
    writeFileSync(join(options.state, 'accounts'), 'factory/factory-bay=test\n');
    assert.throws(() => pickTeam('factory', options), /bay, thyme/);
    assert.equal(pickTeam('factory', { ...options, newTeam: true }), 'beach');
    options.processes = () => [{ command: 'claude --name factory-beach' }];
    assert.deepEqual(teamsOf('factory', options), ['bay', 'beach', 'thyme']);
    assert.equal(pickTeam('factory', { ...options, newTeam: true }), 'brook');
    assert.equal(pickTeam('another', options), freeWord('another', []));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a wake never picks a new word: a repository with no team is refused', async () => {
  const { pickTeam } = await import('../bin/lib/team-names.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'team-names-'));
  try {
    assert.throws(() => pickTeam('nowhere', { home, runs: join(home, 'factory-runs'), state: join(home, 'state'), processes: () => [], existing: true }), /has no team/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
