// packs/pstack/bin/lead.mjs (#185): the start itself, in a copy of the launcher's own tree with a fake direnv and a fake claude on
// PATH (never a live one). The plugins install into the profile's root outside ~/.agent-profiles, and the Lead's claude gets that
// root as its plugin cache.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const real = fileURLToPath(new URL('../../..', import.meta.url));
const PSTACK = JSON.parse(readFileSync(join(real, 'packs/pstack/settings.json'), 'utf8'));
const node = `#!${process.execPath}`;

// direnv exec . printenv CLAUDE_CONFIG_DIR prints FAKE_CONFIG; direnv exec . <cmd> runs it. claude logs each call next to itself;
// next to it, plugin-mode makes a `plugin` call fail.
const DIRENV = `${node}
const [, , , cmd, ...rest] = process.argv.slice(1);
if (cmd === 'printenv') {
  if (process.env.FAKE_CONFIG) console.log(process.env.FAKE_CONFIG); else process.exit(1);
  const fs = require('fs'); // a vanish file next to it makes this the last call: the spawn of claude through direnv then fails
  if (fs.existsSync(require('path').dirname(process.argv[1]) + '/vanish')) fs.unlinkSync(process.argv[1]);
}
else process.exit(require('child_process').spawnSync(cmd, rest, { stdio: 'inherit' }).status);
`;
const CLAUDE = `${node}
const fs = require('fs');
const dir = require('path').dirname(process.argv[1]);
const e = process.env;
fs.appendFileSync(dir + '/log.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), cache: e.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? null, config: e.CLAUDE_CONFIG_DIR ?? null, token: e.CLAUDE_CODE_OAUTH_TOKEN ?? null, team: e.FACTORY_TEAM ?? null, scrub: e.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null }) + '\\n');
if (process.argv[2] === 'plugin' && fs.existsSync(dir + '/plugin-mode')) { console.error('boom'); process.exit(1); }
`;

// herdr logs its arguments next to itself; a herdr-mode file makes it fail.
const HERDR = `${node}
const fs = require('fs');
const dir = require('path').dirname(process.argv[1]);
fs.appendFileSync(dir + '/herdr.log', process.argv.slice(2).join(' ') + '\\n');
if (fs.existsSync(dir + '/herdr-mode')) { console.error('no such pane'); process.exit(1); }
`;

