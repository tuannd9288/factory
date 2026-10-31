// #177: `factory login <account>` and `factory store <account>`, against a fake claude (setup-token), a fake ssh and fixture
// folders. No live claude, ssh or Keychain. The token below is invented, and distinct so that its bytes can be searched for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './factory-world.mjs';

const TOKEN = 'sk-ant-oat01-Zq8Lm3Vx7Rk2Nd5Hy9Tw4Pc6Bj1Gf0Ae';
const KILL = 'sk-ant-oat01-Kk5Uu2Ii8Oo3Pp9Ll4Mm7Nn1Vv6Cc0Xx';

const claudeCalls = (s) => s.calls().split('\n').filter((l) => l.startsWith('claude '));

// The token in no output and no file but the one: every line of the calls log (the fake ssh's arguments, the fake claude's) is
// in the folders searched.
function onlyIn(s, r, file, token = TOKEN) {
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), `the token in the output:\n${r.out}`);
  assert.ok(!s.calls().includes(token), 'the token in an argument list');
  assert.deepEqual(s.holders(token), [file]);
}

test('on the factory host: the token goes to tokens/<account>, mode 600 in a folder of mode 700, and to no other place', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.facIn(`${TOKEN}\n`, 'login', 'ann.example', '--no-setup');
    assert.equal(r.code, 0, r.out);
    const file = join(s.tokens(), 'ann.example');
    assert.equal(readFileSync(file, 'utf8').trim(), TOKEN);
    assert.equal(s.modeOf(file), '600');
    assert.equal(s.modeOf(s.tokens()), '700');
    assert.deepEqual(readdirSync(s.tokens()), ['ann.example'], 'no temporary file is left');
    assert.match(r.out, /ann\.example/);
    onlyIn(s, r, file.slice(s.dir.length + 1));
    assert.deepEqual(claudeCalls(s), [], '--no-setup runs no claude');
  } finally {
    s.done();
  }
});

test('a token with no trailing newline is stored too, and a second login replaces the first, in a folder that was too open', () => {
  const s = sandbox();
  try {
    s.onHost();
    mkdirSync(s.tokens(), { recursive: true });
    chmodSync(s.tokens(), 0o755);
    assert.equal(s.facIn(KILL, 'login', 'ann', '--no-setup').code, 0);
    assert.equal(s.facIn(`${TOKEN}\n`, 'login', 'ann', '--no-setup').code, 0);
    const file = join(s.tokens(), 'ann');
    assert.equal(readFileSync(file, 'utf8').trim(), TOKEN);
    assert.equal(s.modeOf(s.tokens()), '700');
    assert.deepEqual(readdirSync(s.tokens()), ['ann']);
  } finally {
    s.done();
  }
});

test('without --no-setup, it runs claude setup-token on the terminal\'s own streams and then reads the token from stdin', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.facIn(`${TOKEN}\n`, 'login', 'ann');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(claudeCalls(s).map((l) => l.replace(/ CLAUDE_CONFIG_DIR=.*/, '')), ['claude setup-token']);
    // The fake's banners reach the caller's stdout and stderr, so the factory did not capture them.
    assert.match(r.stdout, /SETUP-BANNER on stdout/);
    assert.match(r.stderr, /SETUP-BANNER on stderr/);
    onlyIn(s, r, join('home/.agent-profiles/tokens/ann'));
  } finally {
    s.done();
  }
});

test('a setup-token that fails stores nothing', () => {
  const s = sandbox();
  try {
    s.onHost();
    s.w('setup-fail', '');
    const r = s.facIn(`${TOKEN}\n`, 'login', 'ann');
    assert.notEqual(r.code, 0);
    assert.match(r.out, /setup-token/);
    assert.ok(!existsSync(s.tokens()));
    assert.deepEqual(s.holders(TOKEN), []);
  } finally {
    s.done();
  }
});

test('an account name outside ^[a-z0-9][a-z0-9._-]*$, or with .., is refused before setup-token runs or stdin is read', () => {
  const s = sandbox();
  try {
    s.onHost();
    for (const name of ['', 'Ann', '../x', '..', 'a/b', '/etc/x', '-x', '--no-setup', '.x', '_x', 'a..b', 'a b', 'a\nb', 'a;b', 'é', 'a*']) {
      const r = s.facIn(`${TOKEN}\n`, 'login', name);
      assert.notEqual(r.code, 0, JSON.stringify(name));
      assert.deepEqual(claudeCalls(s), [], `setup-token ran for ${JSON.stringify(name)}`);
      assert.ok(!existsSync(s.tokens()), JSON.stringify(name));
      assert.ok(!r.out.includes(TOKEN));
    }
    assert.deepEqual(s.holders(TOKEN), []);
    for (const name of ['a', 'a1', '0a', 'ann.example', 'a_b-c.d']) assert.equal(s.facIn(`${TOKEN}\n`, 'login', name, '--no-setup').code, 0, name);
  } finally {
    s.done();
  }
});

