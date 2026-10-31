// #178: `factory` on the Mac mini lists numbered rows (seat 1, seat 2, each Lead the accounts file names, the verifier) and lettered
// accounts; `factory use <row> <letter>` rewrites the accounts file; `factory logout <account>` moves a token into the archive.
// Fake claude, codex, gh and ssh on PATH and fixture folders; every name and token below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from './factory-world.mjs';

const ANN = 'sk-ant-oat01-ANNANNANNANN1234567890abcd';
const BOB = 'sk-ant-oat01-BOBBOBBOBBOB1234567890efgh';
const utc = (sec) => new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ');
const EVENT = readFileSync(fileURLToPath(new URL('./fixtures/quota/real-event.jsonl', import.meta.url)), 'utf8');
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const lineOf = (out, text) => out.split('\n').find((l) => l.includes(text));

/** The Mac mini's world: accounts file, token files, and a seat 2 log with a quota event. */
function mini(s, { accounts = 'factory/seat-1=ann\nfactory/seat-2=ann\nfactory/lead-alpha=bob\n', tokens = { ann: ANN, bob: BOB } } = {}) {
  s.onHost();
  writeFileSync(join(s.state, 'accounts'), accounts, { mode: 0o600 });
  const dir = s.tokens();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, token] of Object.entries(tokens)) {
    writeFileSync(join(dir, name), `${token}\n`);
    chmodSync(join(dir, name), 0o600);
  }
}

const logSeat = (s, seat, text = EVENT) => {
  const folder = join(s.env.FACTORY_RUNS, 'issue-1');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `run-w${seat}.jsonl`), `{"type":"system","subtype":"init"}\n${text}`);
  writeFileSync(join(folder, `run-w${seat}.seat`), `${seat}\n`);
};

test('the frame: numbered rows, lettered accounts with 5h, 7d, reset and the rows that share each; a Lead on its own account', () => {
  const s = sandbox();
  try {
    mini(s);
    logSeat(s, 2);
    const r = s.fac();
    assert.equal(r.code, 0, r.out);
    console.log(`--- frame of \`factory\` (two seats on ann, the alpha Lead on bob) ---\n${r.out}\n--- end of frame ---`);
    const rows = ['factory/seat-1', 'factory/seat-2', 'factory/lead-alpha', 'factory/verifier'];
    const at = rows.map((p) => r.out.indexOf(lineOf(r.out, p)));
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'the rows come in this order');
    for (const [i, p] of rows.entries()) assert.match(lineOf(r.out, p), new RegExp(`^\\s*${i + 1}\\s+${p}\\b`), p);
    const ann = r.out.split('\n').find((l) => /^\s*a\s+ann\b/.test(l));
    const bob = r.out.split('\n').find((l) => /^\s*b\s+bob\b/.test(l));
    assert.ok(ann && bob, r.out);
    assert.match(ann, /13%/, '5h of ann, from the seat 2 event');
    assert.match(ann, /3%/, '7d of ann');
    assert.ok(ann.includes(utc(1792998600)), 'the reset');
    assert.match(ann, /rows? 1, 2\b/);
    assert.match(bob, /\?/, 'no seat of bob has an event');
    assert.match(bob, /rows? 3\b/);
    assert.match(lineOf(r.out, 'factory/seat-1'), /ann \(a\)/);
    assert.match(lineOf(r.out, 'factory/lead-alpha'), /bob \(b\)/);
    for (const token of [ANN, BOB]) for (let i = 0; i + 8 <= token.length; i += 1) assert.ok(!r.out.includes(token.slice(i, i + 8)), 'a slice of a token');
  } finally {
    s.done();
  }
});

