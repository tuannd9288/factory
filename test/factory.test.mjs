// #173, #177: bin/factory (the list), against fake claude, codex, gh, direnv, pig and ssh on PATH and fixture folders. Nothing
// live runs, and every name below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL, ORG, claudeJson, rowOf, sandbox } from './factory-world.mjs';

/** The spare Claude folders ~/.claude-acc<N> that a MacBook row needs: a row exists only for a folder that is there. */
const spares = (s, ...ns) => { for (const n of ns) mkdirSync(join(s.home, `.claude-acc${n}`)); };

test('with no arguments, on the MacBook: one row for each profile, with the account local part and the plan, never the address or the org', () => {
  const s = sandbox();
  try {
    spares(s, 2, 3, 4, 5);
    s.w('claude-default.json', claudeJson(EMAIL));
    s.w('claude-.claude-acc2.json', claudeJson('bob.example@other.example', 'pro'));
    s.w('codex-default', '');
    s.w('gh-macbook', 'ghann');
    const r = s.fac();
    assert.equal(r.code, 0, r.out);
    for (const p of ['macbook/claude', 'macbook/claude-acc2', 'macbook/claude-acc3', 'macbook/claude-acc4', 'macbook/claude-acc5', 'macbook/codex', 'macbook/gh']) assert.ok(rowOf(r.out, p), `${p} in\n${r.out}`);
    assert.match(rowOf(r.out, 'macbook/claude '), /ann\.example/);
    assert.match(rowOf(r.out, 'macbook/claude '), /max/);
    assert.match(rowOf(r.out, 'macbook/claude-acc2'), /bob\.example/);
    assert.match(rowOf(r.out, 'macbook/gh'), /ghann/);
    assert.ok(!r.out.includes('factory/'), 'no factory row on the MacBook');
    const j = s.fac('--json');
    assert.equal(j.code, 0, j.out);
    for (const out of [r.out, j.out]) for (const secret of [EMAIL, 'secret-corp', ORG, 'Secret Corp', 'orgId']) assert.ok(!out.includes(secret), `${secret} leaked`);
    assert.equal(JSON.parse(j.out).find((x) => x.profile === 'macbook/claude').account, 'ann.example');
  } finally {
    s.done();
  }
});

test('on the MacBook, a plain run lists the Mac mini\'s rows too, as --all does; --all stays accepted', () => {
  const s = sandbox();
  try {
    const rows = [{ place: 'factory', profile: 'factory/seat-2', role: 'worker', kind: 'Claude', loggedIn: true, account: 'ann.example', accountFrom: 'read', plan: 'max', five_hour: null, seven_day: null, asOf: null, live: 0, shared: [], login: 'x', note: '' }];
    s.w('ssh-factory.json', JSON.stringify(rows));
    s.w('claude-default.json', claudeJson(EMAIL));
    const plain = s.fac();
    assert.equal(plain.code, 0, plain.out);
    assert.ok(rowOf(plain.out, 'factory/seat-2'), `the Mac mini's rows in\n${plain.out}`);
    assert.ok(rowOf(plain.out, 'macbook/claude '), plain.out);
    assert.match(s.calls(), /ssh .*factory@tuans-mac-mini zsh -lc '~\/WORKSPACES\/bin\/factory --json'/);
    assert.equal(JSON.parse(s.fac('--json').out).some((x) => x.profile === 'factory/seat-2'), true);
    assert.equal(s.fac('--all').code, 0);
  } finally {
    s.done();
  }
});

test('on the factory host, --all is still refused', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.fac('--all');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--all runs on the MacBook/);
  } finally {
    s.done();
  }
});

test('the MacBook\'s spare Claude rows are the .claude-acc<N> folders that exist: no row, no claude call and no new folder for one that does not', () => {
  const s = sandbox();
  try {
    for (const d of ['.claude-acc2', '.claude-acc10', '.claude-acc7']) mkdirSync(join(s.home, d));
    writeFileSync(join(s.home, '.claude-acc5'), 'a file, not a folder');
    mkdirSync(join(s.home, '.claude-accx'));
    s.w('claude-.claude-acc2.json', claudeJson('bob.example@other.example', 'pro'));
    const rows = JSON.parse(s.fac('--json').out).map((x) => x.profile).filter((p) => p.startsWith('macbook/claude-acc'));
    assert.deepEqual(rows, ['macbook/claude-acc2', 'macbook/claude-acc7', 'macbook/claude-acc10'], 'sorted by number, only folders');
    const r = s.fac();
    assert.match(rowOf(r.out, 'macbook/claude-acc2'), /bob\.example/);
    assert.equal(rowOf(r.out, 'macbook/claude-acc3'), undefined);
    assert.doesNotMatch(s.calls(), /\.claude-acc(3|4|5)\b/);
    assert.doesNotMatch(s.calls(), /\.claude-accx/);
    assert.equal(existsSync(join(s.home, '.claude-acc3')), false);
  } finally {
    s.done();
  }
});

