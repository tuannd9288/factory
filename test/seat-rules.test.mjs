// bin/seat (#181): what each role's rules let a session run, read the way Claude Code's permissions page says Bash rules are
// read. A rule matches the whole command text; `*` stands for any text, spaces included; a trailing ` *`, or `:*`, also
// matches the bare command. Claude Code runs read-only commands, git's read-only forms among them, with no allow rule at
// all, so only a matching deny rule keeps one from running. A probe on a seat ran the first two git commands below under
// the researcher's old grants (2026-10-30, ~/factory-runs/issue-181/run-probe-git-before.jsonl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { matches, rulesAfter as rules } from './bash-rule.mjs';

const lib = () => import('../bin/lib/seat.mjs');
const RG = join(factory, 'bin/research-git');

const denied = (args, command) => rules(args, '--disallowedTools').some((r) => matches(r, command));
const allowed = (args, command) => !denied(args, command) && rules(args, '--allowedTools').some((r) => matches(r, command));

test('the matcher reads the permissions page\'s own examples as the page does', () => {
  for (const [rule, yes, no] of [
    ['Bash(ls *)', ['ls -la', 'ls'], ['lsof']],
    ['Bash(ls:*)', ['ls -la', 'ls'], ['lsof']],
    ['Bash(ls*)', ['ls -la', 'lsof'], []],
    ['Bash(git * main)', ['git merge main', 'git push origin main', 'git -c core.fsmonitor=<script> diff main'], ['git log']],
    ['Bash(git log * main)', ['git log --oneline main', 'git log --output=<file> main'], ['git log main', 'git push origin main']],
    ['Bash(npm run build)', ['npm run build'], ['npm run build --watch']],
  ]) {
    for (const command of yes) assert.equal(matches(rule, command), true, `${rule} ${command}`);
    for (const command of no) assert.equal(matches(rule, command), false, `${rule} ${command}`);
  }
});

test('no role can run env or printenv, on either seat: a deny rule matches them', async () => {
  const { buildArgs, ROLES } = await lib();
  for (const role of ROLES) {
    for (const seat of [1, 2]) {
      const args = buildArgs({ role, run: '/r', home: '/h', seat, tokenPath: seat === 1 ? '/p/seats/1/oauth-token' : null });
      for (const command of ['env', 'env -0', 'printenv', 'printenv CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(denied(args, command), `${role}, seat ${seat}: ${command}`);
    }
  }
});

test('the researcher runs no git of its own: a deny rule matches every form, the probe\'s two among them', async () => {
  const { buildArgs } = await lib();
  const args = buildArgs({ role: 'researcher', run: '/r', home: '/h' });
  for (const command of [
    'git -C /r/clone -c alias.x="!cat /p/seats/1/oauth-token" x',
    'git -C /r/clone log --output=/tmp/x',
    'git -C /r grep --no-index token /p/seats/1/oauth-token',
    'git clone --upload-pack="touch /tmp/x" https://example.com/r.git',
    'git log',
    'git -C /r/clone show HEAD:f',
  ]) assert.ok(denied(args, command), command);
});

test('the researcher runs bin/research-git by its absolute path', async () => {
  const { buildArgs } = await lib();
  const args = buildArgs({ role: 'researcher', run: '/r', home: '/h' });
  for (const command of [`${RG} clone --depth 1 https://example.com/r.git`, `${RG} -C /r/clone log --oneline`]) assert.ok(allowed(args, command), command);
});