test('an account with a token file and no row is lettered, and an account a row names with no token file is red with the line to run', () => {
  const s = sandbox();
  try {
    mini(s, { accounts: 'factory/seat-1=ann\nfactory/seat-2=cat\n', tokens: { ann: ANN, zed: BOB } });
    const r = s.fac();
    assert.equal(r.code, 0, r.out);
    const letters = r.out.split('\n').filter((l) => /^\s*[a-z]\s+\S/.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.deepEqual(letters, ['a ann', 'b cat', 'c zed']);
    assert.match(lineOf(r.out, 'factory/seat-2'), /\bNO\b/);
    assert.match(r.out, /factory login cat/);
    assert.match(r.out, /factory use 2 /);
    assert.match(lineOf(r.out, 'factory/seat-1'), /\byes\b/);
    const zed = r.out.split('\n').find((l) => /^\s*c\s+zed\b/.test(l));
    assert.match(zed, /no row/);
  } finally {
    s.done();
  }
});

test('a token file shows its mode and date in the accounts block, never the content', () => {
  const s = sandbox();
  try {
    mini(s);
    chmodSync(join(s.tokens(), 'bob'), 0o644);
    const r = s.fac();
    assert.match(r.out.split('\n').find((l) => /^\s*b\s+bob\b/.test(l)) ?? 'no line for bob', /mode 644 \(should be 600\)/);
    assert.match(r.out.split('\n').find((l) => /^\s*a\s+ann\b/.test(l)) ?? 'no line for ann', /mode 600/);
    assert.ok(!r.out.includes('ANNANN') && !JSON.stringify(s.fac('--json').out).includes('ANNANN'));
  } finally {
    s.done();
  }
});

test('a row with no account row is red and names factory use; FACTORY_SEAT_ACCOUNTS names nothing any more', () => {
  const s = sandbox();
  try {
    mini(s, { accounts: 'factory/seat-1=ann\n' });
    s.env.FACTORY_SEAT_ACCOUNTS = '2=zed';
    const rows = JSON.parse(s.fac('--json').out);
    const two = rows.find((x) => x.profile === 'factory/seat-2');
    assert.equal(two.loggedIn, false);
    assert.notEqual(two.account, 'zed');
    assert.match(two.login, /factory use 2 /);
  } finally {
    s.done();
  }
});

test('the Lead rows are the file\'s, sorted; no folder is scanned and no direnv runs', () => {
  const s = sandbox();
  try {
    mini(s, { accounts: 'factory/seat-1=ann\nfactory/seat-2=ann\nfactory/lead-zeta=ann\nfactory/lead-alpha=bob\n' });
    mkdirSync(join(s.env.FACTORY_ROOT, 'gamma'), { recursive: true });
    for (const f of ['.gate', '.envrc']) writeFileSync(join(s.env.FACTORY_ROOT, 'gamma', f), '');
    const rows = JSON.parse(s.fac('--json').out);
    assert.deepEqual(rows.map((x) => x.profile).filter((p) => p.startsWith('factory/lead')), ['factory/lead-alpha', 'factory/lead-zeta']);
    assert.doesNotMatch(s.calls(), /direnv/);
  } finally {
    s.done();
  }
});

test('the JSON keeps its list of rows and adds the number and the letter of each', () => {
  const s = sandbox();
  try {
    mini(s);
    const rows = JSON.parse(s.fac('--json').out);
    const by = (p) => rows.find((x) => x.profile === p);
    assert.equal(by('factory/seat-1').n, 1);
    assert.equal(by('factory/seat-2').n, 2);
    assert.equal(by('factory/lead-alpha').n, 3);
    assert.equal(by('factory/verifier').n, 4);
    assert.equal(by('factory/seat-1').letter, 'a');
    assert.equal(by('factory/lead-alpha').letter, 'b');
    assert.deepEqual(by('factory/seat-1').shared, ['factory/seat-2']);
  } finally {
    s.done();
  }
});

test('use <row> <letter> rewrites the accounts file through a rename, mode 600, and touches no other line', () => {
  const s = sandbox();
  try {
    mini(s, { accounts: '# mine\nfactory/seat-1=ann\nfactory/seat-2=ann\nfactory/lead-alpha=bob\n' });
    const r = s.fac('use', '2', 'b');
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(s.state, 'accounts'), 'utf8'), '# mine\nfactory/seat-1=ann\nfactory/seat-2=bob\nfactory/lead-alpha=bob\n');
    assert.equal(mode(join(s.state, 'accounts')), '600');
    assert.deepEqual(readdirSync(s.state), ['accounts']);
    assert.match(r.out, /seat 2/);
    assert.match(r.out, /next session/);
  } finally {
    s.done();
  }
});