test('a word that is neither a flag nor a subcommand is refused with the usage', () => {
  const s = sandbox();
  try {
    for (const args of [['status'], ['--nope'], ['login'], ['login', 'a', 'b'], ['store'], ['login', 'ann', '--no-setup', '--x']]) {
      const r = s.fac(...args);
      assert.notEqual(r.code, 0, args.join(' '));
      assert.match(r.out, /usage: bin\/factory/, args.join(' '));
    }
  } finally {
    s.done();
  }
});

test('a profile that is not logged in shows its login command', () => {
  const s = sandbox();
  try {
    spares(s, 3);
    const r = s.fac();
    assert.match(r.out, /claude-use login 3/);
    assert.match(r.out, /codex-use login/);
  } finally {
    s.done();
  }
});

test('seat 1 with no row in the accounts file names factory use', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.fac();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /factory use 1 /);
  } finally {
    s.done();
  }
});

test('the account comes from the local accounts file or FACTORY_SEAT_ACCOUNTS when nothing is read, else unknown; rows on one account name each other', () => {
  const s = sandbox();
  try {
    spares(s, 3, 4);
    s.w('claude-default.json', claudeJson(EMAIL));
    writeFileSync(join(s.state, 'accounts'), 'macbook/claude-acc3=ann.example\nmacbook/codex=zed.example\n');
    const j = JSON.parse(s.fac('--json').out);
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

// A plain run on the MacBook is --all, so the piggery rows' role ("piggery teams", one column wider than "spare Claude") is in the table.
test('the table stays under 105 columns when "shared with" names four long profiles; --json keeps the whole list', () => {
  const s = sandbox();
  try {
    spares(s, 2, 3, 4, 5);
    s.w('claude-default.json', claudeJson(EMAIL));
    writeFileSync(join(s.state, 'accounts'), [2, 3, 4, 5].map((n) => `macbook/claude-acc${n}=ann.example`).join('\n'));
    const r = s.fac();
    const table = r.out.split('\n\n')[0].split('\n');
    assert.ok(table.length > 5, r.out);
    for (const line of table) assert.ok(line.length <= 105, `${line.length} columns: ${line}`);
    assert.match(rowOf(r.out, 'macbook/claude '), /macbook\/claude-acc2 \+3/);
    const shared = JSON.parse(s.fac('--json').out).find((x) => x.profile === 'macbook/claude').shared;
    assert.deepEqual(shared, [2, 3, 4, 5].map((n) => `macbook/claude-acc${n}`));
  } finally {
    s.done();
  }
});

test('on the factory account: a seat is its account\'s token file\'s mode and date only, seat 2 has quota and live sessions, no row for a repository folder (#205)', () => {
  const s = sandbox();
  try {
    const tokens = s.tokens();
    mkdirSync(tokens, { recursive: true });
    for (const a of ['seat.one', 'seat.two']) {
      writeFileSync(join(tokens, a), 'sk-ant-oat01-NEVERSHOWNNEVERSHOWN');
      chmodSync(join(tokens, a), 0o600);
      utimesSync(join(tokens, a), new Date('2026-10-26T00:00:00Z'), new Date('2026-10-26T00:00:00Z'));
    }
    writeFileSync(join(s.state, 'accounts'), 'factory/seat-1=seat.one\nfactory/seat-2=seat.two\n');
    s.w('gh-factory', 'agentgh');
    s.onHost();
    for (const [repo, files] of [['alpha', ['.gate', '.envrc']], ['beta', ['.gate']], ['gamma', ['.envrc']]]) {
      mkdirSync(join(s.env.FACTORY_ROOT, repo), { recursive: true });
      for (const f of files) writeFileSync(join(s.env.FACTORY_ROOT, repo, f), '');
    }
    const runs = join(s.env.FACTORY_RUNS, 'issue-1');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, 'run-worker.jsonl'), `{"type":"system","subtype":"init"}\n${readFileSync(fileURLToPath(new URL('./fixtures/quota/real-event.jsonl', import.meta.url)), 'utf8')}`);
    writeFileSync(join(runs, 'run-worker.seat'), '2\n');
    const r = s.fac();
    assert.equal(r.code, 0, r.out);
    const rows = JSON.parse(s.fac('--json').out);
    const by = (p) => rows.find((x) => x.profile === p);
    assert.deepEqual(rows.map((x) => x.profile).filter((p) => p.startsWith('factory/lead')), [], 'alpha holds .gate/ and .envrc, and still has no row');
    assert.equal(by('factory/seat-1').loggedIn, true);
    assert.equal(by('factory/seat-1').account, 'seat.one');
    assert.match(by('factory/seat-1').note, /600/);
    assert.equal(by('factory/seat-2').account, 'seat.two');
    assert.ok(by('factory/seat-2').five_hour.use >= 0);
    assert.equal(by('factory/seat-2').live, 0);
    assert.equal(by('factory/verifier').loggedIn, false);
    assert.ok(!r.out.includes('NEVERSHOWN'));
    assert.ok(!s.calls().includes('seats/'), 'claude never ran for a seat');
    assert.doesNotMatch(s.calls(), /direnv/);
    assert.match(s.calls(), /codex login status CODEX_HOME=.*verifier\/codex/);
  } finally {
    s.done();
  }
});

test('the list shows a lettered account for each token file: the mode and the date, never the content', () => {
  const s = sandbox();
  try {
    s.onHost();
    const dir = s.tokens();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const tokens = { ann: 'sk-ant-oat01-Q7xP2mK9vL4nR8tW3yZ6hJ5c', bob: 'sk-ant-oat01-B3dF6gH9jK2mN5pR8sU1wY4z' };
    for (const [name, token] of Object.entries(tokens)) writeFileSync(join(dir, name), token);
    chmodSync(join(dir, 'ann'), 0o600);
    chmodSync(join(dir, 'bob'), 0o644);
    utimesSync(join(dir, 'ann'), new Date('2026-10-26T00:00:00Z'), new Date('2026-10-26T00:00:00Z'));
    writeFileSync(join(dir, '.ann.123.tmp'), 'half-written');
    const r = s.fac();
    const ann = r.out.split('\n').find((l) => /^\s*a\s+ann\b/.test(l));
    const bob = r.out.split('\n').find((l) => /^\s*b\s+bob\b/.test(l));
    assert.match(ann, /mode 600, modified 2026-10-26/);
    assert.doesNotMatch(ann, /should be/);
    assert.match(bob, /mode 644 \(should be 600\)/);
    assert.ok(!r.out.includes('half-written') && !r.out.includes('sub'));
    const all = `${r.out}\n${s.fac('--json').out}`;
    for (const token of Object.values(tokens)) for (let i = 0; i + 8 <= token.length; i += 1) assert.ok(!all.includes(token.slice(i, i + 8)), `a slice of a token at ${i}`);
  } finally {
    s.done();
  }
});

test('one hung vendor call cannot hang the table', () => {
  const s = sandbox();
  try {
    s.w('hang-claude', '');
    s.w('codex-default', '');
    s.env.FACTORY_TIMEOUT_MS = '300';
    const r = s.fac();
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
    const r = s.fac('--all');
    assert.equal(r.code, 0, r.out);
    for (const p of ['macbook/claude ', 'factory/seat-2', 'piggery/claude', 'piggery/codex']) assert.ok(rowOf(r.out, p), `${p} in\n${r.out}`);
    assert.match(s.calls(), /ssh .*factory@tuans-mac-mini zsh -lc '~\/WORKSPACES\/bin\/factory --json'/);
    assert.match(s.calls(), /ssh .*tuannguyen@tuans-mac-mini/);
    const j = JSON.parse(s.fac('--all', '--json').out);
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
    const r = s.fac('--all');
    assert.equal(r.code, 0, r.out);
    assert.match(rowOf(r.out, 'factory'), /Permission denied \(publickey\)\./);
    assert.match(rowOf(r.out, 'piggery'), /Could not resolve hostname/);
    assert.ok(rowOf(r.out, 'macbook/claude '));
  } finally {
    s.done();
  }
});

// ssh may print a warning on stderr, and a line there can start with "[" as a JSON list does (#180).
test('the factory rows are read from the far side\'s stdout only', () => {
  const s = sandbox();
  try {
    const rows = [{ place: 'factory', profile: 'factory/seat-2', role: 'worker', kind: 'Claude', loggedIn: true, account: 'ann.example', accountFrom: 'read', plan: 'max', five_hour: null, seven_day: null, asOf: null, live: 0, shared: [], login: 'x', note: '' }];
    s.w('ssh-factory.json', JSON.stringify(rows));
    s.w('ssh-factory.stderr', '[warning] Permanently added the host to the list of known hosts.\n');
    const j = JSON.parse(s.fac('--all', '--json').out);
    assert.equal(j.find((x) => x.profile === 'factory/seat-2')?.loggedIn, true, 'the rows were read');
    assert.ok(!j.some((x) => x.unreachable && x.place === 'factory'));
  } finally {
    s.done();
  }
});

// pig or ssh may print a warning on stderr before the command's output.
test('a line on stderr does not hide piggery\'s login', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, 'bin/pig'), `#!/bin/sh
echo "pig: a warning" >&2
c="$1"; shift
if [ "$c" = claude ]; then CLAUDE_CONFIG_DIR="$FAKE/piggery-claude" exec claude "$@"; else CODEX_HOME="$FAKE/piggery-codex" exec codex "$@"; fi
`);
    s.w('claude-piggery-claude.json', claudeJson('pig.one@secret-corp.example', 'max'));
    s.w('ssh-factory.error', 'ssh: Could not resolve hostname tuans-mac-mini\n');
    const rows = JSON.parse(s.fac('--all', '--json').out);
    const pig = rows.find((x) => x.profile === 'piggery/claude');
    assert.equal(pig.loggedIn, true);
    assert.equal(pig.account, 'pig.one');
  } finally {
    s.done();
  }
});

