// packs/pstack/bin/lead (#163): what the launcher refuses and the arguments it gives claude. No live claude, no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enabledPlugins, exitCodeOf, findNode, leadArgs, refusal } from '../bin/lead.mjs';
import { secretsRead } from '../../../bin/lib/seat.mjs';
import { matches } from '../../../test/bash-rule.mjs';
import { FORMS, HARMLESS } from '../../../test/login-forms.mjs';

const home = '/home/factory';
const tmp = () => mkdtempSync(join(tmpdir(), 'lead-'));
const repoIn = (root, name, { gate = true, envrc = true, git = true } = {}) => {
  mkdirSync(join(root, name), { recursive: true });
  if (git) mkdirSync(join(root, name, '.git'));
  if (gate) mkdirSync(join(root, name, '.gate'));
  if (envrc) writeFileSync(join(root, name, '.envrc'), 'export CLAUDE_CONFIG_DIR=x\n');
};

describe('refusal', () => {
  test('refuses a name that is not a plain folder name', () => {
    const root = tmp();
    try {
      for (const bad of ['', 'a/b', '..', '../x', 'a/../b', '-x', '--x', 'a b', 'a[b]', 'a*', 'zalo-gateway ']) assert.match(refusal(bad, root), /not a plain folder name/, JSON.stringify(bad));
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

  test('refuses a symlink, a file, and a folder without its own .git', () => {
    const root = tmp();
    try {
      repoIn(root, 'real');
      symlinkSync(join(root, 'real'), join(root, 'link'));
      writeFileSync(join(root, 'file'), 'x');
      repoIn(root, 'nogit', { git: false });
      assert.match(refusal('link', root), /symlink/);
      assert.match(refusal('file', root), /not a folder/);
      assert.match(refusal('nogit', root), /\.git/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe('leadArgs', () => {
  const root = '/fx/WORKSPACES';
  const roleText = '# the role\nline two';
  const node = '/opt/homebrew/bin/node';
  const { cwd, argv } = leadArgs({ repo: 'zalo-gateway', home, root, roleText, node });
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
    assert.equal(after('--append-system-prompt'), roleText);
    assert.ok(!argv.includes('--append-system-prompt-file'));
    assert.equal(after('--permission-mode'), 'auto');
    assert.equal(after('--add-dir'), join(home, 'factory-runs'));
    assert.equal(after('--name'), 'zalo-gateway-lead');
  });

  test('--continue only when resume is set', () => {
    assert.ok(!argv.includes('--continue'));
    assert.ok(leadArgs({ repo: 'zalo-gateway', home, root, roleText, node, resume: true }).argv.includes('--continue'));
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
      'Bash(' + root + '/bin/seat:*)',
    ]);
    for (const bad of ['Bash(gh:*)', 'Bash(git:*)']) assert.ok(!list('--allowedTools').includes(bad));
  });

  test('the deny list holds gh api, claude, codex, herdr and the secrets', () => {
    const deny = list('--disallowedTools');
    assert.ok(secretsRead.length > 0);
    for (const d of ['Bash(gh api:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(herdr:*)', ...secretsRead]) assert.ok(deny.includes(d), d);
  });

  test('the deny list refuses factory login and factory store in every form, and not the list', () => {
    const deny = list('--disallowedTools');
    for (const command of FORMS) assert.ok(deny.some((r) => matches(r, command)), command);
    for (const command of HARMLESS) assert.ok(!deny.some((r) => matches(r, command)), command);
  });

  test('--settings holds the transcript hook on Stop and SessionEnd, run through node with each part quoted', () => {
    const { hooks } = JSON.parse(after('--settings'));
    const command = `'${node}' '${root}/packs/pstack/bin/transcript-copy.mjs' '${home}/factory-runs/zalo-gateway-lead/transcripts'`;
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionEnd', 'Stop']);
    for (const event of ['Stop', 'SessionEnd']) assert.deepEqual(hooks[event], [{ hooks: [{ type: 'command', command }] }]);
    assert.equal(leadArgs({ repo: 'zalo-gateway', home, root, roleText, node }).hook, command);
  });

  test('the hook command runs the script with no exec bit, even where the paths hold a space and a quote', () => {
    const dir = tmp();
    try {
      const real = fileURLToPath(new URL('../../..', import.meta.url));
      const odd = join(dir, "a b's");
      const config = join(dir, 'profile');
      mkdirSync(join(config, 'projects/p'), { recursive: true });
      const source = join(config, 'projects/p/s.jsonl');
      writeFileSync(source, 'line\n');
      assert.equal(statSync(join(real, 'packs/pstack/bin/transcript-copy.mjs')).mode & 0o111, 0);
      const { hook } = leadArgs({ repo: 'r', home: odd, root: real, roleText, node: process.execPath });
      const r = spawnSync('sh', ['-c', hook], { input: JSON.stringify({ transcript_path: source }), encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(odd, 'factory-runs/r-lead/transcripts/s.jsonl'), 'utf8'), 'line\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('the deny list keeps Edit and Write out of the live clone, by an absolute path', () => {
    const deny = list('--disallowedTools');
    assert.ok(deny.includes('Edit(//fx/WORKSPACES/zalo-gateway/**)'));
    assert.ok(deny.includes('Write(//fx/WORKSPACES/zalo-gateway/**)'));
  });
});

describe('findNode', () => {
  test('is the first node on PATH as PATH names it: a link stays a link, a relative folder and a folder without node are skipped', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, 'empty'));
      mkdirSync(join(dir, 'brew'));
      symlinkSync(process.execPath, join(dir, 'brew/node'));
      assert.equal(findNode(`relative:${join(dir, 'empty')}:${join(dir, 'brew')}:${join(dir, 'missing')}`), join(dir, 'brew/node'));
      assert.notEqual(findNode(join(dir, 'brew')), realpathSync(process.execPath));
      assert.equal(findNode(`${join(dir, 'empty')}:`), null);
      assert.equal(findNode(undefined), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('enabledPlugins', () => {
  test('the plugins set to true, by id', () => {
    assert.deepEqual(enabledPlugins(JSON.stringify({ enabledPlugins: { 'a@mk': true, 'off@mk': false } })), ['a@mk']);
    assert.deepEqual(enabledPlugins('{}'), []);
  });
});

describe('exitCodeOf', () => {
  test('a status is the code', () => {
    assert.equal(exitCodeOf({ status: 0, signal: null }), 0);
    assert.equal(exitCodeOf({ status: 3, signal: null }), 3);
  });
  test('a signal is 128 plus its number', () => {
    assert.equal(exitCodeOf({ status: null, signal: 'SIGINT' }), 130);
    assert.equal(exitCodeOf({ status: null, signal: 'SIGTERM' }), 143);
  });
  test('neither is 1', () => {
    assert.equal(exitCodeOf({ status: null, signal: null }), 1);
  });
});