test('use refuses the verifier\'s row, a Lead\'s row for now, an unknown row or letter, and a row that is not a number', () => {
  const s = sandbox();
  try {
    mini(s);
    const before = readFileSync(join(s.state, 'accounts'), 'utf8');
    const verifier = s.fac('use', '4', 'a');
    assert.equal(verifier.code, 2, verifier.out);
    assert.match(verifier.out, /Codex/);
    const lead = s.fac('use', '3', 'a');
    assert.equal(lead.code, 2, lead.out);
    assert.match(lead.out, /#179/);
    for (const args of [['9', 'a'], ['1', 'z'], ['x', 'a'], ['1', '1'], ['0', 'a'], ['1', 'a', 'extra']]) {
      const r = s.fac('use', ...args);
      assert.equal(r.code, 2, args.join(' ') + r.out);
    }
    assert.equal(readFileSync(join(s.state, 'accounts'), 'utf8'), before, 'nothing changed');
  } finally {
    s.done();
  }
});

test('use with an argument missing prints the list and exits 2 when there is no terminal', () => {
  const s = sandbox();
  try {
    mini(s);
    for (const args of [['use'], ['use', '2']]) {
      const r = s.fac(...args);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /factory\/seat-1/);
      assert.match(r.out, /^\s*a\s+ann\b/m);
    }
  } finally {
    s.done();
  }
});

test('use with an argument missing, on a terminal, prints the list and asks for the row and the letter', async () => {
  const s = sandbox();
  try {
    mini(s);
    const { main } = await import('../bin/lib/factory.mjs');
    const asked = [];
    const answers = ['2', 'b'];
    const printed = [];
    const log = console.log;
    console.log = (...a) => printed.push(a.join(' '));
    let code;
    try {
      code = await main(['use'], { ...process.env, ...s.env, NODE_TEST_CONTEXT: undefined }, { isTTY: true, ask: async (q) => { asked.push(q); return answers.shift(); } });
    } finally {
      console.log = log;
    }
    assert.equal(code, 0);
    assert.equal(asked.length, 2);
    assert.match(asked[0], /row/i);
    assert.match(asked[1], /letter/i);
    assert.match(printed.join('\n'), /factory\/seat-1/);
    assert.match(readFileSync(join(s.state, 'accounts'), 'utf8'), /factory\/seat-2=bob/);
  } finally {
    s.done();
  }
});

test('use runs on the Mac mini only', () => {
  const s = sandbox();
  try {
    const r = s.fac('use', '1', 'a');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /use runs on the Mac mini/);
  } finally {
    s.done();
  }
});

test('logout moves the token into archive/tokens by rename, never deletes it, and every row naming the account is red', () => {
  const s = sandbox();
  try {
    mini(s);
    const r = s.fac('logout', 'ann');
    assert.equal(r.code, 0, r.out);
    const archive = join(s.env.AGENT_PROFILES, 'archive/tokens');
    const kept = readdirSync(archive);
    assert.equal(kept.length, 1);
    assert.match(kept[0], /^\d{8}T\d{6}Z-ann$/);
    assert.equal(readFileSync(join(archive, kept[0]), 'utf8'), `${ANN}\n`);
    assert.equal(mode(archive), '700');
    assert.equal(mode(join(s.env.AGENT_PROFILES, 'archive')), '700');
    assert.equal(existsSync(join(s.tokens(), 'ann')), false);
    assert.ok(!r.out.includes('ANNANN'));
    const list = s.fac();
    for (const p of ['factory/seat-1', 'factory/seat-2']) assert.match(lineOf(list.out, p), /\bNO\b/, p);
    assert.match(lineOf(list.out, 'factory/lead-alpha'), /\byes\b/);
    assert.match(list.out, /factory login ann/);
    assert.match(list.out, /factory use 1 /);
    assert.match(readFileSync(join(s.state, 'accounts'), 'utf8'), /seat-1=ann/);
  } finally {
    s.done();
  }
});

test('logout refuses an account with no token file, a bad name and a missing name; login again brings the account back', () => {
  const s = sandbox();
  try {
    mini(s);
    assert.equal(s.fac('logout', 'nobody').code, 1);
    assert.equal(s.fac('logout', '../x').code, 2);
    assert.equal(s.fac('logout').code, 2);
    assert.equal(s.fac('logout', 'ann', 'bob').code, 2);
    assert.equal(s.fac('logout', 'ann').code, 0);
    const again = s.facIn('sk-ant-oat01-NEWNEWNEW1234567890\n', 'login', 'ann', '--no-setup');
    assert.equal(again.code, 0, again.out);
    assert.match(lineOf(s.fac().out, 'factory/seat-1'), /\byes\b/);
    assert.equal(readdirSync(join(s.env.AGENT_PROFILES, 'archive/tokens')).length, 1, 'the archive keeps the old one');
  } finally {
    s.done();
  }
});

test('logout runs on the Mac mini only', () => {
  const s = sandbox();
  try {
    const r = s.fac('logout', 'ann');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /logout runs on the Mac mini/);
  } finally {
    s.done();
  }
});