// codex login status exits 0 when logged in and 1 when not; any other exit (127 for a missing pig, 126, a failed shell) says
// nothing about the login (#180).
test('piggery\'s Codex row: exit 0 is yes, 1 is NO, and any other exit is "?" with the exit code', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.error', 'ssh: Could not resolve hostname tuans-mac-mini\n');
    s.w('claude-piggery-claude.json', claudeJson('pig.one@secret-corp.example', 'max'));
    const codex = () => JSON.parse(s.fac('--all', '--json').out).find((x) => x.profile === 'piggery/codex');
    assert.equal(codex().loggedIn, false);
    s.w('codex-piggery-codex', '');
    assert.equal(codex().loggedIn, true);
    writeFileSync(join(s.dir, 'bin/pig'), '#!/bin/sh\n[ "$1" = codex ] && exit 127\nexec claude "$@"\n');
    const row = codex();
    assert.equal(row.loggedIn, null);
    assert.match(row.note, /pig exited 127/);
    assert.match(rowOf(s.fac('--all').out, 'piggery/codex'), /\?.*pig exited 127/);
  } finally {
    s.done();
  }
});

test('a credential in the caller\'s environment reaches no vendor command', () => {
  const s = sandbox();
  try {
    const bin = join(s.dir, 'bin');
    for (const name of ['claude', 'gh']) {
      writeFileSync(join(bin, `${name}.real`), readFileSync(join(bin, name)));
      chmodSync(join(bin, `${name}.real`), 0o755);
      writeFileSync(join(bin, name), `#!/bin/sh
echo "$(basename "$0") GH_TOKEN=\${GH_TOKEN:+set} GITHUB_TOKEN=\${GITHUB_TOKEN:+set} ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY:+set} ANTHROPIC_AUTH_TOKEN=\${ANTHROPIC_AUTH_TOKEN:+set} CLAUDE_CODE_OAUTH_TOKEN=\${CLAUDE_CODE_OAUTH_TOKEN:+set}" >> "$FAKE/env.log"
exec "$0.real" "$@"
`);
      chmodSync(join(bin, name), 0o755);
    }
    s.w('claude-claude.json', claudeJson(EMAIL));
    s.w('gh-macbook', 'humangh');
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) s.env[name] = 'fake-credential';
    const r = s.fac();
    assert.equal(r.code, 0, r.out);
    const log = readFileSync(join(s.fake, 'env.log'), 'utf8');
    assert.match(log, /^claude /m);
    assert.match(log, /^gh /m);
    assert.doesNotMatch(log, /=set/);
  } finally {
    s.done();
  }
});

test('no part of a seat\'s token reaches the table or the JSON', () => {
  const s = sandbox();
  try {
    const token = 'sk-ant-oat01-Q7xP2mK9vL4nR8tW3yZ6hJ5c';
    mkdirSync(s.tokens(), { recursive: true });
    writeFileSync(join(s.tokens(), 'ann'), token);
    chmodSync(join(s.tokens(), 'ann'), 0o600);
    writeFileSync(join(s.state, 'accounts'), 'factory/seat-1=ann\n');
    s.onHost();
    const out = `${s.fac().out}\n${s.fac('--json').out}`;
    assert.match(out, /mode 600/);
    for (let i = 0; i + 8 <= token.length; i += 1) assert.ok(!out.includes(token.slice(i, i + 8)), `a slice of the token at ${i}`);
  } finally {
    s.done();
  }
});
