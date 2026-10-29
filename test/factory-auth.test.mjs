// #173: bin/factory-auth, against fake claude, codex, gh, direnv, pig and ssh on PATH and fixture folders. Nothing live runs,
// and every name below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, factory } from './helpers.mjs';

const EMAIL = 'ann.example@secret-corp.example';
const ORG = 'org-00000000-1111-2222-3333-444444444444';
const claudeJson = (email, plan = 'max') => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email, orgId: ORG, orgName: 'Secret Corp', subscriptionType: plan });

// Each fake logs its argv and environment to calls.log, and answers from files in $FAKE.
const SCRIPTS = {
  claude: `#!/bin/sh
echo "claude $* CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" >> "$FAKE/calls.log"
[ -f "$FAKE/hang-claude" ] && exec sleep 30
f="$FAKE/claude-$(basename "\${CLAUDE_CONFIG_DIR:-default}").json"
if [ -f "$f" ]; then cat "$f"; else echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; fi
`,
  codex: `#!/bin/sh
echo "codex $* CODEX_HOME=$CODEX_HOME" >> "$FAKE/calls.log"
f="$FAKE/codex-$(basename "\${CODEX_HOME:-default}")"
if [ -f "$f" ]; then echo "Logged in using ChatGPT"; exit 0; else echo "Not logged in"; exit 1; fi
`,
  gh: `#!/bin/sh
echo "gh $*" >> "$FAKE/calls.log"
if [ -f "$FAKE/gh-$USER_PLACE" ]; then printf 'github.com\\n  ✓ Logged in to github.com account %s (keyring)\\n' "$(cat "$FAKE/gh-$USER_PLACE")" >&2; else echo 'You are not logged into any GitHub hosts.' >&2; exit 1; fi
`,
  direnv: `#!/bin/sh
echo "direnv $* in $(basename "$PWD")" >> "$FAKE/calls.log"
shift 2
CLAUDE_CONFIG_DIR="$FAKE/lead-$(basename "$PWD")" exec "$@"
`,
  pig: `#!/bin/sh
echo "pig $*" >> "$FAKE/calls.log"
c="$1"; shift
if [ "$c" = claude ]; then CLAUDE_CONFIG_DIR="$FAKE/piggery-claude" exec claude "$@"; else CODEX_HOME="$FAKE/piggery-codex" exec codex "$@"; fi
`,
  ssh: `#!/bin/sh
echo "ssh $*" >> "$FAKE/calls.log"
for last; do :; done
user=\${last%%@*}
for a; do case "$a" in *@*) user=\${a%%@*};; esac; done
if [ -f "$FAKE/ssh-$user.error" ]; then cat "$FAKE/ssh-$user.error" >&2; exit 255; fi
if [ "$user" = factory ]; then cat "$FAKE/ssh-factory.json"; exit 0; fi
cmd=$(printf '%s' "$last" | sed -n "s/^zsh -lc '\\(.*\\)'$/\\1/p")
exec sh -c "$cmd"
`,
};

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-auth-'));
  const fake = join(dir, 'fake');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const state = join(dir, 'state');
  for (const d of [fake, bin, home, state]) mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(SCRIPTS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const env = {
    FAKE: fake,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    FACTORY_STATE: state,
    FACTORY_ROOT: join(home, 'WORKSPACES'),
    FACTORY_RUNS: join(home, 'factory-runs'),
    FACTORY_SEAT_ACCOUNTS: '',
    FACTORY_AUTH_USER: 'tuannguyen',
    USER_PLACE: 'macbook',
  };
  const w = (name, text) => writeFileSync(join(fake, name), text);
  const auth = (...args) => run(factory, join(factory, 'bin/factory-auth'), args, env);
  const calls = () => (existsSync(join(fake, 'calls.log')) ? readFileSync(join(fake, 'calls.log'), 'utf8') : '');
  return { dir, fake, home, state, env, w, auth, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const rowOf = (out, profile) => out.split('\n').find((l) => l.startsWith(profile));

test('status on the MacBook: one row for each profile, with the account local part and the plan, never the address or the org', () => {
  const s = sandbox();
  try {
    s.w('claude-default.json', claudeJson(EMAIL));
    s.w('claude-.claude-acc2.json', claudeJson('bob.example@other.example', 'pro'));
    s.w('codex-default', '');
    s.w('gh-macbook', 'ghann');
    const r = s.auth('status');
    assert.equal(r.code, 0, r.out);
    for (const p of ['macbook/claude', 'macbook/claude-acc2', 'macbook/claude-acc3', 'macbook/claude-acc4', 'macbook/claude-acc5', 'macbook/codex', 'macbook/gh']) assert.ok(rowOf(r.out, p), `${p} in\n${r.out}`);
    assert.match(rowOf(r.out, 'macbook/claude '), /ann\.example/);
    assert.match(rowOf(r.out, 'macbook/claude '), /max/);
    assert.match(rowOf(r.out, 'macbook/claude-acc2'), /bob\.example/);
    assert.match(rowOf(r.out, 'macbook/gh'), /ghann/);
    assert.ok(!r.out.includes('factory/'), 'no factory row on the MacBook');
    const j = s.auth('status', '--json');
    assert.equal(j.code, 0, j.out);
    for (const out of [r.out, j.out]) for (const secret of [EMAIL, 'secret-corp', ORG, 'Secret Corp', 'orgId']) assert.ok(!out.includes(secret), `${secret} leaked`);
    assert.equal(JSON.parse(j.out).find((x) => x.profile === 'macbook/claude').account, 'ann.example');
  } finally {
    s.done();
  }
});

test('a profile that is not logged in shows its login command', () => {
  const s = sandbox();
  try {
    const r = s.auth('status');
    assert.match(r.out, /claude-use login 3/);
    assert.match(r.out, /codex-use login/);
  } finally {
    s.done();
  }
});

test('the account comes from the local accounts file or FACTORY_SEAT_ACCOUNTS when nothing is read, else unknown; rows on one account name each other', () => {
  const s = sandbox();
  try {
    s.w('claude-default.json', claudeJson(EMAIL));
    writeFileSync(join(s.state, 'accounts'), 'macbook/claude-acc3=ann.example\nmacbook/codex=zed.example\n');
    const j = JSON.parse(s.auth('status', '--json').out);
    const by = (p) => j.find((x) => x.profile === p);
    assert.equal(by('macbook/claude-acc3').account, 'ann.example');
    assert.equal(by('macbook/claude-acc3').accountFrom, 'expected');
    assert.equal(by('macbook/claude-acc4').account, 'unknown');
    assert.deepEqual(by('macbook/claude').shared, ['macbook/claude-acc3']);
    assert.deepEqual(by('macbook/claude-acc3').shared, ['macbook/claude']);
    assert.deepEqual(by('macbook/claude-acc4').shared, [], 'unknown is no account to share');
    assert.deepEqual(by('macbook/codex').shared, []);
  } finally {
    s.done();
  }
});

test('on the factory account: seat 1 is its token file\'s mode and date only, seat 2 has quota and live sessions, leads are the onboarded folders', () => {
  const s = sandbox();
  try {
    const seat1 = join(s.home, '.agent-profiles/seats/1');
    mkdirSync(seat1, { recursive: true });
    writeFileSync(join(seat1, 'oauth-token'), 'sk-ant-oat01-NEVERSHOWNNEVERSHOWN');
    chmodSync(join(seat1, 'oauth-token'), 0o600);
    utimesSync(join(seat1, 'oauth-token'), new Date('2026-10-26T00:00:00Z'), new Date('2026-10-26T00:00:00Z'));
    s.w('claude-claude.json', claudeJson('seat.two@secret-corp.example', 'max'));
    s.w('claude-lead-alpha.json', claudeJson('lead.alpha@secret-corp.example', 'pro'));
    s.w('gh-factory', 'agentgh');
    s.env.USER_PLACE = 'factory';
    s.env.FACTORY_AUTH_USER = 'factory';
    s.env.FACTORY_SEAT_ACCOUNTS = '1=seat.one';
    for (const [repo, files] of [['alpha', ['.gate', '.envrc']], ['beta', ['.gate']], ['gamma', ['.envrc']]]) {
      mkdirSync(join(s.env.FACTORY_ROOT, repo), { recursive: true });
      for (const f of files) writeFileSync(join(s.env.FACTORY_ROOT, repo, f), '');
    }
    const runs = join(s.env.FACTORY_RUNS, 'issue-1');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, 'run-worker.jsonl'), `{"type":"system","subtype":"init"}\n${readFileSync(fileURLToPath(new URL('./fixtures/quota/real-event.jsonl', import.meta.url)), 'utf8')}`);
    writeFileSync(join(runs, 'run-worker.seat'), '2\n');
    const r = s.auth('status');
    assert.equal(r.code, 0, r.out);
    const rows = JSON.parse(s.auth('status', '--json').out);
    const by = (p) => rows.find((x) => x.profile === p);
    assert.deepEqual(rows.map((x) => x.profile).filter((p) => p.startsWith('factory/lead')), ['factory/lead-alpha']);
    assert.equal(by('factory/seat-1').loggedIn, true);
    assert.equal(by('factory/seat-1').account, 'seat.one');
    assert.match(by('factory/seat-1').note, /600/);
    assert.equal(by('factory/seat-2').account, 'seat.two');
    assert.ok(by('factory/seat-2').five_hour.use >= 0);
    assert.equal(by('factory/seat-2').live, 0);
    assert.equal(by('factory/lead-alpha').account, 'lead.alpha');
    assert.equal(by('factory/lead-alpha').five_hour, null);
    assert.equal(by('factory/verifier').loggedIn, false);
    assert.ok(!r.out.includes('NEVERSHOWN'));
    assert.ok(!s.calls().includes('seats/1'), 'claude never ran for seat 1');
    assert.match(s.calls(), /direnv exec \. claude auth status in alpha/);
    assert.match(s.calls(), /codex login status CODEX_HOME=.*verifier\/codex/);
  } finally {
    s.done();
  }
});

