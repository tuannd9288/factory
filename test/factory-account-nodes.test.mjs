// INN-31 1B/2A: fake stores only; a remote token crosses stdin and never a command argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './factory-world.mjs';

/** The Mac mini's list, run in the far side's own world ($FAKE/far, where the fake ssh runs `factory store` and `use`) with its accounts
 * file, token files and runs, and handed to the fake ssh as its answer; the MacBook's world is then put back. */
function macMini(s, { accounts, tokens = {}, runs = () => {} }) {
  const far = join(s.fake, 'far');
  const saved = { ...s.env };
  mkdirSync(join(far, 'state'), { recursive: true });
  writeFileSync(join(far, 'state/accounts'), accounts, { mode: 0o600 });
  mkdirSync(join(far, '.agent-profiles/tokens'), { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(tokens)) writeFileSync(join(far, '.agent-profiles/tokens', name), `${text}\n`, { mode: 0o600 });
  Object.assign(s.env, { AGENT_PROFILES: join(far, '.agent-profiles'), FACTORY_STATE: join(far, 'state'), FACTORY_RUNS: join(far, 'runs') });
  runs(join(far, 'runs'));
  s.onHost();
  const r = s.fac('account', 'list', '--json');
  assert.equal(r.code, 0, r.out);
  s.w('ssh-factory.json', r.stdout);
  for (const key of Object.keys(s.env)) delete s.env[key];
  Object.assign(s.env, saved);
}

/** A MacBook team row and its account's token, in the MacBook's own world. */
function macBook(s, line, account) {
  writeFileSync(join(s.state, 'accounts'), line, { mode: 0o600 });
  mkdirSync(s.tokens(), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.tokens(), account), `made-up-${account}-token\n`, { mode: 0o600 });
}

const listed = (s, profile) => JSON.parse(s.fac('account', 'list', '--json').stdout).find((r) => r.profile === profile);

test('from the MacBook, the add line printed under a Mac mini row with no token stores the token on the Mac mini, not here (FAC-117)', () => {
  const s = sandbox();
  try {
    macMini(s, { accounts: 'factory/factory-crew=cat\n' });
    const add = listed(s, 'factory/factory-crew').login.split('\n').find((l) => l.startsWith('factory account add '));
    const r = s.facIn('made-up-cat-token', ...add.split(' ').slice(1), '--no-setup');
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(s.fake, 'far/.agent-profiles/tokens/cat')), 'stored on the Mac mini');
    assert.ok(!existsSync(join(s.tokens(), 'cat')), 'not on the MacBook');
  } finally { s.done(); }
});

test('on the MacBook, the use line printed under its own team row changes the MacBook\'s accounts file and reaches no Mac mini (FAC-117)', () => {
  const s = sandbox();
  try {
    macBook(s, 'factory/factory-ops=dan\n', 'ann');
    // ann is the MacBook's only token, so its letter there is a, should the line leave the letter to him.
    const use = listed(s, 'macbook/factory-ops').login.split('\n').find((l) => l.startsWith('factory use ')).replace('<letter>', 'a');
    const before = s.calls().length;
    const r = s.fac(...use.split(' ').slice(1));
    assert.doesNotMatch(s.calls().slice(before), /factory use/, 'no ssh to the Mac mini');
    assert.equal(readFileSync(join(s.state, 'accounts'), 'utf8'), 'factory/factory-ops=ann\n');
    assert.equal(r.code, 0, r.out);
  } finally { s.done(); }
});

test('on the MacBook, an account the Mac mini\'s runs show refused is out on the MacBook\'s rows of it too: one account, one quota (FAC-117)', () => {
  const s = sandbox();
  try {
    const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
    const event = JSON.parse(readFileSync(new URL('./fixtures/quota/real-event.jsonl', import.meta.url), 'utf8'));
    Object.assign(event.rate_limit_info, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
    event.rate_limit_info.unifiedWindows.five_hour = { utilization: 1, resetsAt: reset };
    macMini(s, { accounts: 'factory/factory-pig=ann\n', tokens: { ann: 'made-up-far-ann' }, runs: (dir) => {
      mkdirSync(join(dir, 'issue-1'), { recursive: true });
      writeFileSync(join(dir, 'issue-1/run-w.jsonl'), `{"type":"system","subtype":"init"}\n${JSON.stringify(event)}\n`);
      writeFileSync(join(dir, 'issue-1/run-w.seat'), '2\n');
      writeFileSync(join(dir, 'issue-1/run-w.account'), 'ann\n');
    } });
    macBook(s, 'factory/factory-pig=ann\n', 'ann');
    for (const p of ['factory/factory-pig', 'macbook/factory-pig']) {
      const row = listed(s, p);
      assert.equal(row.state, 'out', p);
      assert.equal(row.outUntil, reset, p);
    }
  } finally { s.done(); }
});

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
    // Each node's account carries its letter there, a spare's included, for `factory use <row> <letter>` (#365 B5).
    const json = s.fac('account', 'list', '--json').stdout;
    const tokenRows = JSON.parse(json).filter((r) => r.role === 'node token');
    assert.deepEqual(tokenRows.map((r) => [r.place, r.account, r.letter]), [['macbook', 'fixture', 'a'], ['factory', 'fixture', 'a']]);
    for (const r of tokenRows) assert.match(r.note, /expiry \d{4}-\d{2}-\d{2}/);
    assert.ok(tokenRows[0].note.includes(`added ${added}; expiry `));
    assert.doesNotMatch(listed.out, /warning/i);
    for (const secret of [local, remote]) assert.ok(!listed.out.includes(secret) && !json.includes(secret));
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

test('account add --node macbook from the Mac mini stores through the MacBook\'s own factory, the link into its installed copy (#366)', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.facIn('made-up-macbook-secret', 'account', 'add', 'fixture', '--node', 'macbook', '--no-setup');
    assert.equal(r.code, 0, r.out);
    assert.match(s.calls(), /factory@macbook zsh -lc '~\/\.local\/bin\/factory store fixture'/);
    assert.equal(readFileSync(join(s.fake, 'far/.agent-profiles/tokens/fixture'), 'utf8'), 'made-up-macbook-secret\n');
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
    assert.ok(rows[0].note.includes(`added ${added}; expiry `));
    writeFileSync(join(s.tokens(), 'legacy'), 'made-up-old-token');
    const legacy = JSON.parse(s.fac('account', 'list', '--json').stdout).find((r) => r.account === 'legacy');
    assert.match(legacy.note, /added unknown; expiry unknown/);
  } finally { s.done(); }
});