test('an empty token, and a token of more than one line, are refused after the read, and nothing is written or replaced', () => {
  const s = sandbox();
  try {
    s.onHost();
    assert.equal(s.facIn(`${KILL}\n`, 'login', 'ann', '--no-setup').code, 0);
    for (const input of ['', '\n', '\n\n', '   \n', `${TOKEN}\n\n`, `${TOKEN}\n${KILL}\n`, `${TOKEN}\r\n${KILL}`, `\n${TOKEN}\n`, `first\n${TOKEN}`]) {
      for (const name of ['ann', 'bob']) {
        const r = s.facIn(input, 'login', name, '--no-setup');
        assert.notEqual(r.code, 0, JSON.stringify(input));
        assert.ok(!r.out.includes(TOKEN) && !r.out.includes(KILL), `a token in the error:\n${r.out}`);
      }
    }
    assert.deepEqual(readdirSync(s.tokens()), ['ann'], 'bob was never written, and no temporary file is left');
    assert.equal(readFileSync(join(s.tokens(), 'ann'), 'utf8').trim(), KILL, 'ann was not replaced');
    assert.deepEqual(s.holders(TOKEN), []);
  } finally {
    s.done();
  }
});

test('on the MacBook: the token goes over ssh\'s stdin to `factory store` of the factory account, in no argument, and stays off the MacBook', () => {
  const s = sandbox();
  try {
    const r = s.facIn(`${TOKEN}\n`, 'login', 'ann', '--no-setup');
    assert.equal(r.code, 0, r.out);
    const far = join(s.fake, 'far/.agent-profiles/tokens');
    assert.equal(readFileSync(join(far, 'ann'), 'utf8').trim(), TOKEN);
    assert.equal(s.modeOf(join(far, 'ann')), '600');
    assert.equal(s.modeOf(far), '700');
    assert.ok(!existsSync(s.tokens()), 'nothing written on the MacBook');
    const ssh = s.calls().split('\n').filter((l) => l.startsWith('ssh '));
    assert.deepEqual(ssh, ["ssh -o BatchMode=yes -o ConnectTimeout=10 factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory store ann'"]);
    onlyIn(s, r, 'fake/far/.agent-profiles/tokens/ann');
  } finally {
    s.done();
  }
});

test('on the MacBook with setup-token: it runs here, then the token goes over ssh', () => {
  const s = sandbox();
  try {
    const r = s.facIn(`${TOKEN}\n`, 'login', 'ann');
    assert.equal(r.code, 0, r.out);
    assert.equal(claudeCalls(s).length, 1);
    assert.ok(s.calls().indexOf('claude setup-token') < s.calls().indexOf('ssh '));
    onlyIn(s, r, 'fake/far/.agent-profiles/tokens/ann');
  } finally {
    s.done();
  }
});

test('on the MacBook, a name or a token that is refused never reaches ssh; an ssh that fails says why and leaks no token', () => {
  const s = sandbox();
  try {
    for (const [input, name] of [[`${TOKEN}\n`, '../x'], ['', 'ann'], [`${TOKEN}\n${KILL}\n`, 'ann']]) {
      assert.notEqual(s.facIn(input, 'login', name, '--no-setup').code, 0);
    }
    assert.ok(!s.calls().includes('ssh '), s.calls());
    s.w('ssh-factory.error', 'ssh: connect to host tuans-mac-mini port 22: Operation timed out\nPermission denied (publickey).\n');
    const r = s.facIn(`${TOKEN}\n`, 'login', 'ann', '--no-setup');
    assert.notEqual(r.code, 0);
    assert.match(r.out, /Permission denied \(publickey\)\./);
    assert.deepEqual(s.holders(TOKEN), []);
    assert.ok(!r.out.includes(TOKEN));
  } finally {
    s.done();
  }
});