function world(body, { settings = PSTACK } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-start-'))); // the launcher finds its tree by realpath
  const w = { root, home: join(root, 'home'), tree: join(root, 'WORKSPACES'), bin: join(root, 'bin') };
  for (const d of [w.home, w.bin, join(w.tree, 'bin'), join(w.tree, 'packs/pstack/bin')]) mkdirSync(d, { recursive: true });
  cpSync(join(real, 'bin/lib'), join(w.tree, 'bin/lib'), { recursive: true });
  cpSync(join(real, 'packs/pstack/bin/lead.mjs'), join(w.tree, 'packs/pstack/bin/lead.mjs'));
  cpSync(join(real, 'packs/pstack/bin/transcript-copy.mjs'), join(w.tree, 'packs/pstack/bin/transcript-copy.mjs')); // copied into the run folder (#257)
  cpSync(join(real, 'packs/pstack/settings.json'), join(w.tree, 'packs/pstack/settings.json')); // the factory's pin
  writeFileSync(join(w.tree, 'packs/pstack/lead.md'), '# role\n');
  const repo = join(w.tree, 'zalo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.gate/bin'), { recursive: true });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.envrc'), 'x\n');
  writeFileSync(join(repo, '.gate/bin/setup'), '#!/bin/sh\n: > "$0.ran"\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify(settings));
  for (const [n, text] of [['direnv', DIRENV], ['claude', CLAUDE], ['herdr', HERDR]]) writeFileSync(join(w.bin, n), text, { mode: 0o755 });
  symlinkSync(process.execPath, join(w.bin, 'node')); // like /opt/homebrew/bin/node, a link to a Cellar path
  w.config = join(w.home, '.agent-profiles/o/zalo/claude');
  w.pluginRoot = join(w.home, '.local/share/factory/plugins/o/zalo/claude');
  w.env = (extra = {}) => ({ PATH: `${w.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.home, FAKE_CONFIG: w.config, ...extra });
  w.lead = (args = [], extra = {}) => {
    const r = spawnSync(process.execPath, [join(w.tree, 'packs/pstack/bin/lead.mjs'), 'zalo', ...args], { encoding: 'utf8', env: w.env(extra), timeout: 20000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  // a transcript copy as bin/transcript-copy.mjs leaves it, with the given mtime (seconds)
  w.copy = (name, mtime, repo = 'zalo') => {
    const dir = join(w.home, 'factory-runs', `${repo}-lead`, 'transcripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), 'x\n');
    utimesSync(join(dir, name), mtime, mtime);
  };
  w.herdr = () => (existsSync(join(w.bin, 'herdr.log')) ? readFileSync(join(w.bin, 'herdr.log'), 'utf8').split('\n').filter(Boolean) : []);
  // The rows of the teams lead and b of zalo (factory/<repo>-<team>, #311), and the account's token file (#179). The seat-1 and
  // lead-zalo lines are old lines of the file, which nothing reads any more.
  w.row = (account, token) => {
    const state = join(w.home, '.local/state/factory');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'accounts'), `factory/seat-1=ann\nfactory/lead-zalo=${account}\nfactory/zalo-lead=${account}\nfactory/zalo-b=${account}\nfactory/zalo-c=${account}\nfactory/zalo-${'a'.repeat(32)}=${account}\n`);
    if (token !== undefined) {
      mkdirSync(join(w.home, '.agent-profiles/tokens'), { recursive: true });
      writeFileSync(join(w.home, '.agent-profiles/tokens', account), `${token}\n`);
    }
  };
  w.leadFile = (name, repo = 'zalo') => join(w.home, 'factory-runs', `${repo}-lead`, name);
  w.log = () => (existsSync(join(w.bin, 'log.jsonl')) ? readFileSync(join(w.bin, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.row('ann', 'sk-ant-oat01-DEFAULTDEFAULT1234567890ab'); // a Lead with no row is refused (#179)
  w.ran = () => existsSync(join(repo, '.gate/bin/setup.ran'));
  try {
    return body(w);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('lead --dry-run', () => {
  test('prints the plugin root and the hook command, and runs nothing', () => world((w) => {
    const r = w.lead(['--dry-run']);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split('\n');
    assert.equal(lines[0], join(w.tree, 'zalo'));
    assert.equal(lines[1], 'plugins to ensure: pstack@pstack-4dd1d05');
    assert.equal(lines[2], `plugin root: ${w.pluginRoot}`);
    // The hook runs a copy in the Lead's run folder (#257); a dry run names it and makes none.
    assert.match(lines[3], new RegExp(`^transcript hook: '${w.bin}/node' '${w.home}/factory-runs/zalo-lead/hooks/transcript-copy-[0-9a-f]{7}\\.mjs' '${w.home}/factory-runs/zalo-lead/transcripts'$`));
    assert.ok(!existsSync(join(w.home, 'factory-runs')), 'a dry run copied nothing');
    assert.match(lines[4], /^direnv exec \. claude --model opus .* --settings \{"autoMemoryEnabled":false,"hooks":\{"SessionStart":/);
    assert.deepEqual(w.log(), []);
    assert.ok(!existsSync(w.pluginRoot));
  }));

  test('the hook names the node link PATH holds, not the file behind it; with no node on PATH it refuses to start', () => world((w) => {
    const r = w.lead(['--dry-run']);
    assert.ok(r.out.includes(`"command":"'${w.bin}/node' `), 'the hooks name the link');
    assert.ok(!r.out.includes(realpathSync(process.execPath)) || realpathSync(process.execPath) === join(w.bin, 'node'));
    const none = w.lead(['--dry-run'], { PATH: join(w.root, 'nowhere') });
    assert.equal(none.code, 2);
    assert.match(none.err, /bin\/lead: no node on PATH/);
    assert.equal(w.lead([], { PATH: join(w.root, 'nowhere') }).code, 2);
    assert.deepEqual(w.log(), []);
  }));

  test('refuses, with exit 1, a profile outside the profiles folder and a repository direnv gives none for', () => world((w) => {
    assert.match(w.lead(['--dry-run'], { FAKE_CONFIG: join(w.home, 'elsewhere') }).err, /bin\/lead: .* is not a folder under the profiles folder/);
    assert.equal(w.lead(['--dry-run'], { FAKE_CONFIG: join(w.home, 'elsewhere') }).code, 1);
    const r = w.lead(['--dry-run'], { FAKE_CONFIG: '' });
    assert.equal(r.code, 1);
    assert.match(r.err, /direnv gave no CLAUDE_CONFIG_DIR/);
  }));
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const resumed = (call) => (call.argv.includes('--resume') ? call.argv[call.argv.indexOf('--resume') + 1] : null);

