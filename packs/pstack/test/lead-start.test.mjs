// packs/pstack/bin/lead.mjs (#185): the start itself, in a copy of the launcher's own tree with a fake direnv and a fake claude on
// PATH (never a live one). The plugins install into the profile's root outside ~/.agent-profiles, and the Lead's claude gets that
// root as its plugin cache.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const real = fileURLToPath(new URL('../../..', import.meta.url));
const PSTACK = JSON.parse(readFileSync(join(real, 'packs/pstack/settings.json'), 'utf8'));
const node = `#!${process.execPath}`;

// direnv exec . printenv CLAUDE_CONFIG_DIR prints FAKE_CONFIG; direnv exec . <cmd> runs it. claude logs each call next to itself;
// next to it, plugin-mode makes a `plugin` call fail.
const DIRENV = `${node}
const [, , , cmd, ...rest] = process.argv.slice(1);
if (cmd === 'printenv') { if (process.env.FAKE_CONFIG) console.log(process.env.FAKE_CONFIG); else process.exit(1); }
else process.exit(require('child_process').spawnSync(cmd, rest, { stdio: 'inherit' }).status);
`;
const CLAUDE = `${node}
const fs = require('fs');
const dir = require('path').dirname(process.argv[1]);
const e = process.env;
fs.appendFileSync(dir + '/log.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), cache: e.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? null, config: e.CLAUDE_CONFIG_DIR ?? null }) + '\\n');
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
  writeFileSync(join(repo, '.gate/bin/setup'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
  w.leadFile = (name, repo = 'zalo') => join(w.home, 'factory-runs', `${repo}-lead`, name);
  w.log = () => (existsSync(join(w.bin, 'log.jsonl')) ? readFileSync(join(w.bin, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
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
    assert.equal(r.err.trim().split('\n').filter((l) => /^bin\/lead: note:/.test(l)).length, 1);
    assert.match(r.err, /bin\/lead: note: could not rename the Herdr pane/);
    assert.equal(w.log().at(-1).argv[0], '--model');
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
    assert.ok(!existsSync(join(w.home, '.agent-profiles')), 'nothing was made under the profiles');
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
    assert.ok(!existsSync(join(w.home, '.local')));
  }, { settings: { enabledPlugins: { 'other@mk': true } } }));
});
