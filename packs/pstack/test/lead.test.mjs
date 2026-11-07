// packs/pstack/bin/lead (#163): what the launcher refuses and the arguments it gives claude. No live claude, no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enabledPlugins, exitCodeOf, findNode, leadArgs, refusal } from '../bin/lead.mjs';
import { pushHook } from '../../../bin/lib/force-push.mjs';
import { secretsRead } from '../../../bin/lib/seat.mjs';
import { MODELS, pstackModels } from '../../../bin/lib/models.mjs';
import { matches, rulesAfter } from '../../../test/bash-rule.mjs';
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

const hookOf = (argv) => JSON.parse(argv[argv.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0].command;

describe('leadArgs', () => {
  const root = '/fx/WORKSPACES';
  const roleText = '# the role\nline two';
  const node = '/opt/homebrew/bin/node';
  const { cwd, argv } = leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node });
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
    assert.equal(after('--model'), MODELS.lead.model);
    assert.equal(after('--effort'), MODELS.lead.effort);
    assert.equal(after('--append-system-prompt'), roleText);
    assert.ok(!argv.includes('--append-system-prompt-file'));
    assert.equal(after('--permission-mode'), 'auto');
    assert.equal(after('--add-dir'), join(home, 'factory-runs'));
    assert.equal(after('--name'), 'zalo-gateway-lead');
  });

  test('--resume <id> only when a session id is given, never --continue', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    assert.ok(!argv.includes('--resume') && !argv.includes('--continue'));
    const withId = leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node, resume: id }).argv;
    assert.equal(withId[withId.indexOf('--resume') + 1], id);
    assert.ok(!withId.includes('--continue'));
  });

  test('a resume\'s message is claude\'s prompt argument, right after --resume <id> and before every option that takes a list (#316)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const message = '[factory] your role changed:\n# the role';
    const withMessage = leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node, resume: id, message }).argv;
    const at = withMessage.indexOf('--resume');
    assert.equal(withMessage[at + 1], id);
    assert.equal(withMessage[at + 2], message);
    assert.equal(withMessage.filter((a) => a === message).length, 1);
    assert.ok(at + 2 < withMessage.indexOf('--allowedTools') && at + 2 < withMessage.indexOf('--disallowedTools'));
    assert.equal(withMessage[at + 3], '--allowedTools');
    assert.equal(withMessage[withMessage.indexOf('--append-system-prompt') + 1], roleText, 'the role text stays a system prompt');
    const without = leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node, resume: id }).argv;
    assert.equal(without[without.indexOf('--resume') + 2], '--allowedTools');
    assert.ok(!leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node, message }).argv.includes(message), 'a new session gets no message');
  });

  test('a new session\'s id goes as --session-id before the list options, and never with --resume (#316)', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const fresh = leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node, sessionId: id }).argv;
    assert.equal(fresh[fresh.indexOf('--session-id') + 1], id);
    assert.equal(fresh[fresh.indexOf('--session-id') + 2], '--allowedTools');
    assert.ok(!fresh.includes('--resume'));
    const resumed = leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node, resume: id, sessionId: id }).argv;
    assert.ok(!resumed.includes('--session-id'));
    assert.ok(!leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node }).argv.includes('--session-id'));
  });

  test('the allow list is exactly the Lead\'s, with no blanket gh or git', () => {
    assert.deepEqual(list('--allowedTools'), [
      'Read', 'Glob', 'Grep', 'Write', 'Edit',
      'Bash(git fetch:*)', 'Bash(git worktree:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
      'Bash(git rev-parse:*)', 'Bash(git branch:*)', 'Bash(git push -u origin HEAD)',
      'Bash(cd:*)', 'Bash(ls:*)', 'Bash(mkdir:*)',
      'Bash(.gate/bin/claim:*)', 'Bash(.gate/bin/tier:*)', 'Bash(.gate/bin/verify:*)', 'Bash(.gate/bin/red-check:*)',
      'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh issue create:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue edit:*)',
      'Bash(gh pr view:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr comment:*)', 'Bash(scripts/ship:*)', 'Bash(scripts/pr-body:*)',
      'Bash(factory linear:*)',
      'Bash(factory codex:*)',
      'Bash(' + root + '/bin/seat:*)',
    ]);
    for (const bad of ['Bash(gh:*)', 'Bash(git:*)']) assert.ok(!list('--allowedTools').includes(bad));
  });

  test('the removed brief checker has no execution grant (#482)', () => {
    assert.ok(!list('--allowedTools').includes('Bash(' + root + '/bin/brief-check:*)'));
  });

  test('the Lead edits a pull request\'s body through scripts/pr-body, never gh pr edit (#386)', () => {
    const allowed = list('--allowedTools');
    assert.ok(allowed.includes('Bash(scripts/pr-body:*)'));
    assert.ok(!allowed.some((r) => r.includes('gh pr edit')));
  });

  test('the command the Lead ran at 22:05 (gh issue create) is allowed, and gh api is neither denied nor allowed (#277, #343)', () => {
    const create = 'gh issue create --label task --title "scripts/ship: the exit-code line says a stop exits 1, but a BLOCKED stop exits 2" --body-file /private/tmp/x/issue.md';
    assert.ok(rulesAfter(argv, '--allowedTools').some((r) => matches(r, create)));
    assert.ok(rulesAfter(argv, '--allowedTools').some((r) => matches(r, 'gh issue comment 12 --body-file /private/tmp/x/c.md')));
    assert.ok(!rulesAfter(argv, '--disallowedTools').some((r) => matches(r, 'gh api repos/x/y')));
    assert.ok(!rulesAfter(argv, '--allowedTools').some((r) => matches(r, 'gh api repos/x/y')));
  });

  test('the deny list holds claude, codex, herdr and the secrets', () => {
    const deny = list('--disallowedTools');
    assert.ok(secretsRead.length > 0);
    for (const d of ['Bash(claude:*)', 'Bash(codex:*)', 'Bash(herdr:*)', ...secretsRead]) assert.ok(deny.includes(d), d);
    // Codex is reached through `factory codex` alone, never codex itself (#182, D2).
    const allowed = list('--allowedTools');
    assert.ok(allowed.some((r) => matches(r, 'factory codex --role cross-judge --effort high')));
    assert.ok(deny.some((r) => matches(r, 'codex exec -')));
    assert.ok(!allowed.some((r) => matches(r, 'codex exec -')));
  });

  test('the deny list refuses reading the environment, the tokens folder and the archive folder (#178)', () => {
    const deny = list('--disallowedTools');
    for (const command of ['env', 'env -0', 'printenv', 'printenv CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(deny.some((r) => matches(r, command)), command);
    for (const rule of ['Read(~/.agent-profiles/tokens/**)', 'Read(~/.agent-profiles/archive/**)', 'Read(~/.agent-profiles/seats/1/oauth-token)']) assert.ok(deny.includes(rule), rule);
  });

  test('the deny list refuses factory account add, store, use and logout in every form, and not the list', () => {
    const deny = list('--disallowedTools');
    for (const command of FORMS) assert.ok(deny.some((r) => matches(r, command)), command);
    for (const command of HARMLESS) assert.ok(!deny.some((r) => matches(r, command)), command);
  });

  test('--settings holds the same hook on SessionStart, UserPromptSubmit, Notification, Stop and SessionEnd, run through node with each part quoted', () => {
    const { hooks } = JSON.parse(after('--settings'));
    const command = `'${node}' '${root}/packs/pstack/bin/transcript-copy.mjs' '${home}/factory-runs/zalo-gateway-lead/transcripts'`;
    assert.deepEqual(hooks.PreToolUse, pushHook(false, node));
    delete hooks.PreToolUse;
    assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    for (const event of Object.keys(hooks)) assert.deepEqual(hooks[event], [{ hooks: [{ type: 'command', command }] }]);
    assert.equal(leadArgs({ repo: 'zalo-gateway', team: 'lead', home, root, roleText, node }).hook, command);
  });

  test('a team names the session and the hook\'s folder, <repo>-<team>; with none the team is lead, today\'s <repo>-lead (#196)', () => {
    const b = leadArgs({ repo: 'zalo-gateway', team: 'b', home, root, roleText, node });
    assert.equal(b.argv[b.argv.indexOf('--name') + 1], 'zalo-gateway-b');
    assert.equal(b.hook, `'${node}' '${root}/packs/pstack/bin/transcript-copy.mjs' '${home}/factory-runs/zalo-gateway-b/transcripts'`);
    assert.equal(after('--name'), 'zalo-gateway-lead');
    assert.ok(hookOf(argv).includes('/factory-runs/zalo-gateway-lead/transcripts'));
  });

  test('--settings turns auto memory off (#285)', () => {
    assert.equal(JSON.parse(after('--settings')).autoMemoryEnabled, false);
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
      const { hook } = leadArgs({ repo: 'r', team: 'lead', home: odd, root: real, roleText, node: process.execPath });
      const r = spawnSync('sh', ['-c', hook], { input: JSON.stringify({ transcript_path: source }), encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(odd, 'factory-runs/r-lead/transcripts/s.jsonl'), 'utf8'), 'line\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('the deny list protects the live clone with Edit and has no path-scoped Write rule', () => {
    const deny = list('--disallowedTools');
    assert.ok(deny.includes('Edit(//fx/WORKSPACES/zalo-gateway/**)'));
    assert.ok(!deny.some((rule) => rule.startsWith('Write(')));
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

test('the model rule writes the table\'s pstack lines on every start without changing other config files', async () => {
  const { writeModels } = await import('../bin/lead.mjs');
  const config = tmp();
  try {
    mkdirSync(join(config, 'rules'));
    const others = ['.claude.json', 'settings.json', 'rules/other.md'];
    for (const name of others) writeFileSync(join(config, name), 'keep me\n', { mode: 0o600 });
    const before = others.map((name) => ({ bytes: readFileSync(join(config, name)), stat: statSync(join(config, name)) }));
    const file = join(config, 'rules/pstack-models.md');
    writeModels(config);
    const first = readFileSync(file);
    assert.equal(first.toString(), pstackModels());
    assert.deepEqual(first.toString().split('\n').filter((line) => line && !line.startsWith('#')), Object.entries(MODELS.pstack.roles).map(([role, value]) => `${role}: ${value}`));
    writeModels(config);
    assert.deepEqual(readFileSync(file), first);
    writeFileSync(file, 'stale rule\n');
    writeModels(config);
    assert.deepEqual(readFileSync(file), first, 'each start replaces the whole rule');
    assert.deepEqual(readdirSync(config).sort(), ['.claude.json', 'rules', 'settings.json']);
    assert.deepEqual(readdirSync(join(config, 'rules')).sort(), ['other.md', 'pstack-models.md']);
    for (const [i, name] of others.entries()) {
      assert.deepEqual(readFileSync(join(config, name)), before[i].bytes);
      const after = statSync(join(config, name));
      for (const key of ['mode', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[i].stat[key], name);
    }
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});
