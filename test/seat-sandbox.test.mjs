// bin/seat (#183): the worker's and the reviewer's Bash runs in Claude Code's sandbox, set in the one --settings value buildArgs
// passes; the researcher's settings stay the alerts hook alone. The marker FACTORY_SANDBOX tells the tests they are inside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as seat from '../bin/lib/seat.mjs';
import { until, world } from './seat-world.mjs';
import { matches, rulesAfter } from './bash-rule.mjs';

const RUN = '/r/issue-1';
const WORK = '/r/w';
const HOME = '/h';
const PROFILES = '/p/profiles';
const settingsOf = (args) => JSON.parse(args[args.indexOf('--settings') + 1]);
const build = (role, extra = {}) => seat.buildArgs({ role, run: RUN, home: HOME, work: WORK, ...extra });

for (const role of ['worker', 'reviewer']) {
  test(`${role}: one --settings holds the alerts hook and the sandbox, which fails closed and grants nothing more`, () => {
    const args = build(role);
    assert.equal(args.filter((a) => a === '--settings').length, 1);
    const s = settingsOf(args);
    assert.deepEqual(s.hooks, JSON.parse(seat.ALERTS_SETTINGS).hooks);
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.failIfUnavailable, true);
    assert.equal(s.sandbox.autoAllowBashIfSandboxed, false);
    assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  });

  test(`${role}: the sandbox denies reading the credential folders by absolute path, ~/.config/gh but not all of ~/.config, and reopens nothing`, () => {
    const { filesystem } = settingsOf(build(role)).sandbox;
    assert.deepEqual(filesystem.denyRead, ['/h/.agent-profiles', '/h/.claude', '/h/.claude*', '/h/.codex', '/h/.codex*', '/h/.config/gh', '/h/.ssh', '/h/.local/share/claude']);
    assert.ok(!filesystem.denyRead.includes('/h/.config'));
    assert.equal(Object.hasOwn(filesystem, 'allowRead'), false);
  });

  test(`${role}: the profiles folder is denied when given and absent when not`, () => {
    assert.ok(settingsOf(build(role, { profiles: PROFILES })).sandbox.filesystem.denyRead.includes(PROFILES));
    assert.ok(!settingsOf(build(role)).sandbox.filesystem.denyRead.includes(PROFILES));
  });

  test(`${role}: the sandbox writes only the work folder, the run folder and the temporary folder, and the network is closed`, () => {
    const { sandbox } = settingsOf(build(role));
    assert.deepEqual(sandbox.filesystem.allowWrite, [WORK, RUN, realpathSync(tmpdir())]);
    assert.equal(sandbox.network.strictAllowlist, true);
    assert.deepEqual(sandbox.network.allowedDomains, []);
    assert.equal(sandbox.network.allowLocalBinding, false);
  });

  test(`${role}: the whole sandbox object is pinned, so a key that widens reach fails here`, () => {
    assert.deepEqual(settingsOf(build(role, { profiles: PROFILES })).sandbox, {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ['/h/.agent-profiles', '/h/.claude', '/h/.claude*', '/h/.codex', '/h/.codex*', '/h/.config/gh', '/h/.ssh', '/h/.local/share/claude', PROFILES],
        allowWrite: [WORK, RUN, realpathSync(tmpdir())],
      },
      network: { strictAllowlist: true, allowedDomains: [], allowLocalBinding: false },
      // The one command that runs outside the sandbox (#182), under Codex's own read profile.
      excludedCommands: ['factory codex *'],
    });
  });
}

test('every seat is granted factory codex and still denied codex; a sandboxed seat runs factory codex alone outside its sandbox (#182)', () => {
  for (const role of seat.ROLES) {
    const args = build(role, { profiles: PROFILES });
    assert.ok(rulesAfter(args, '--allowedTools').some((r) => matches(r, 'factory codex --role cross-judge --brief-file /tmp/b.md')), role);
    assert.ok(rulesAfter(args, '--disallowedTools').some((r) => matches(r, 'codex exec -')), role);
    assert.ok(!rulesAfter(args, '--allowedTools').some((r) => matches(r, 'codex exec -')), role);
    const { sandbox } = settingsOf(args);
    // Codex reads its login under the denied profiles folder and needs the network, so the sandbox cannot hold it.
    if (sandbox) assert.deepEqual(sandbox.excludedCommands, ['factory codex *'], role);
  }
});

test('the researcher has the alerts hook alone, byte for byte, and no sandbox key', () => {
  const args = build('researcher', { profiles: PROFILES });
  assert.equal(args[args.indexOf('--settings') + 1], seat.ALERTS_SETTINGS);
  assert.equal(Object.hasOwn(settingsOf(args), 'sandbox'), false);
});

test('of the roles, only the worker and the reviewer get a sandbox', () => {
  for (const role of seat.ROLES) assert.equal(Object.hasOwn(settingsOf(build(role)), 'sandbox'), role === 'worker' || role === 'reviewer', role);
});

test('the session of the worker and the reviewer gets FACTORY_SANDBOX=1, the researcher\'s none, whatever the caller had', async () => {
  const seen = {};
  for (const role of ['worker', 'reviewer', 'researcher']) {
    await world(async (w) => {
      const r = w.start(role, [], { FACTORY_SANDBOX: '1' });
      assert.equal(r.code, 0, r.out + r.err);
      await until(() => existsSync(w.out()) && w.records().length === 1, 'the session');
      seen[role] = w.saw().env.sandbox;
    });
  }
  assert.deepEqual(seen, { worker: '1', reviewer: '1', researcher: null });
});
