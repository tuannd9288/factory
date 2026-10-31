// #177: no agent runs `factory login` or `factory store`: every role of bin/seat denies them, on either seat, in each form a
// session could type: by name, by a relative or an absolute path, after other words. The matcher is the one seat-rules.test.mjs
// reads Claude Code's permissions page with (bash-rule.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, rulesAfter } from './bash-rule.mjs';
import { FORMS, HARMLESS } from './login-forms.mjs';

test('every role denies factory login and factory store, in every form', async () => {
  const { buildArgs, ROLES } = await import('../bin/lib/seat.mjs');
  for (const role of ROLES) {
    for (const seat of [1, 2]) {
      const args = buildArgs({ role, run: '/r', home: '/h', seat, tokenPath: seat === 1 ? '/p/seats/1/oauth-token' : null });
      const deny = rulesAfter(args, '--disallowedTools');
      for (const command of FORMS) assert.ok(deny.some((r) => matches(r, command)), `${role}, seat ${seat}: ${command}`);
      for (const command of HARMLESS) assert.ok(!deny.some((r) => matches(r, command)), `${role}, seat ${seat} denies ${command}`);
    }
  }
});