test('store: reads the token from stdin on the factory host, with the same refusals; on the MacBook it refuses and writes nothing', () => {
  const s = sandbox();
  try {
    const mac = s.facIn(`${TOKEN}\n`, 'store', 'ann');
    assert.notEqual(mac.code, 0);
    assert.match(mac.out, /factory host|Mac mini/);
    assert.ok(!existsSync(s.tokens()));
    s.onHost();
    for (const name of ['../x', 'A', '-x', 'a/b']) assert.notEqual(s.facIn(`${TOKEN}\n`, 'store', name).code, 0, name);
    for (const input of ['', '\n', `${TOKEN}\n${KILL}\n`]) assert.notEqual(s.facIn(input, 'store', 'ann').code, 0, JSON.stringify(input));
    assert.ok(!existsSync(s.tokens()));
    const ok = s.facIn(`${TOKEN}\n`, 'store', 'ann');
    assert.equal(ok.code, 0, ok.out);
    assert.equal(readFileSync(join(s.tokens(), 'ann'), 'utf8').trim(), TOKEN);
    assert.equal(s.modeOf(join(s.tokens(), 'ann')), '600');
    assert.ok(!ok.out.includes(TOKEN));
    assert.deepEqual(s.holders(TOKEN), [join('home/.agent-profiles/tokens/ann')]);
    // store takes no flag and no second word
    assert.notEqual(s.facIn(`${TOKEN}\n`, 'store', 'bob', '--no-setup').code, 0);
    assert.deepEqual(readdirSync(s.tokens()), ['ann']);
  } finally {
    s.done();
  }
});

test('spaces and tabs around a pasted token are trimmed; whitespace inside it is refused and nothing is written', () => {
  const s = sandbox();
  try {
    s.onHost();
    const bad = s.facIn(`${TOKEN} ${KILL}\n`, 'login', 'bob', '--no-setup');
    assert.notEqual(bad.code, 0);
    assert.ok(!existsSync(s.tokens()));
    const ok = s.facIn(`  \t${TOKEN}\t \r\n`, 'login', 'ann', '--no-setup');
    assert.equal(ok.code, 0, ok.out);
    assert.equal(readFileSync(join(s.tokens(), 'ann'), 'utf8'), `${TOKEN}\n`);
  } finally {
    s.done();
  }
});

test('a tokens folder that is a symlink is refused, and its target is neither written into nor changed', () => {
  const s = sandbox();
  try {
    s.onHost();
    const target = join(s.dir, 'elsewhere');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    mkdirSync(s.env.AGENT_PROFILES, { recursive: true });
    symlinkSync(target, s.tokens());
    for (const args of [['login', 'ann', '--no-setup'], ['store', 'ann']]) {
      const r = s.facIn(`${TOKEN}\n`, ...args);
      assert.notEqual(r.code, 0, args[0]);
      assert.match(r.out, /symlink/);
      assert.ok(!r.out.includes(TOKEN));
    }
    assert.deepEqual(readdirSync(target), []);
    assert.equal(s.modeOf(target), '755');
    assert.deepEqual(s.holders(TOKEN), []);
  } finally {
    s.done();
  }
});

// The place is decided by the user the command runs as, against the user the Mac mini's setting names; a FACTORY_USER in the
// environment claims nothing.
test('a stray FACTORY_USER=factory on the MacBook does not make it the factory host', () => {
  const s = sandbox();
  try {
    s.env.FACTORY_USER = 'factory';
    const r = s.facIn(`${TOKEN}\n`, 'login', 'ann', '--no-setup');
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(s.tokens()), 'nothing written on the MacBook');
    assert.ok(s.calls().includes('ssh '), 'the token went over ssh');
    assert.ok(existsSync(join(s.fake, 'far/.agent-profiles/tokens/ann')));
    assert.notEqual(s.facIn(`${TOKEN}\n`, 'store', 'bob').code, 0, 'store refuses on the MacBook');
  } finally {
    s.done();
  }
});

test('the token store holds nothing but the one file even when the account file is a leftover of another mode', () => {
  const s = sandbox();
  try {
    s.onHost();
    mkdirSync(s.tokens(), { recursive: true });
    writeFileSync(join(s.tokens(), 'ann'), KILL);
    chmodSync(join(s.tokens(), 'ann'), 0o644);
    assert.equal(s.facIn(`${TOKEN}\n`, 'login', 'ann', '--no-setup').code, 0);
    assert.equal(s.modeOf(join(s.tokens(), 'ann')), '600');
    assert.deepEqual(s.holders(KILL), []);
  } finally {
    s.done();
  }
});
