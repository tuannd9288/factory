// #311 (after #178): bin/seat runs every session on the account of its team's row, factory/<repo>-<team> in $FACTORY_STATE/accounts,
// where the team is FACTORY_TEAM, and takes the token from $AGENT_PROFILES/tokens/<account>. With no team, a malformed one or a team
// with no row it starts nothing. "Out" is judged per account, and a session never runs on another account. Fixture folders, a fake
// claude and fake tokens only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skipPs } from './ps-skip.mjs';
import { filesUnder, rejected, rejectedOn, until, world } from './seat-world.mjs';

const TWO = 'fake-token-two-9876543210-do-not-leak';
const OLD = 'old-seat-one-token-must-not-be-used';
const ONE = 'fake-token-0123456789-do-not-leak';
// Two teams of one repository on two accounts, and the factory's own team on the first. The seat rows are old lines of the file.
const TEAMS = 'factory/factory-lead=acct-one\nfactory/probe-alpha=acct-two\nfactory/probe-beta=acct-one\nfactory/seat-1=acct-one\nfactory/seat-2=acct-one\n';
const started = (w) => readdirSync(w.run).filter((n) => n !== 'BRIEF.md');
const text = (w, tag, ext) => readFileSync(join(w.run, `run-${tag}.${ext}`), 'utf8').trim();

/** Two accounts, each with a token file, the teams' rows, and seat 1's old file in its place. */
function split(w) {
  w.accounts(TEAMS);
  writeFileSync(w.tokenOf('acct-two'), `${TWO}\n`, { mode: 0o600 });
  mkdirSync(join(w.profiles, 'seats/1'), { recursive: true });
  writeFileSync(join(w.profiles, 'seats/1/oauth-token'), `${OLD}\n`);
}

test('a session runs on its team\'s row: that account\'s token, run-<tag>.account, and a record that names the team and the account (#311)', () => world(async (w) => {
  split(w);
  const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'probe-alpha' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const saw = w.saw();
  assert.equal(saw.env.token, TWO);
  assert.notEqual(saw.env.token, OLD);
  assert.equal(text(w, 'x', 'account'), 'acct-two');
  assert.equal(w.records()[0].team, 'probe-alpha');
  assert.equal(w.records()[0].account, 'acct-two');
}));

test('the token is in no argument, log, record, pid file or output (#311)', () => world(async (w) => {
  split(w);
  const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'probe-alpha' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const saw = w.saw();
  assert.ok(!saw.argv.some((a) => a.includes(TWO)));
  // The fake reads its parent with ps, which the sandbox refuses (#183): there the parent is empty, and only there may it be unread.
  assert.ok(saw.parentSeen || skipPs, 'the fake could read its parent\'s environment');
  assert.equal(saw.parentHasToken, false, 'the supervisor\'s environment holds no token');
  for (const [file, body] of [...filesUnder(w.run), ...filesUnder(w.state)]) assert.ok(!body.includes(TWO), `${file} holds the token`);
  assert.ok(!(r.out + r.err).includes(TWO));
}));

test('two teams on two accounts at once: each session has its own team\'s token and account (#311)', () => world(async (w) => {
  split(w);
  const first = w.start('worker', ['--tag', 'a'], { FACTORY_TEAM: 'factory-lead', FAKE_OUT: w.out('a') });
  const second = w.start('worker', ['--tag', 'b'], { FACTORY_TEAM: 'probe-alpha', FAKE_OUT: w.out('b') });
  assert.equal(first.code, 0, first.out + first.err);
  assert.equal(second.code, 0, second.out + second.err);
  await until(() => w.records().length === 2, 'the two records');
  assert.equal(w.saw('a').env.token, ONE);
  assert.equal(w.saw('b').env.token, TWO);
  assert.deepEqual(w.records().map((x) => [x.team, x.account]).sort(), [['factory-lead', 'acct-one'], ['probe-alpha', 'acct-two']]);
}));

test('no FACTORY_TEAM, a malformed one, or a team with no row: refused before anything is claimed, naming what is missing (#311)', () => world((w) => {
  split(w);
  const none = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: null });
  assert.equal(none.code, 2, none.out + none.err);
  assert.match(none.err, /FACTORY_TEAM/);
  for (const bad of ['probe', 'probe-Alpha', '-alpha', 'probe-', 'a b-c', 'probe-1a', 'seat-1']) {
    const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: bad });
    assert.equal(r.code, 2, `${bad}: ${r.out}${r.err}`);
    assert.match(r.err, /FACTORY_TEAM.*<repo>-<team>/s, bad);
  }
  const unknown = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'probe-gamma' });
  assert.equal(unknown.code, 2, unknown.out + unknown.err);
  assert.match(unknown.err, /probe-gamma.*no row.*factory use probe-gamma/s);
  assert.deepEqual(started(w), [], 'nothing was claimed');
  assert.equal(w.records().length, 0);
}));