const oldFile = (s) => join(s.env.AGENT_PROFILES, 'seats/1/oauth-token');
function withOld(s) {
  mkdirSync(join(s.env.AGENT_PROFILES, 'seats/1'), { recursive: true });
  writeFileSync(oldFile(s), 'sk-ant-oat01-OLDOLDOLD1234567890\n', { mode: 0o600 });
}

test('while seat 1\'s old token file is there, factory prints one line about it, and not its content', () => {
  const s = sandbox();
  try {
    mini(s);
    withOld(s);
    const r = s.fac();
    const lines = r.out.split('\n').filter((l) => l.includes('seats/1/oauth-token'));
    assert.equal(lines.length, 1, r.out);
    assert.ok(!r.out.includes('OLDOLD'));
    assert.ok(!s.fac('--json').out.includes('OLDOLD'));
  } finally {
    s.done();
  }
});

test('use on seat 1, with a token for the new account, moves the old file to archive/seat-1 by rename; with no token it stays', () => {
  const s = sandbox();
  try {
    mini(s, { accounts: 'factory/seat-1=ann\nfactory/seat-2=ann\n', tokens: { ann: ANN, bob: BOB } });
    withOld(s);
    const r = s.fac('use', '2', 'b');
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(oldFile(s)), 'a use on seat 2 does not move it');
    const one = s.fac('use', '1', 'b');
    assert.equal(one.code, 0, one.out);
    assert.equal(existsSync(oldFile(s)), false);
    const kept = readdirSync(join(s.env.AGENT_PROFILES, 'archive/seat-1'));
    assert.equal(kept.length, 1);
    assert.match(kept[0], /^\d{8}T\d{6}Z-oauth-token$/);
    assert.equal(readFileSync(join(s.env.AGENT_PROFILES, 'archive/seat-1', kept[0]), 'utf8'), 'sk-ant-oat01-OLDOLDOLD1234567890\n');
    assert.ok(!s.fac().out.includes('seats/1/oauth-token'), 'no line once it is gone');
  } finally {
    s.done();
  }
  const t = sandbox();
  try {
    mini(t, { accounts: 'factory/seat-1=ann\nfactory/seat-2=ann\n', tokens: { ann: ANN } });
    withOld(t);
    assert.equal(t.fac('use', '1', 'b').code, 2, 'b is not an account');
    writeFileSync(join(t.state, 'accounts'), 'factory/seat-1=ann\nfactory/seat-2=cat\n');
    assert.equal(t.fac('use', '1', 'b').code, 0, 'cat has no token file');
    assert.ok(existsSync(oldFile(t)), 'a seat 1 account with no token does not move the file');
  } finally {
    t.done();
  }
});

test('login on the Mac mini moves the old seat 1 file when seat 1\'s account now has a token', () => {
  const s = sandbox();
  try {
    mini(s, { accounts: 'factory/seat-1=ann\nfactory/seat-2=ann\n', tokens: {} });
    withOld(s);
    const other = s.facIn('sk-ant-oat01-BOBBOB1234567890\n', 'login', 'bob', '--no-setup');
    assert.equal(other.code, 0, other.out);
    assert.ok(existsSync(oldFile(s)), 'a token for another account moves nothing');
    const r = s.facIn(`${ANN}\n`, 'login', 'ann', '--no-setup');
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(oldFile(s)), false);
    assert.equal(readdirSync(join(s.env.AGENT_PROFILES, 'archive/seat-1')).length, 1);
  } finally {
    s.done();
  }
});

test('store (the far side of a login from the MacBook) moves the old seat 1 file too', () => {
  const s = sandbox();
  try {
    mini(s, { accounts: 'factory/seat-1=ann\n', tokens: {} });
    withOld(s);
    const r = s.facIn(`${ANN}\n`, 'store', 'ann');
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(oldFile(s)), false);
  } finally {
    s.done();
  }
});

test('the verifier\'s row is read-only: it shows its Codex login and has no account letter', () => {
  const s = sandbox();
  try {
    mini(s);
    s.w('codex-codex', '');
    const rows = JSON.parse(s.fac('--json').out);
    const v = rows.find((x) => x.profile === 'factory/verifier');
    assert.equal(v.n, 4);
    assert.ok(userInfo().username);
    assert.equal(v.loggedIn, true);
    assert.equal(v.letter ?? null, null);
  } finally {
    s.done();
  }
});
