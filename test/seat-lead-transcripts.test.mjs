// bin/seat (#185): the copies of a Lead's transcripts are the Lead's own. Every seat role is denied a Read of them; the Lead's deny
// list does not carry the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadArgs } from '../packs/pstack/bin/lead.mjs';

const RULE = 'Read(~/factory-runs/*-lead/transcripts/**)';
const denied = (args) => args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--output-format'));

test('every seat role, on either seat, is denied the Lead\'s transcript copies; the Lead is not', async () => {
  const { ROLES, buildArgs, leadTranscripts } = await import('../bin/lib/seat.mjs');
  assert.equal(leadTranscripts, RULE);
  assert.deepEqual(ROLES.length > 0, true);
  for (const role of ROLES) {
    for (const seat of [1, 2]) assert.ok(denied(buildArgs({ role, run: '/r', home: '/h', work: '/w', seat, tokenPath: '/p/oauth-token' })).includes(RULE), `${role} on seat ${seat}`);
  }
  const { argv } = leadArgs({ repo: 'zalo', home: '/h', root: '/fx/WORKSPACES', roleText: 'x' });
  assert.ok(!argv.slice(argv.indexOf('--disallowedTools') + 1).includes(RULE));
});