describe('lead resumes by default', () => {
  test('the newest copy by mtime is resumed: --dry-run names it, a start gives claude --resume <id>', () => world((w) => {
    w.copy(`${B}.jsonl`, 3000);
    w.copy(`${A}.jsonl`, 4000);
    const r = w.lead(['--dry-run']);
    assert.match(r.out, new RegExp(`^session: resume ${A} \\(newest of 2 copies`, 'm'));
    assert.equal(w.lead().code, 0);
    assert.equal(resumed(w.log().at(-1)), A);
  }));

  test('with no copy it starts a new session, and --dry-run says so', () => world((w) => {
    const r = w.lead(['--dry-run']);
    assert.match(r.out, /^session: new \(no copy in /m);
    assert.ok(!r.out.includes('--resume'));
    assert.equal(w.lead().code, 0);
    assert.equal(resumed(w.log().at(-1)), null);
  }));

  test('--new starts a new session although a copy exists', () => world((w) => {
    w.copy(`${A}.jsonl`, 2000);
    const r = w.lead(['--dry-run', '--new']);
    assert.match(r.out, /^session: new \(--new\)$/m);
    assert.ok(!r.out.includes('--resume'));
    assert.equal(w.lead(['--new']).code, 0);
    assert.equal(resumed(w.log().at(-1)), null);
  }));

  test('a newer entry that is not a plain session id is never resumed', () => world((w) => {
    w.copy(`${A}.jsonl`, 1000);
    w.copy('not-an-id.jsonl', 5000);
    w.copy(`${B}.jsonl.tmp-123`, 6000);
    w.copy(`--${B}.jsonl`, 7000);
    mkdirSync(join(w.home, 'factory-runs/zalo-lead/transcripts', `${B}.jsonl`));
    assert.match(w.lead(['--dry-run']).out, new RegExp(`^session: resume ${A} `, 'm'));
  }));
});

describe('lead role.sha (#316)', () => {
  const HEAD = '[factory] your role changed:\n';
  const hashOf = (text) => createHash('sha256').update(text).digest('hex');
  const sha = (w) => w.leadFile('role.sha');
  const messageOf = (call) => {
    const at = call.argv.indexOf('--resume');
    return at < 0 || call.argv[at + 2].startsWith('--') ? null : call.argv[at + 2];
  };
  const setRole = (w, text) => writeFileSync(join(w.tree, 'packs/pstack/lead.md'), text);
  const recorded = (w, text) => {
    mkdirSync(dirname(sha(w)), { recursive: true });
    writeFileSync(sha(w), text);
  };

  test('a resume with no role.sha gives the role text, team filled in, as its first message, and records the hash (#316)', () => world((w) => {
    setRole(w, 'Lead of {{TEAM}}\nline two\n');
    w.copy(`${A}.jsonl`, 4000);
    assert.equal(w.lead(['--team', 'lead']).code, 0);
    const call = w.log().at(-1);
    assert.equal(messageOf(call), `${HEAD}Lead of lead\nline two\n`);
    assert.equal(readFileSync(sha(w), 'utf8'), `${hashOf('Lead of lead\nline two\n')} ${A}\n`);
    assert.equal(call.argv[call.argv.indexOf('--append-system-prompt') + 1], 'Lead of lead\nline two\n', 'the system prompt stays');
    assert.deepEqual(readdirSync(dirname(sha(w))).filter((f) => f.endsWith('.tmp')), []);
  }));

  test('a repository in the Linear registry gets only the Linear form of lead.md, any other only the GitHub form (#404)', () => world((w) => {
    setRole(w, 'Take: <!--github-->GH issue<!--/github--><!--linear-->LIN issue of {{TEAMKEY}}<!--/linear--> for {{TEAM}}.\n<!--linear-->Linear only\n<!--/linear-->\nend\n');
    const prompt = () => {
      const call = w.log().at(-1);
      return call.argv[call.argv.indexOf('--append-system-prompt') + 1];
    };
    assert.equal(w.lead(['--new']).code, 0);
    assert.equal(prompt(), 'Take: GH issue for lead.\nend\n');
    const registry = join(w.home, '.local/state/factory/linear/repos.json');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, JSON.stringify({ zalo: { key: 'ZAL', teamId: 't-1' } }));
    assert.equal(w.lead(['--new']).code, 0);
    assert.equal(prompt(), 'Take: LIN issue of ZAL for lead.\nLinear only\n\nend\n');
    writeFileSync(registry, JSON.stringify({ other: { key: 'OTH', teamId: 't-2' } }));
    assert.equal(w.lead(['--new']).code, 0);
    assert.equal(prompt(), 'Take: GH issue for lead.\nend\n');
  }));

  test('a registry file that does not parse stops the start, names the file, and starts no claude (#404)', () => world((w) => {
    const registry = join(w.home, '.local/state/factory/linear/repos.json');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, '{broken');
    for (const args of [[], ['--dry-run']]) {
      const r = w.lead(args);
      assert.equal(r.code, 2, r.err);
      assert.ok(r.err.includes(registry), r.err);
    }
    assert.deepEqual(w.log(), []);
  }));

  test('a resume with an equal role.sha gives no message and leaves the file as it is (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    recorded(w, `${hashOf('# role\n')} ${A}\n`);
    utimesSync(sha(w), 1000, 1000);
    assert.equal(w.lead().code, 0);
    const call = w.log().at(-1);
    assert.equal(messageOf(call), null);
    assert.equal(call.argv[call.argv.indexOf('--resume') + 2], '--allowedTools');
    assert.equal(readFileSync(sha(w), 'utf8'), `${hashOf('# role\n')} ${A}\n`);
    assert.equal(statSync(sha(w)).mtimeMs, 1000000, 'not written again');
  }));

  test('lead.md changed between two resumes: the message comes once, with the new text, and the third start gives none (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    recorded(w, `${hashOf('# role\n')} ${A}\n`);
    assert.equal(w.lead().code, 0);
    assert.equal(messageOf(w.log().at(-1)), null);
    setRole(w, '# role, new\n');
    assert.equal(w.lead().code, 0);
    assert.equal(messageOf(w.log().at(-1)), `${HEAD}# role, new\n`);
    assert.equal(readFileSync(sha(w), 'utf8'), `${hashOf('# role, new\n')} ${A}\n`);
    assert.equal(w.lead().code, 0);
    assert.equal(messageOf(w.log().at(-1)), null);
  }));

  test('a role.sha that is not one 64-character lowercase hex line counts as changed (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    const good = hashOf('# role\n');
    for (const text of ['', 'x\n', `${good.toUpperCase()} ${A}\n`, `${good} ${A}\n${good} ${A}\n`, `${good.slice(1)} ${A}\n`, `${good} ${A}x\n`, `${good}\n`, `${good} ${A}`]) {
      recorded(w, text);
      assert.equal(w.lead().code, 0);
      assert.equal(messageOf(w.log().at(-1)), `${HEAD}# role\n`, JSON.stringify(text));
      assert.equal(readFileSync(sha(w), 'utf8'), `${good} ${A}\n`);
    }
  }));

  test('a resume of another session than the recorded one gets the message, and the file then names it (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    recorded(w, `${hashOf('# role\n')} ${B}\n`);
    assert.equal(w.lead().code, 0);
    assert.equal(messageOf(w.log().at(-1)), `${HEAD}# role\n`);
    assert.equal(readFileSync(sha(w), 'utf8'), `${hashOf('# role\n')} ${A}\n`);
    assert.equal(w.lead().code, 0);
    assert.equal(messageOf(w.log().at(-1)), null, 'the same session with the same hash');
  }));

  test('--new after a change, then a resume of the older session, gives that session the message (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    recorded(w, `${hashOf('# role\n')} ${A}\n`);
    setRole(w, '# role, new\n');
    assert.equal(w.lead(['--new']).code, 0); // session B: it leaves no copy
    assert.equal(messageOf(w.log().at(-1)), null);
    assert.equal(w.lead().code, 0); // resumes A, which still holds the old text
    assert.equal(resumed(w.log().at(-1)), A);
    assert.equal(messageOf(w.log().at(-1)), `${HEAD}# role, new\n`);
  }));

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const sessionIdOf = (call) => call.argv[call.argv.indexOf('--session-id') + 1];

  test('a new session, with no copy and with --new, passes --session-id and records the hash with that id (#316)', () => world((w) => {
    recorded(w, `${hashOf('# role\n')} ${A}\n`);
    assert.equal(w.lead().code, 0);
    const first = w.log().at(-1);
    assert.ok(!first.argv.includes('--resume'));
    assert.equal(messageOf(first), null);
    assert.equal(first.argv[first.argv.indexOf('--append-system-prompt') + 1], '# role\n');
    assert.match(sessionIdOf(first), UUID);
    assert.equal(first.argv[first.argv.indexOf('--session-id') + 2], '--allowedTools');
    assert.equal(readFileSync(sha(w), 'utf8'), `${hashOf('# role\n')} ${sessionIdOf(first)}\n`);
    w.copy(`${A}.jsonl`, 4000);
    assert.equal(w.lead(['--new']).code, 0);
    const second = w.log().at(-1);
    assert.ok(!second.argv.includes('--resume'));
    assert.match(sessionIdOf(second), UUID);
    assert.notEqual(sessionIdOf(second), sessionIdOf(first));
    assert.equal(readFileSync(sha(w), 'utf8'), `${hashOf('# role\n')} ${sessionIdOf(second)}\n`);
  }));

  test('the first resume of a new session whose text has not changed gets no message, after no copy and after --new (#316)', () => world((w) => {
    for (const args of [[], ['--new']]) {
      if (args.length) w.copy(`${A}.jsonl`, 4000);
      assert.equal(w.lead(args).code, 0);
      const id = sessionIdOf(w.log().at(-1));
      w.copy(`${id}.jsonl`, 5000 + args.length);
      const before = readFileSync(sha(w), 'utf8');
      assert.equal(w.lead().code, 0);
      const call = w.log().at(-1);
      assert.equal(resumed(call), id);
      assert.ok(!call.argv.includes('--session-id'), 'a resume passes no --session-id');
      assert.equal(messageOf(call), null);
      assert.equal(readFileSync(sha(w), 'utf8'), before);
    }
  }));

  test('the first resume of a new session whose text changed since it started gets the message (#316)', () => world((w) => {
    assert.equal(w.lead().code, 0);
    const id = sessionIdOf(w.log().at(-1));
    w.copy(`${id}.jsonl`, 5000);
    setRole(w, '# role, new\n');
    assert.equal(w.lead().code, 0);
    assert.equal(messageOf(w.log().at(-1)), `${HEAD}# role, new\n`);
  }));

  test('a spawn that fails puts the earlier record back, or removes the file when there was none (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    writeFileSync(join(w.bin, 'vanish'), 'x'); // direnv answers printenv, then removes itself, so the spawn of claude fails
    const old = `${'cd'.repeat(32)} ${A}\n`;
    recorded(w, old);
    const r = w.lead();
    assert.equal(r.code, 1);
    assert.match(r.err, /bin\/lead: direnv: /);
    assert.equal(readFileSync(sha(w), 'utf8'), old);
  }));

  test('a spawn that fails with no earlier record leaves no role.sha (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    writeFileSync(join(w.bin, 'vanish'), 'x');
    const r = w.lead();
    assert.equal(r.code, 1);
    assert.match(r.err, /bin\/lead: direnv: /);
    assert.ok(!existsSync(sha(w)));
    assert.deepEqual(readdirSync(dirname(sha(w))).filter((f) => f.startsWith('role.sha')), []);
  }));

  test('a role.sha that cannot be written stops the start, says so, and never starts claude (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    mkdirSync(sha(w)); // a folder where the file goes
    const r = w.lead();
    assert.equal(r.code, 1);
    assert.match(r.err, /could not record the role text's hash/);
    assert.ok(!w.log().some((c) => c.argv[0] === '--model'), 'claude was not started');
    assert.deepEqual(readdirSync(dirname(sha(w))).filter((f) => f.endsWith('.tmp')), []);
  }));

  test('--dry-run writes no role.sha and says which role case the start is in (#316)', () => world((w) => {
    const line = (args) => /^role: .*$/m.exec(w.lead(['--dry-run', ...args]).out)?.[0];
    assert.match(line([]), /^role: new session, .*system prompt/);
    w.copy(`${A}.jsonl`, 4000);
    assert.match(line([]), /^role: no record, .*first message/);
    assert.match(line(['--new']), /^role: new session/);
    recorded(w, `${'ab'.repeat(32)} ${A}\n`);
    assert.match(line([]), /^role: changed since abababa, .*first message/);
    recorded(w, `${hashOf('# role\n')} ${B}\n`);
    assert.match(line([]), /^role: .*another session.*first message/);
    recorded(w, `${hashOf('# role\n')} ${A}\n`);
    assert.match(line([]), new RegExp(`^role: unchanged since ${hashOf('# role\n').slice(0, 7)}, no message`));
    const shown = w.lead(['--dry-run']).out;
    assert.ok(shown.split('\n').findIndex((l) => l.startsWith('role: ')) === shown.split('\n').findIndex((l) => l.startsWith('session: ')) + 1);
    assert.equal(readFileSync(sha(w), 'utf8'), `${hashOf('# role\n')} ${A}\n`);
    rmSync(sha(w));
    w.lead(['--dry-run']);
    assert.ok(!existsSync(sha(w)));
    assert.ok(!existsSync(dirname(sha(w))) || !existsSync(join(dirname(sha(w)), 'hooks')));
  }));

  test('--dry-run shows the message as a placeholder, as it does the role text (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    const r = w.lead(['--dry-run']);
    assert.ok(r.out.includes(`--resume ${A} <`), 'a placeholder follows the session id');
    assert.ok(!r.out.includes('your role changed'));
    assert.ok(!r.out.includes('--session-id'), 'a resume shows no new session id');
    const fresh = w.lead(['--dry-run', '--new']).out;
    assert.ok(fresh.includes('--session-id <new session id> '), 'a new session shows a placeholder for its id');
    assert.ok(!existsSync(sha(w)));
  }));

  test('a start refused or stopped before claude records nothing (#316)', () => world((w) => {
    w.copy(`${A}.jsonl`, 4000);
    rmSync(join(w.home, '.local/state/factory/accounts'));
    assert.equal(w.lead().code, 2);
    assert.ok(!existsSync(sha(w)));
    w.row('bob');
    assert.equal(w.lead().code, 2);
    assert.ok(!existsSync(sha(w)));
    w.row('bob', KEY);
    writeFileSync(join(w.bin, 'plugin-mode'), 'fail');
    assert.equal(w.lead().code, 1);
    assert.ok(!existsSync(sha(w)));
    rmSync(join(w.bin, 'plugin-mode'));
    const old = `${'cd'.repeat(32)} ${A}\n`;
    recorded(w, old);
    rmSync(join(w.home, '.local/state/factory/accounts'));
    assert.equal(w.lead().code, 2);
    assert.equal(readFileSync(sha(w), 'utf8'), old, 'a refused start leaves an earlier record');
  }));
});

