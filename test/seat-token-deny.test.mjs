// #178: no role, on either seat, reaches a token: the environment is denied (env, printenv) and so are the tokens folder, the
// archive folder and seat 1's old token file, by absolute path from the profiles folder bin/seat was given, whatever it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, rulesAfter } from './bash-rule.mjs';

const PROFILES = '/srv/agents/profiles';
const READS = [`Read(/${PROFILES}/tokens/**)`, `Read(/${PROFILES}/archive/**)`, `Read(/${PROFILES}/seats/1/oauth-token)`];

test('every role and seat denies the environment and the tokens, the archive and the old seat 1 file', async () => {
  const { buildArgs, ROLES } = await import('../bin/lib/seat.mjs');
  for (const role of ROLES) {
    for (const seat of [1, 2]) {
      const deny = rulesAfter(buildArgs({ role, run: '/r', home: '/h', seat, profiles: PROFILES }), '--disallowedTools');
      for (const rule of READS) assert.ok(deny.includes(rule), `${role}, seat ${seat}: ${rule}`);
      for (const command of ['env', 'printenv', 'printenv CLAUDE_CODE_OAUTH_TOKEN', 'env -0']) assert.ok(deny.some((r) => matches(r, command)), `${role}, seat ${seat}: ${command}`);
    }
  }
});

test('the rules name the profiles folder it was given, so a folder other than ~/.agent-profiles is covered', async () => {
  const { buildArgs } = await import('../bin/lib/seat.mjs');
  const deny = rulesAfter(buildArgs({ role: 'worker', run: '/r', home: '/h', seat: 2, profiles: '/other/place' }), '--disallowedTools');
  assert.ok(deny.includes('Read(//other/place/tokens/**)'));
  assert.ok(!deny.includes(READS[0]));
});
