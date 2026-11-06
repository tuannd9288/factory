// INN-31 1B/2A: fake stores only; a remote token crosses stdin and never a command argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './factory-world.mjs';

test('account add defaults locally and sends only the selected node its token', () => {
  const s = sandbox();
  const local = 'made-up-local-secret';
  const remote = 'made-up-remote-secret';
  try {
    let r = s.facIn(local, 'account', 'add', 'fixture', '--no-setup');
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(s.tokens(), 'fixture'), 'utf8'), `${local}\n`);
    const added = readFileSync(join(s.tokens(), '.fixture.added'), 'utf8').trim();
    assert.match(added, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(s.modeOf(join(s.tokens(), '.fixture.added')), '600');
    // Changing the token's mtime must not change the date reported from the sidecar.
    utimesSync(join(s.tokens(), 'fixture'), new Date(0), new Date(0));
    assert.ok(!s.calls().includes('ssh '));
    r = s.facIn(remote, 'account', 'add', 'fixture', '--node', 'tuans-mac-mini', '--no-setup');
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(s.fake, 'far/.agent-profiles/tokens/fixture'), 'utf8'), `${remote}\n`);
    assert.equal(readFileSync(join(s.tokens(), 'fixture'), 'utf8'), `${local}\n`);
    for (const secret of [local, remote]) {
      assert.ok(!s.calls().includes(secret));
      assert.ok(!r.out.includes(secret));
      assert.equal(s.holders(secret).length, 1);
    }
    const homeProfiles = s.env.AGENT_PROFILES;
    s.env.AGENT_PROFILES = join(s.fake, 'far/.agent-profiles');
    s.onHost();
    const farRows = s.fac('account', 'list', '--json');
    assert.equal(farRows.code, 0, farRows.out);
    s.w('ssh-factory.json', farRows.stdout);
    s.env.AGENT_PROFILES = homeProfiles;
    s.env.FACTORY_HOST_USER = 'nobody-here';
    const listed = s.fac('account', 'list');
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, /macbook  fixture.*expiry unknown/);
    assert.match(listed.out, /tuans-mac-mini  fixture.*expiry unknown/);
    assert.ok(listed.out.includes(`added ${added}; expiry unknown`));
    assert.doesNotMatch(listed.out, /expires|warning/i);
    for (const secret of [local, remote]) assert.ok(!listed.out.includes(secret));
    for (const [old, next] of [['login', 'add'], ['logout', 'remove']]) {
      const refused = s.fac(old, 'fixture');
      assert.equal(refused.code, 2);
      assert.equal(refused.out.trim().split('\n').length, 1);
      assert.match(refused.out, new RegExp(`factory account ${next}`));
    }
    r = s.facIn(remote, 'account', 'add', 'fixture', '--node', 'invalid;node', '--no-setup');
    assert.equal(r.code, 2);
    assert.equal(s.fac('account', 'remove', 'fixture').code, 0);
    assert.ok(!existsSync(join(s.tokens(), 'fixture')));
    assert.ok(!existsSync(join(s.tokens(), '.fixture.added')));
    const archive = join(s.env.AGENT_PROFILES, 'archive/tokens');
    const dates = readdirSync(archive).filter((name) => name.endsWith('.added'));
    assert.equal(dates.length, 1);
    assert.equal(readFileSync(join(archive, dates[0]), 'utf8').trim(), added);
    assert.ok(existsSync(join(s.fake, 'far/.agent-profiles/tokens/fixture')));
  } finally { s.done(); }
});


test('an older token has an unknown added date until replaced; metadata never becomes an account', () => {
  const s = sandbox();
  try {
    s.onHost();
    assert.equal(s.facIn('made-up-first-token', 'account', 'add', 'fixture', '--no-setup').code, 0);
    writeFileSync(join(s.tokens(), '.fixture.added'), '2000-01-01\n');
    assert.equal(s.facIn('made-up-replacement-token', 'account', 'add', 'fixture', '--no-setup').code, 0);
    const added = readFileSync(join(s.tokens(), '.fixture.added'), 'utf8').trim();
    assert.notEqual(added, '2000-01-01');
    const rows = JSON.parse(s.fac('account', 'list', '--json').stdout).filter((r) => r.role === 'node token');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].note.includes(`added ${added}; expiry unknown`));
    writeFileSync(join(s.tokens(), 'legacy'), 'made-up-old-token');
    const legacy = JSON.parse(s.fac('account', 'list', '--json').stdout).find((r) => r.account === 'legacy');
    assert.match(legacy.note, /added unknown; expiry unknown/);
  } finally { s.done(); }
});
