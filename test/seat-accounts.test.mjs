// #178: bin/seat takes each session's token from the account its seat's row names in $FACTORY_STATE/accounts, from
// $AGENT_PROFILES/tokens/<account>, and never starts a session on a seat whose account differs from its team's. Fixture
// folders, a fake claude and fake tokens only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder, rejected, until, world } from './seat-world.mjs';

const TWO = 'fake-token-two-9876543210-do-not-leak';
const OLD = 'old-seat-one-token-must-not-be-used';
const DIFFERENT = 'factory/seat-1=acct-one\nfactory/seat-2=acct-two\n';
const started = (w) => readdirSync(w.run).filter((n) => n !== 'BRIEF.md');

/** Two accounts, each with a token file, and seat 1's old file in its place. */
function split(w) {
  w.accounts(DIFFERENT);
  writeFileSync(w.tokenOf('acct-two'), `${TWO}\n`, { mode: 0o600 });
  mkdirSync(join(w.profiles, 'seats/1'), { recursive: true });
  writeFileSync(join(w.profiles, 'seats/1/oauth-token'), `${OLD}\n`);
}

test('a session on seat 2 gets the token of seat 2\'s account, and a resume on seat 1 the token of seat 1\'s', () => world(async (w) => {
  split(w);
  const two = w.start('worker', ['--tag', 'two']);
  assert.equal(two.code, 0, two.out + two.err);
  assert.match(two.out, /on seat 2/);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.saw().env.token, TWO);
  const one = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'one'], { FAKE_OUT: w.out('one') });
  assert.equal(one.code, 0, one.out + one.err);
  await until(() => w.records().length === 2, 'the second record');
  assert.equal(w.saw('one').env.token, 'fake-token-0123456789-do-not-leak');
}));

test('seats/1/oauth-token is read no more; the token is in no argument, log, record, pid file or output', () => world(async (w) => {
  split(w);
  const r = w.start('worker', ['--tag', 'x']);
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const saw = w.saw();
  assert.equal(saw.env.token, TWO);
  assert.notEqual(saw.env.token, OLD);
  assert.ok(!saw.argv.some((a) => a.includes(TWO)));
  assert.equal(saw.parentHasToken, false, 'the supervisor\'s environment holds no token');
  for (const [file, text] of [...filesUnder(w.run), ...filesUnder(w.state)]) assert.ok(!text.includes(TWO), `${file} holds the token`);
  assert.ok(!(r.out + r.err).includes(TWO));
}));

test('the old seat 1 file alone does not start seat 1: with no token for its account, the session is refused', () => world((w) => {
  split(w);
  rmSync(w.tokenFile);
  const r = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'x']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /factory login acct-one/);
  assert.deepEqual(started(w), []);
}));

test('a seat with no row in the accounts file starts nothing and names factory use', () => world((w) => {
  w.accounts('factory/seat-1=acct-one\n');
  const r = w.start('worker', ['--tag', 'x']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /seat 2.*factory use/s);
  assert.deepEqual(started(w), []);
  rmSync(join(w.state, 'accounts'));
  const none = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'y']);
  assert.equal(none.code, 2, none.out + none.err);
  assert.match(none.out + none.err, /seat 1.*factory use/s);
  assert.deepEqual(started(w), []);
}));

test('a seat whose account has no token file starts nothing and names factory login <account>', () => world((w) => {
  w.accounts(DIFFERENT);
  const r = w.start('worker', ['--tag', 'x']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /factory login acct-two/);
  assert.deepEqual(started(w), []);
  assert.equal(w.records().length, 0);
}));

test('after the account\'s token file is moved away (logout) every row naming it is refused', () => world((w) => {
  mkdirSync(join(w.profiles, 'archive/tokens'), { recursive: true });
  renameSync(w.tokenFile, join(w.profiles, 'archive/tokens/20261031T000000Z-acct-one'));
  for (const seat of ['1', '2']) {
    const r = w.start('worker', ['--resume', 'sid-1', '--seat', seat, '--tag', `s${seat}`]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out + r.err, /factory login acct-one/, `seat ${seat}`);
  }
  assert.deepEqual(started(w), []);
}));

test('the researcher, which runs on seat 2 only, takes seat 2\'s account', () => world(async (w) => {
  split(w);
  const r = w.start('researcher', ['--tag', 'res']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /on seat 2/);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.saw().env.token, TWO);
}));

test('one account for a team: a rejected seat 2 is waited for, not replaced by seat 1 of another account; the refusal names the reset and points to factory and factory use', () => world((w) => {
  split(w);
  rejected(w, 2, 'old2', 3600);
  const r = w.start('worker', ['--tag', 'x']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /seat 2: rejected by Claude Code \(five-hour window\) until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(r.out + r.err, /seat 1: .*account/);
  assert.match(r.out + r.err, /no seat free/);
  assert.match(r.out + r.err, /`factory`.*`factory use`/s);
  assert.deepEqual(started(w).filter((n) => !n.startsWith('run-old2')), []);
}));

test('a resume whose own seat is rejected stays refused, and does not move to the other seat', () => world((w) => {
  split(w);
  rejected(w, 1, 'old1', 3600);
  const r = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'x']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /seat 1: rejected by Claude Code/);
  assert.deepEqual(started(w).filter((n) => !n.startsWith('run-old1')), []);
}));

test('two seats on one account: seat 2 rejected, the session goes to seat 1 with the shared token', () => world(async (w) => {
  rejected(w, 2, 'old2', 3600);
  const r = w.start('worker', ['--tag', 'x']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /on seat 1/);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.saw().env.token, 'fake-token-0123456789-do-not-leak');
}));

test('chooseSeat with the seats\' accounts passes over a seat of another account, with a reason, and never starts there', async () => {
  const { chooseSeat } = await import('../bin/lib/seat.mjs');
  await world((w) => {
    assert.deepEqual(chooseSeat({ runs: w.runs, accounts: { 1: 'a', 2: 'a' } }), { seat: 2, reasons: [] });
    rejected(w, 2, 'old2', 3600);
    const next = chooseSeat({ runs: w.runs, accounts: { 1: 'a', 2: 'a' } });
    assert.equal(next.seat, 1);
    assert.match(next.reasons[0], /^seat 2: rejected by Claude Code/);
    const split_ = chooseSeat({ runs: w.runs, accounts: { 1: 'b', 2: 'a' } });
    assert.equal(split_.seat, null);
    assert.equal(split_.reasons.length, 2);
    assert.match(split_.reasons[1], /^seat 1: its account is not the team's/);
    assert.deepEqual(chooseSeat({ runs: w.runs, resumeSeat: 1, accounts: { 1: 'b', 2: 'a' } }), { seat: 1, reasons: [] }, 'a resume\'s team is its own seat\'s account');
    assert.equal(chooseSeat({ runs: w.runs, accounts: { 2: 'a' } }).seat, null, 'a seat with no account is not the team\'s');
  });
});