test('an old factory/lead-<repo> line is no team: FACTORY_TEAM=lead-<repo> is refused before anything is claimed, naming the repository (#311)', () => world((w) => {
  w.onboard('alpha');
  w.accounts('factory/lead-alpha=acct-one\n');
  const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'lead-alpha' });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /\blead\b.*not an onboarded repository/);
  assert.deepEqual(started(w), [], 'the run folder stays empty');
  assert.equal(w.records().length, 0);
}));

test('a row of a repository that is not onboarded starts nothing: refused before anything is claimed, naming the repository (#311)', () => world((w) => {
  w.accounts('factory/nosuchrepo-lead=acct-one\nfactory/probe-lead=acct-one\nfactory/factory-lead=acct-one\n');
  const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'nosuchrepo-lead' });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /nosuchrepo.*not an onboarded repository/);
  assert.deepEqual(started(w), []);
  assert.equal(w.start('worker', ['--tag', 'y'], { FACTORY_TEAM: 'probe-lead' }).code, 0, 'an onboarded repository is accepted');
  assert.equal(w.start('worker', ['--tag', 'z'], { FACTORY_TEAM: 'factory-lead' }).code, 0, 'and so is the factory, which has no folder');
}));

test('the refusal of a start with no FACTORY_TEAM names the restart of the Lead; one with a malformed value does not quote it (#311)', () => world((w) => {
  const none = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: null });
  assert.equal(none.code, 2, none.out + none.err);
  assert.match(none.err, /factory lead <repo> \[--team <team>\]/);
  const bad = w.start('worker', ['--tag', 'y'], { FACTORY_TEAM: 'sk-ant-oat01-SECRETSECRET' });
  assert.equal(bad.code, 2, bad.out + bad.err);
  assert.match(bad.err, /FACTORY_TEAM.*<repo>-<team>/s);
  assert.ok(!(bad.out + bad.err).includes('SECRETSECRET'), 'the value does not come back');
  assert.deepEqual(started(w), []);
}));

test('an account name in the row that is not a plain account name is refused before a token path is built (#311)', () => world((w) => {
  w.accounts('factory/factory-lead=../acct-one\n');
  mkdirSync(join(w.profiles, 'x'), { recursive: true });
  writeFileSync(join(w.profiles, 'x/acct-one'), `${TWO}\n`);
  const r = w.start('worker', ['--tag', 'x']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /account/);
  assert.ok(!(r.out + r.err).includes('../acct-one'), 'the name is not quoted');
  assert.deepEqual(started(w), []);
}));

test('the seat rows are not read: with only factory/seat-N in the file, every start is refused (#311)', () => world((w) => {
  w.accounts('factory/seat-1=acct-one\nfactory/seat-2=acct-one\n');
  for (const team of ['seat-1', 'factory-lead', null]) {
    const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: team });
    assert.equal(r.code, 2, `${team}: ${r.out}${r.err}`);
  }
  const resume = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'y']);
  assert.equal(resume.code, 2, resume.out + resume.err);
  assert.deepEqual(started(w), []);
}));

test('a team whose account has no token file starts nothing and names factory account add <account> (#311)', () => world((w) => {
  w.accounts(TEAMS);
  const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'probe-alpha' });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out + r.err, /factory account add acct-two/);
  assert.deepEqual(started(w), []);
  assert.equal(w.records().length, 0);
}));

test('after the account\'s token file is moved away (logout) every team naming it is refused (#311)', () => world((w) => {
  w.accounts(TEAMS);
  mkdirSync(join(w.profiles, 'archive/tokens'), { recursive: true });
  renameSync(w.tokenFile, join(w.profiles, 'archive/tokens/20261031T000000Z-acct-one'));
  for (const team of ['factory-lead', 'probe-beta']) {
    const r = w.start('worker', ['--tag', `t-${team}`], { FACTORY_TEAM: team });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out + r.err, /factory account add acct-one/, team);
  }
  assert.deepEqual(started(w), []);
}));

test('a new session takes the first seat of its role\'s list; the researcher\'s only seat is 2, on its team\'s account (#311)', () => world(async (w) => {
  split(w);
  const worker = w.start('worker', ['--tag', 'w'], { FACTORY_TEAM: 'probe-alpha' });
  assert.match(worker.out, /on seat 2/);
  const res = w.start('researcher', ['--tag', 'res'], { FACTORY_TEAM: 'probe-alpha', FAKE_OUT: w.out('res') });
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /on seat 2/);
  await until(() => w.records().length === 2, 'the records');
  assert.equal(w.saw('res').env.token, TWO);
}));

