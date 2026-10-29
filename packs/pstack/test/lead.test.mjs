// packs/pstack/bin/lead (#163): what the launcher refuses and the arguments it gives claude. No live claude, no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leadArgs, missingPlugins, refusal } from '../bin/lead.mjs';
import { secretsRead } from '../../../bin/lib/seat.mjs';

const home = '/home/factory';
const tmp = () => mkdtempSync(join(tmpdir(), 'lead-'));
const repoIn = (root, name, { gate = true, envrc = true } = {}) => {
  mkdirSync(join(root, name), { recursive: true });
  if (gate) mkdirSync(join(root, name, '.gate'));
  if (envrc) writeFileSync(join(root, name, '.envrc'), 'export CLAUDE_CONFIG_DIR=x\n');
};

describe('refusal', () => {
  test('refuses a name that is not a plain folder name', () => {
    const root = tmp();
    try {
      for (const bad of ['', 'a/b', '..', '../x', 'a/../b']) assert.match(refusal(bad, root), /\S/, JSON.stringify(bad));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('refuses a folder without .gate/ or without .envrc, and a missing one', () => {
    const root = tmp();
    try {
      repoIn(root, 'nogate', { gate: false });
      repoIn(root, 'noenvrc', { envrc: false });
      repoIn(root, 'ok');
      assert.match(refusal('nogate', root), /\.gate/);
      assert.match(refusal('noenvrc', root), /\.envrc/);
      assert.ok(refusal('missing', root));
      assert.equal(refusal('ok', root), null);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe('leadArgs', () => {
  const root = '/fx/WORKSPACES';
  const { cwd, argv } = leadArgs({ repo: 'zalo-gateway', home, root });
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  const list = (flag) => {
    const out = [];
    for (let j = argv.indexOf(flag) + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
    return out;
  };

  test('runs in the repository, through direnv, interactive', () => {
    assert.equal(cwd, join(root, 'zalo-gateway'));
    assert.deepEqual(argv.slice(0, 4), ['direnv', 'exec', '.', 'claude']);
    assert.ok(!argv.includes('-p') && !argv.includes('--print'));
  });

  test('model, effort, role text, permission mode, add-dir and name', () => {
    assert.equal(after('--model'), 'opus');
    assert.equal(after('--effort'), 'high');
    assert.equal(after('--append-system-prompt-file'), join(root, 'packs/pstack/lead.md'));
    assert.equal(after('--permission-mode'), 'acceptEdits');
    assert.equal(after('--add-dir'), join(home, 'factory-runs'));
    assert.equal(after('--name'), 'zalo-gateway-lead');
  });

  test('--continue only when resume is set', () => {
    assert.ok(!argv.includes('--continue'));
    assert.ok(leadArgs({ repo: 'zalo-gateway', home, root, resume: true }).argv.includes('--continue'));
  });

  test('the allow list is exactly the Lead\'s, with no blanket gh or git', () => {
    assert.deepEqual(list('--allowedTools'), [
      'Read', 'Glob', 'Grep', 'Write', 'Edit',
      'Bash(git fetch:*)', 'Bash(git worktree:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
      'Bash(git rev-parse:*)', 'Bash(git branch:*)', 'Bash(git push -u origin HEAD)',
      'Bash(cd:*)', 'Bash(ls:*)', 'Bash(mkdir:*)',
      'Bash(.gate/bin/claim:*)', 'Bash(.gate/bin/tier:*)', 'Bash(.gate/bin/verify:*)', 'Bash(.gate/bin/red-check:*)',
      'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh pr create:*)', 'Bash(gh pr view:*)', 'Bash(gh pr checks:*)',
      'Bash(gh pr merge --auto --merge:*)',
      'Bash(' + home + '/WORKSPACES/bin/seat:*)',
    ]);
    for (const bad of ['Bash(gh:*)', 'Bash(git:*)']) assert.ok(!list('--allowedTools').includes(bad));
  });

  test('the deny list holds gh api, claude, codex, herdr and the secrets', () => {
    const deny = list('--disallowedTools');
    assert.ok(secretsRead.length > 0);
    for (const d of ['Bash(gh api:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(herdr:*)', ...secretsRead]) assert.ok(deny.includes(d), d);
  });
});

describe('missingPlugins', () => {
  const settings = (enabled) => JSON.stringify({ enabledPlugins: enabled });
  const listed = JSON.stringify([{ id: 'present@mk' }]);

  test('an enabled plugin absent from the list is missing', () => {
    assert.deepEqual(missingPlugins(settings({ 'pstack@pstack-f713f14': true }), listed), ['pstack@pstack-f713f14']);
  });
  test('an enabled plugin in the list is not', () => {
    assert.deepEqual(missingPlugins(settings({ 'present@mk': true }), listed), []);
  });
  test('a plugin set to false is not wanted', () => {
    assert.deepEqual(missingPlugins(settings({ 'off@mk': false }), listed), []);
  });
  test('settings with no enabledPlugins want nothing', () => {
    assert.deepEqual(missingPlugins('{}', listed), []);
  });
});