describe('lead --team (#196)', () => {
  const nameOf = (call) => call.argv[call.argv.indexOf('--name') + 1];
  const roleOf = (call) => call.argv[call.argv.indexOf('--append-system-prompt') + 1];

  test('a name outside a letter then at most 31 lowercase letters and digits is refused before anything runs, in the launcher (#196)', () => world((w) => {
    for (const team of ['a-b', 'a/b', '1a', 'A', 'aB', 'a'.repeat(33), '', '-x', 'a b']) {
      const r = w.lead(['--team', team]);
      assert.equal(r.code, 2, JSON.stringify(team));
      assert.match(r.err, /team/, JSON.stringify(team));
    }
    for (const args of [['--team'], ['--team', 'b', '--team', 'c'], ['--team', '--new']]) assert.equal(w.lead(args).code, 2, args.join(' '));
    assert.equal(w.lead(['--team', 'a'.repeat(32), '--dry-run']).code, 0, '32 characters are allowed');
    assert.deepEqual(w.log(), []);
    assert.ok(!w.ran());
    assert.ok(!existsSync(join(w.home, 'factory-runs')));
  }));

  test('--team b names the session zalo-b, keeps its folder, pane and name there, and hooks its transcripts there (#196)', () => world((w) => {
    const dry = w.lead(['--team', 'b', '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /^team: b$/m);
    assert.match(dry.out, new RegExp(`^transcript hook: '${w.bin}/node' '${w.home}/factory-runs/zalo-b/hooks/transcript-copy-[0-9a-f]{7}\\.mjs' '${w.home}/factory-runs/zalo-b/transcripts'$`, 'm'));
    assert.equal(w.lead(['--team', 'b'], { HERDR_PANE_ID: 'p-7' }).code, 0);
    assert.equal(nameOf(w.log().at(-1)), 'zalo-b');
    assert.equal(readFileSync(join(w.home, 'factory-runs/zalo-b/pane'), 'utf8').trim(), 'p-7');
    assert.ok(existsSync(join(w.home, 'factory-runs/zalo-b/name')));
    assert.ok(readdirSync(join(w.home, 'factory-runs/zalo-b/hooks')).some((f) => /^transcript-copy-[0-9a-f]{7}\.mjs$/.test(f)));
    assert.ok(!existsSync(join(w.home, 'factory-runs/zalo-lead')), 'the default team\'s folder is not made');
    // the account row is the team's own (#311)
    assert.match(w.lead(['--team', 'b', '--dry-run']).out, /^account: ann \(row factory\/zalo-b\)$/m);
    assert.match(w.lead(['--dry-run']).out, /^account: ann \(row factory\/zalo-lead\)$/m);
  }));

  test('each team starts on its own row, with FACTORY_TEAM=<repo>-<team> in claude\'s environment; a team with no row is refused (#311)', () => world((w) => {
    assert.equal(w.lead(['--team', 'b']).code, 0);
    assert.equal(w.log().at(-1).team, 'zalo-b');
    assert.equal(w.lead().code, 0);
    assert.equal(w.log().at(-1).team, 'zalo-lead');
    assert.equal(w.log().filter((c) => c.argv[0] !== '--model').every((c) => c.team === null), true, 'the plugin installs do not get it');
    const none = w.lead(['--team', 'd']);
    assert.equal(none.code, 2);
    assert.match(none.err, /factory use zalo-d <letter>/);
    assert.match(none.err, /row factory\/zalo-d/);
    const before = w.log().length;
    assert.equal(w.lead(['--team', 'd', '--dry-run']).code, 2);
    assert.equal(w.log().length, before);
    // an inherited FACTORY_TEAM is replaced, never kept
    assert.equal(w.lead(['--team', 'b'], { FACTORY_TEAM: 'other-lead' }).code, 0);
    assert.equal(w.log().at(-1).team, 'zalo-b');
  }));

  test('with no --team the team is lead: zalo-lead, as today, and the dry run says so (#196)', () => world((w) => {
    assert.match(w.lead(['--dry-run']).out, /^team: lead$/m);
    assert.equal(w.lead().code, 0);
    assert.equal(nameOf(w.log().at(-1)), 'zalo-lead');
    assert.ok(existsSync(join(w.home, 'factory-runs/zalo-lead/name')));
  }));

  test('a team resumes from its own transcripts and a new team from none; the teams hold different animals (#196)', () => world((w) => {
    const B2 = '33333333-3333-4333-8333-333333333333';
    mkdirSync(join(w.home, 'factory-runs/zalo-b/transcripts'), { recursive: true });
    writeFileSync(join(w.home, 'factory-runs/zalo-b/transcripts', `${B2}.jsonl`), 'x\n');
    w.copy(`${A}.jsonl`, 4000); // the default team's
    assert.match(w.lead(['--team', 'b', '--dry-run']).out, new RegExp(`^session: resume ${B2} `, 'm'));
    assert.match(w.lead(['--team', 'c', '--dry-run']).out, /^session: new \(no copy in /m);
    assert.match(w.lead(['--dry-run']).out, new RegExp(`^session: resume ${A} `, 'm'));
    assert.equal(w.lead().code, 0);
    assert.equal(w.lead(['--team', 'b']).code, 0);
    const a = readFileSync(join(w.home, 'factory-runs/zalo-lead/name'), 'utf8');
    const b = readFileSync(join(w.home, 'factory-runs/zalo-b/name'), 'utf8');
    assert.notEqual(a, b);
  }));

  test('the role text gets the team in its three places and no token is left in what claude gets (#196)', () => world((w) => {
    writeFileSync(join(w.tree, 'packs/pstack/lead.md'), readFileSync(join(real, 'packs/pstack/lead.md')));
    for (const [args, team] of [[['--team', 'b'], 'b'], [[], 'lead']]) {
      assert.equal(w.lead(args).code, 0);
      const text = roleOf(w.log().at(-1));
      assert.ok(text.includes(`You are the Lead of team \`${team}\``), team);
      assert.ok(text.includes(`.gate/bin/claim <n> ${team}`), team);
      assert.ok(text.includes(`Team: ${team}`), team);
      assert.ok(!/\{\{|\}\}/.test(text), 'no token is left');
      assert.ok(!text.includes('pstack`'), 'the old fixed team is gone');
    }
  }));
});

describe('lead name (#286)', () => {
  test('a start picks a free animal once and keeps it; another Lead\'s name is held, a dry run writes none', () => world((w) => {
    assert.equal(w.lead(['--dry-run']).code, 0);
    assert.ok(!existsSync(w.leadFile('name')));
    mkdirSync(join(w.home, 'factory-runs/other-lead'), { recursive: true });
    writeFileSync(w.leadFile('name', 'other'), 'aardvark\n');
    assert.equal(w.lead().code, 0);
    assert.equal(readFileSync(w.leadFile('name'), 'utf8'), 'badger\n');
    rmSync(w.leadFile('name', 'other'));
    assert.equal(w.lead().code, 0);
    assert.equal(readFileSync(w.leadFile('name'), 'utf8'), 'badger\n', 'kept across restarts');
  }));

  test('inside a Herdr pane the pane id is kept and the pane is renamed to the name', () => world((w) => {
    assert.equal(w.lead([], { HERDR_PANE_ID: 'p-7' }).code, 0);
    assert.equal(readFileSync(w.leadFile('pane'), 'utf8').trim(), 'p-7');
    assert.deepEqual(w.herdr(), ['pane rename p-7 aardvark']);
  }));

  test('outside Herdr nothing is renamed and no pane file is written', () => world((w) => {
    assert.equal(w.lead().code, 0);
    assert.deepEqual(w.herdr(), []);
    assert.ok(!existsSync(w.leadFile('pane')));
  }));

  test('a rename that fails prints one note line and the start goes on', () => world((w) => {
    writeFileSync(join(w.bin, 'herdr-mode'), 'fail');
    const r = w.lead([], { HERDR_PANE_ID: 'p-7' });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err.trim().split('\n').filter((l) => /^bin\/lead: note: could not rename/.test(l)).length, 1);
    assert.match(r.err, /bin\/lead: note: could not rename the Herdr pane/);
    assert.equal(w.log().at(-1).argv[0], '--model');
  }));
});

const KEY = 'sk-ant-oat01-LEADLEADLEAD1234567890abcd';

describe('lead token (#179)', () => {
  test('the row\'s token reaches claude\'s environment alone, with no scrub and in auto mode, and no output holds it (#179)', () => world((w) => {
    w.row('bob', KEY);
    const r = w.lead([], { HERDR_PANE_ID: 'p-7' });
    assert.equal(r.code, 0, r.err);
    const calls = w.log();
    const start = calls.at(-1);
    assert.equal(start.argv[0], '--model');
    assert.equal(start.token, KEY);
    assert.equal(start.scrub, null);
    assert.equal(start.argv[start.argv.indexOf('--permission-mode') + 1], 'auto');
    assert.deepEqual(calls.slice(0, -1).map((c) => c.token), [null, null], 'the plugin installs never see it');
    assert.ok(!`${r.out}${r.err}${w.herdr().join('\n')}`.includes(KEY));
  }));

  test('--dry-run names the row and its account and never the token (#311)', () => world((w) => {
    w.row('bob', KEY);
    const r = w.lead(['--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^account: bob \(row factory\/zalo-lead\)$/m);
    assert.ok(!`${r.out}${r.err}`.includes(KEY));
    assert.deepEqual(w.log(), []);
  }));

  test('with no row nothing runs: exit 2, the command to run, and a dry run says the same (#311)', () => world((w) => {
    rmSync(join(w.home, '.local/state/factory/accounts'));
    for (const args of [[], ['--dry-run']]) {
      const r = w.lead(args, { HERDR_PANE_ID: 'p-7' });
      assert.equal(r.code, 2);
      assert.match(r.err, /factory use zalo-lead <letter>/);
      assert.match(r.err, /`factory`/);
    }
    assert.ok(!w.ran() && !existsSync(w.leadFile('pane')) && !existsSync(w.config));
    assert.deepEqual([w.log(), w.herdr()], [[], []]);
  }));

  test('a row whose account has no token file refuses the start with exit 2 and names factory login (#179)', () => world((w) => {
    w.row('bob');
    const r = w.lead();
    assert.equal(r.code, 2);
    assert.match(r.err, /factory login bob/);
    assert.ok(!w.ran() && !existsSync(w.config), 'refused before setup');
    assert.ok(!w.log().some((c) => c.argv[0] === '--model'), 'claude was not started');
  }));

  test('a malformed token file refuses the start with exit 2 and quotes nothing of it (#179)', () => world((w) => {
    w.row('bob', 'SECRETPART bad\u0001token');
    const r = w.lead();
    assert.equal(r.code, 2);
    assert.match(r.err, /bin\/lead: .*not printable ASCII/);
    assert.ok(!`${r.out}${r.err}`.includes('SECRETPART'));
    assert.ok(!w.ran() && !existsSync(w.config), 'refused before setup');
    assert.ok(!w.log().some((c) => c.argv[0] === '--model'));
  }));

  test('an account name that is not a plain account name refuses the start (#179)', () => world((w) => {
    w.row('../bob', KEY);
    const r = w.lead();
    assert.equal(r.code, 2);
    assert.ok(!w.log().some((c) => c.argv[0] === '--model'));
  }));
});

describe('lead onboarding key (#179)', () => {
  const file = (w) => join(w.config, '.claude.json');

  test('a fresh profile gets hasCompletedOnboarding true, mode 600, and no trust key (#179)', () => world((w) => {
    assert.equal(w.lead().code, 0);
    assert.deepEqual(JSON.parse(readFileSync(file(w), 'utf8')), { hasCompletedOnboarding: true });
    assert.equal((statSync(file(w)).mode & 0o777).toString(8), '600');
    assert.deepEqual(readdirSync(w.config), ['.claude.json'], 'no temporary file is left');
  }));

  test('a file that holds other keys keeps them and its mode (#179)', () => world((w) => {
    mkdirSync(w.config, { recursive: true });
    writeFileSync(file(w), '{"projects":{"/x":{"hasTrustDialogAccepted":true}},"hasCompletedOnboarding":false}');
    chmodSync(file(w), 0o640);
    assert.equal(w.lead().code, 0);
    assert.deepEqual(JSON.parse(readFileSync(file(w), 'utf8')), { projects: { '/x': { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true });
    assert.equal((statSync(file(w)).mode & 0o777).toString(8), '640');
  }));

  test('a file that already says true is left byte for byte (#179)', () => world((w) => {
    mkdirSync(w.config, { recursive: true });
    const text = '{ "hasCompletedOnboarding": true,\n  "x": [1,\n2] }';
    writeFileSync(file(w), text);
    assert.equal(w.lead().code, 0);
    assert.equal(readFileSync(file(w), 'utf8'), text);
  }));

  test('a dry run writes nothing (#179)', () => world((w) => {
    assert.equal(w.lead(['--dry-run']).code, 0);
    assert.ok(!existsSync(w.config));
  }));

  test('a file that does not parse, or is not an object, refuses the start and is left as it is (#179)', () => world((w) => {
    mkdirSync(w.config, { recursive: true });
    for (const text of ['{not json', '[1]', 'null']) {
      writeFileSync(file(w), text);
      const r = w.lead();
      assert.equal(r.code, 2, text);
      assert.match(r.err, /bin\/lead: .*\.claude\.json/);
      assert.equal(readFileSync(file(w), 'utf8'), text);
    }
    assert.ok(!w.ran());
    assert.ok(!w.log().some((c) => c.argv[0] === '--model'));
  }));
});

describe('lead start', () => {
  test('installs into the root, then starts claude with the root as its plugin cache', () => world((w) => {
    const r = w.lead();
    assert.equal(r.code, 0, r.err);
    const calls = w.log();
    assert.deepEqual(calls.map((c) => c.argv.slice(0, 3)), [['plugin', 'marketplace', 'add'], ['plugin', 'install', 'pstack@pstack-4dd1d05'], ['--model', 'opus', '--effort']]);
    const install = join(w.home, '.local/share/factory/plugin-install/o/zalo/claude');
    for (const c of calls.slice(0, 2)) assert.deepEqual([c.config, c.cache], [install, w.pluginRoot]);
    assert.equal(calls[2].cache, w.pluginRoot);
    assert.ok(calls[2].argv.includes('--settings'));
    assert.deepEqual(readdirSync(w.config), ['.claude.json'], 'the profile got the onboarding key and nothing else');
  }));

  test('a failed install stops the start, with the reason', () => world((w) => {
    writeFileSync(join(w.bin, 'plugin-mode'), 'fail');
    const r = w.lead();
    assert.equal(r.code, 1);
    assert.match(r.err, /bin\/lead: plugins: claude plugin marketplace add exited 1: boom/);
    assert.deepEqual(w.log().map((c) => c.argv[0]), ['plugin']);
  }));

  test('an enabled plugin that is not the factory\'s pin stops the start, with nothing installed', () => world((w) => {
    const r = w.lead();
    assert.equal(r.code, 1);
    assert.match(r.err, /bin\/lead: plugins: .* enables other@mk, but only the factory's pin/);
    assert.deepEqual(w.log(), []);
    assert.ok(!existsSync(join(w.home, '.local/share')));
  }, { settings: { enabledPlugins: { 'other@mk': true } } }));
});
