// bin/seat (#185): the copies of a Lead's transcripts are the Lead's own. Every seat role is denied a Read of them; the Lead's deny
// list does not carry the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leadArgs } from '../packs/pstack/bin/lead.mjs';

const RULE = 'Read(~/factory-runs/*/transcripts/**)'; // a team's folder is <repo>-<team>, not only <repo>-lead (#196)
const denied = (args) => args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--output-format'));

test('the deny covers the transcripts of any team\'s folder, and a seat\'s own run log stays readable (#196)', async () => {
  const glob = /^Read\(~\/(.*)\)$/.exec(RULE)[1];
  // `*` is one path segment and `**` the rest, as in a gitignore pattern
  const re = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
  for (const folder of ['zalo-lead', 'zalo-b', 'factory-probe-pstack']) assert.ok(re.test(`factory-runs/${folder}/transcripts/s.jsonl`), folder);
  assert.ok(!re.test('factory-runs/issue-196/run-worker.jsonl'));
});

test('heldNames reads the name file of every folder under the runs folder, a team\'s included (#196)', async () => {
  const { heldNames } = await import('../bin/lib/seat.mjs');
  const runs = mkdtempSync(join(tmpdir(), 'held-'));
  try {
    for (const [folder, name] of [['zalo-lead', 'aardvark'], ['zalo-b', 'badger'], ['issue-196', 'beaver']]) {
      mkdirSync(join(runs, folder));
      writeFileSync(join(runs, folder, 'name'), `${name}\n`);
    }
    mkdirSync(join(runs, 'factory-5'));
    assert.deepEqual(heldNames(runs).sort(), ['aardvark', 'badger', 'beaver']);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

test('every seat role, on either seat, is denied the Lead\'s transcript copies; the Lead is not', async () => {
  const { ROLES, buildArgs } = await import('../bin/lib/seat.mjs');
  assert.deepEqual(ROLES.length > 0, true);
  for (const role of ROLES) {
    for (const seat of [1, 2]) assert.ok(denied(buildArgs({ role, run: '/r', home: '/h', work: '/w', seat, tokenPath: '/p/oauth-token' })).includes(RULE), `${role} on seat ${seat}`);
  }
  const { argv } = leadArgs({ repo: 'zalo', home: '/h', root: '/fx/WORKSPACES', roleText: 'x', node: '/usr/bin/node' });
  assert.ok(!argv.slice(argv.indexOf('--disallowedTools') + 1).includes(RULE));
});
