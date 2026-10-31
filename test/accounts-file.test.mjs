// #178: the accounts file ($FACTORY_STATE/accounts, "<profile>=<account>" a line) and the moves of a token file into the archive,
// in bin/lib/token.mjs. Fixture folders only; every name and token below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lib = () => import('../bin/lib/token.mjs');
const mode = (p) => (statSync(p).mode & 0o777).toString(8);

function dirs(body) {
  const root = mkdtempSync(join(tmpdir(), 'accounts-file-'));
  const state = join(root, 'state');
  const profiles = join(root, 'profiles');
  mkdirSync(state);
  mkdirSync(profiles);
  try {
    return body({ root, state, profiles });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('readAccounts reads "<profile>=<account>" lines, skips comments and blanks, and is empty without a file', async () => {
  const { readAccounts } = await lib();
  dirs(({ state }) => {
    assert.deepEqual(readAccounts(state), {});
    writeFileSync(join(state, 'accounts'), '# note\n\nfactory/seat-1=ann\n factory/seat-2 = bob \nfactory/lead-alpha=ann\nbad line\n=x\nfactory/x=\n');
    assert.deepEqual(readAccounts(state), { 'factory/seat-1': 'ann', 'factory/seat-2': 'bob', 'factory/lead-alpha': 'ann' });
  });
});

test('setAccount writes through a temporary file and a rename, mode 600, keeps the other lines and comments, and leaves no temporary file', async () => {
  const { readAccounts, setAccount } = await lib();
  dirs(({ state }) => {
    writeFileSync(join(state, 'accounts'), '# mine\nfactory/seat-1=ann\nfactory/seat-2=bob\n', { mode: 0o644 });
    setAccount(state, 'factory/seat-2', 'cat');
    assert.equal(readFileSync(join(state, 'accounts'), 'utf8'), '# mine\nfactory/seat-1=ann\nfactory/seat-2=cat\n');
    assert.equal(mode(join(state, 'accounts')), '600');
    setAccount(state, 'factory/lead-alpha', 'ann');
    assert.deepEqual(readAccounts(state), { 'factory/seat-1': 'ann', 'factory/seat-2': 'cat', 'factory/lead-alpha': 'ann' });
    assert.deepEqual(readdirSync(state), ['accounts'], 'no temporary name is left');
  });
});

test('setAccount makes the file, and the folder, when there are none', async () => {
  const { readAccounts, setAccount } = await lib();
  dirs(({ root }) => {
    const state = join(root, 'new/state');
    setAccount(state, 'factory/seat-1', 'ann');
    assert.deepEqual(readAccounts(state), { 'factory/seat-1': 'ann' });
    assert.equal(mode(join(state, 'accounts')), '600');
  });
});

test('seatAccounts is the seats\' accounts as { 1, 2 } from the file', async () => {
  const { seatAccounts } = await lib();
  dirs(({ state }) => {
    writeFileSync(join(state, 'accounts'), 'factory/seat-1=ann\nfactory/seat-2=bob\nfactory/lead-alpha=cat\n');
    assert.deepEqual(seatAccounts(state), { 1: 'ann', 2: 'bob' });
  });
});

test('archiveToken moves tokens/<account> to archive/tokens/<UTC stamp>-<account> by rename, in a folder of mode 700, and returns the new path', async () => {
  const { archiveToken, tokenDir } = await lib();
  dirs(({ profiles }) => {
    mkdirSync(tokenDir(profiles), { recursive: true });
    writeFileSync(join(tokenDir(profiles), 'ann'), 'fake-token-aaaa\n', { mode: 0o600 });
    const to = archiveToken(profiles, 'ann', new Date('2026-10-31T01:02:03Z'));
    assert.equal(to, join(profiles, 'archive/tokens/20261031T010203Z-ann'));
    assert.equal(readFileSync(to, 'utf8'), 'fake-token-aaaa\n');
    assert.equal(existsSync(join(tokenDir(profiles), 'ann')), false);
    assert.equal(mode(join(profiles, 'archive')), '700');
    assert.equal(mode(join(profiles, 'archive/tokens')), '700');
    assert.equal(mode(to), '600');
  });
});

test('archiveToken never overwrites an archived file of the same second, and a missing token is an error', async () => {
  const { archiveToken, tokenDir } = await lib();
  dirs(({ profiles }) => {
    mkdirSync(tokenDir(profiles), { recursive: true });
    const at = new Date('2026-10-31T01:02:03Z');
    assert.throws(() => archiveToken(profiles, 'ann', at), /no token/);
    const firsts = [];
    for (const t of ['one', 'two']) {
      writeFileSync(join(tokenDir(profiles), 'ann'), `${t}\n`, { mode: 0o600 });
      firsts.push(archiveToken(profiles, 'ann', at));
    }
    assert.notEqual(firsts[0], firsts[1]);
    assert.deepEqual(firsts.map((p) => readFileSync(p, 'utf8')), ['one\n', 'two\n']);
  });
});

test('retireSeat1File moves seats/1/oauth-token aside only when seat 1\'s account has a token, and says whether it did', async () => {
  const { retireSeat1File, tokenDir } = await lib();
  dirs(({ state, profiles }) => {
    mkdirSync(join(profiles, 'seats/1'), { recursive: true });
    const old = join(profiles, 'seats/1/oauth-token');
    writeFileSync(old, 'old-token\n', { mode: 0o600 });
    assert.equal(retireSeat1File(profiles, state, new Date('2026-10-31T01:02:03Z')), null, 'no row: nothing moves');
    writeFileSync(join(state, 'accounts'), 'factory/seat-1=ann\n');
    assert.equal(retireSeat1File(profiles, state), null, 'no token for the account: nothing moves');
    assert.ok(existsSync(old));
    mkdirSync(tokenDir(profiles), { recursive: true });
    writeFileSync(join(tokenDir(profiles), 'ann'), 'new-token\n', { mode: 0o600 });
    const to = retireSeat1File(profiles, state, new Date('2026-10-31T01:02:03Z'));
    assert.equal(to, join(profiles, 'archive/seat-1/20261031T010203Z-oauth-token'));
    assert.equal(readFileSync(to, 'utf8'), 'old-token\n');
    assert.equal(existsSync(old), false);
    assert.equal(mode(join(profiles, 'archive/seat-1')), '700');
    assert.equal(retireSeat1File(profiles, state), null, 'a second call finds nothing');
  });
});