test('a resume keeps its seat, and runs on its team\'s account whatever the seat\'s old row says (#311)', () => world(async (w) => {
  split(w);
  const r = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'one'], { FACTORY_TEAM: 'probe-alpha' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /on seat 1/);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(text(w, 'one', 'seat'), '1');
  assert.equal(text(w, 'one', 'account'), 'acct-two');
  assert.equal(w.saw().env.token, TWO);
  assert.equal(w.saw().env.config, join(w.profiles, 'seats/1/claude'));
}));

test('a rejection on account A refuses team A, naming the account and the reset, while team B on account B starts (#311)', () => world(async (w) => {
  split(w);
  rejectedOn(w, 'acct-one', 'old1', 3600);
  const r = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'factory-lead' });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /acct-one: rejected by Claude Code \(five-hour window\) until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(r.err, /`factory`.*`factory use`/s);
  assert.doesNotMatch(r.err, /seat 1/, 'it is not tried on another seat');
  assert.deepEqual(started(w).filter((n) => !n.startsWith('run-old1')), []);
  const other = w.start('worker', ['--tag', 'y'], { FACTORY_TEAM: 'probe-alpha' });
  assert.equal(other.code, 0, other.out + other.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.saw().env.token, TWO);
}));

test('a team on the rejected account is refused on every seat, and a resume stays refused (#311)', () => world((w) => {
  split(w);
  rejectedOn(w, 'acct-one', 'old1', 3600);
  const sibling = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'probe-beta' });
  assert.equal(sibling.code, 2, 'a second team of the same account is out too');
  const resume = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'y'], { FACTORY_TEAM: 'factory-lead' });
  assert.equal(resume.code, 2, resume.out + resume.err);
  assert.match(resume.err, /acct-one: rejected by Claude Code/);
}));

test('a run from before #311, with no .account file, counts under the account its seat\'s row names; with no such row, under none (#311)', () => world((w) => {
  split(w);
  w.accounts(TEAMS.replace('factory/seat-2=acct-one', 'factory/seat-2=acct-two'));
  rejected(w, 2, 'old2', 3600); // seat 2's row names acct-two
  const one = w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'factory-lead' });
  assert.equal(one.code, 0, 'acct-one is not out: the old run was acct-two\'s');
  const two = w.start('worker', ['--tag', 'y'], { FACTORY_TEAM: 'probe-alpha' });
  assert.equal(two.code, 2, two.out + two.err);
  assert.match(two.err, /acct-two: rejected by Claude Code/);
  w.accounts(TEAMS.replace('factory/seat-2=acct-one\n', ''));
  const gone = w.start('worker', ['--tag', 'z'], { FACTORY_TEAM: 'probe-alpha' });
  assert.equal(gone.code, 0, `the row is gone, so the old run counts for no account: ${gone.out}${gone.err}`);
}));

test('a run\'s own .account file wins over its seat\'s row (#311)', () => world((w) => {
  split(w);
  rejectedOn(w, 'acct-two', 'old2', 3600, 2); // seat 2's old row says acct-one, the run's file acct-two
  assert.equal(w.start('worker', ['--tag', 'x'], { FACTORY_TEAM: 'factory-lead' }).code, 0);
  assert.equal(w.start('worker', ['--tag', 'y'], { FACTORY_TEAM: 'probe-alpha' }).code, 2);
}));

test('a missing team row names Colly on the Human\'s spoken word in the refusal (#365)', () => world((w) => {
  const r = w.start('worker', [], { FACTORY_TEAM: 'probe-gamma' });
  assert.equal(r.code, 2);
  assert.match(r.err, /the Human or Colly on his spoken word sets one with `factory use probe-gamma <letter>` \(INN-30, 2026-11-05\)/);
}));

test('chooseSeat takes the first seat of the list, judges the account, and never moves a session to another seat or account (#311)', async () => {
  const { chooseSeat } = await import('../bin/lib/seat.mjs');
  await world((w) => {
    assert.deepEqual(chooseSeat({ runs: w.runs, account: 'acct-one' }), { seat: 2, reasons: [] });
    assert.deepEqual(chooseSeat({ runs: w.runs, account: 'acct-one', seats: [1] }), { seat: 1, reasons: [] });
    assert.deepEqual(chooseSeat({ runs: w.runs, account: 'acct-one', resumeSeat: 1 }), { seat: 1, reasons: [] });
    rejectedOn(w, 'acct-one', 'old1', 3600);
    const out = chooseSeat({ runs: w.runs, account: 'acct-one' });
    assert.equal(out.seat, null);
    assert.equal(out.reasons.length, 1);
    assert.match(out.reasons[0], /^acct-one: rejected by Claude Code/);
    assert.equal(chooseSeat({ runs: w.runs, account: 'acct-one', resumeSeat: 2 }).seat, null);
    assert.equal(chooseSeat({ runs: w.runs, account: 'acct-two' }).seat, 2, 'another account is not out');
  });
});