test('one hung vendor call cannot hang the table', () => {
  const s = sandbox();
  try {
    s.w('hang-claude', '');
    s.w('codex-default', '');
    s.env.FACTORY_AUTH_TIMEOUT_MS = '300';
    const r = s.auth('status');
    assert.equal(r.code, 0, r.out);
    assert.match(rowOf(r.out, 'macbook/claude '), /timed out/);
    assert.match(rowOf(r.out, 'macbook/codex'), /yes/);
  } finally {
    s.done();
  }
});

test('--all merges the macbook rows, the factory rows over ssh and the piggery rows through pig', () => {
  const s = sandbox();
  try {
    s.w('claude-default.json', claudeJson(EMAIL));
    s.w('claude-piggery-claude.json', claudeJson('ann.example@secret-corp.example'));
    s.w('codex-piggery-codex', '');
    const factoryRows = [{ place: 'factory', profile: 'factory/seat-2', role: 'worker', kind: 'Claude', loggedIn: true, account: 'ann.example', accountFrom: 'read', plan: 'max', five_hour: null, seven_day: null, asOf: null, live: 0, shared: [], login: 'x', note: '' }];
    s.w('ssh-factory.json', JSON.stringify(factoryRows));
    const r = s.auth('status', '--all');
    assert.equal(r.code, 0, r.out);
    for (const p of ['macbook/claude ', 'factory/seat-2', 'piggery/claude', 'piggery/codex']) assert.ok(rowOf(r.out, p), `${p} in\n${r.out}`);
    assert.match(s.calls(), /ssh .*factory@tuans-mac-mini/);
    assert.match(s.calls(), /ssh .*tuannguyen@tuans-mac-mini/);
    const j = JSON.parse(s.auth('status', '--all', '--json').out);
    const by = (p) => j.find((x) => x.profile === p);
    assert.deepEqual([...by('macbook/claude').shared].sort(), ['factory/seat-2', 'piggery/claude']);
    for (const secret of [EMAIL, ORG]) assert.ok(!r.out.includes(secret));
  } finally {
    s.done();
  }
});

test('--all: a place it cannot reach is one row with the last line of the ssh error', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.error', 'ssh: connect to host tuans-mac-mini port 22: Operation timed out\nPermission denied (publickey).\n');
    s.w('ssh-tuannguyen.error', 'ssh: Could not resolve hostname tuans-mac-mini\n');
    const r = s.auth('status', '--all');
    assert.equal(r.code, 0, r.out);
    assert.match(rowOf(r.out, 'factory'), /Permission denied \(publickey\)\./);
    assert.match(rowOf(r.out, 'piggery'), /Could not resolve hostname/);
    assert.ok(rowOf(r.out, 'macbook/claude '));
  } finally {
    s.done();
  }
});
