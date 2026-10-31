// packs/pstack/bin/lead.mjs (#185): the start itself, in a copy of the launcher's own tree with a fake direnv and a fake claude on
// PATH (never a live one). The plugins install into the profile's root outside ~/.agent-profiles, and the Lead's claude gets that
// root as its plugin cache.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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

function world(body, { settings = PSTACK } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-start-'))); // the launcher finds its tree by realpath
  const w = { root, home: join(root, 'home'), tree: join(root, 'WORKSPACES'), bin: join(root, 'bin') };
  for (const d of [w.home, w.bin, join(w.tree, 'bin'), join(w.tree, 'packs/pstack/bin')]) mkdirSync(d, { recursive: true });
  cpSync(join(real, 'bin/lib'), join(w.tree, 'bin/lib'), { recursive: true });
  cpSync(join(real, 'packs/pstack/bin/lead.mjs'), join(w.tree, 'packs/pstack/bin/lead.mjs'));
  cpSync(join(real, 'packs/pstack/bin/lead'), join(w.tree, 'packs/pstack/bin/lead'));
  cpSync(join(real, 'packs/pstack/settings.json'), join(w.tree, 'packs/pstack/settings.json')); // the factory's pin
  writeFileSync(join(w.tree, 'packs/pstack/lead.md'), '# role\n');
  const repo = join(w.tree, 'zalo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, '.gate/bin'), { recursive: true });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.envrc'), 'x\n');
  writeFileSync(join(repo, '.gate/bin/setup'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify(settings));
  for (const [n, text] of [['direnv', DIRENV], ['claude', CLAUDE]]) writeFileSync(join(w.bin, n), text, { mode: 0o755 });
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
    assert.equal(lines[3], `transcript hook: '${w.bin}/node' '${w.tree}/packs/pstack/bin/transcript-copy.mjs' '${w.home}/factory-runs/zalo-lead/transcripts'`);
    assert.match(lines[4], /^direnv exec \. claude --model opus .* --settings \{"hooks":\{"Stop":/);
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
  test('--dry-run says it would resume the newest copy by mtime, and why', () => world((w) => {
    w.copy(`${A}.jsonl`, 2000);
    w.copy(`${B}.jsonl`, 3000);
    w.copy('33333333-3333-4333-8333-333333333333.jsonl', 1000);
    const r = w.lead(['--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^session: resume ${B} \\(newest of 3 copies in ${join(w.home, 'factory-runs/zalo-lead/transcripts')}\\)$`, 'm'));
    assert.match(r.out, new RegExp(` --resume ${B} `));
    assert.ok(!r.out.includes('--continue'));
  }));

  test('a start gives claude --resume <id> of the newest copy', () => world((w) => {
    w.copy(`${B}.jsonl`, 3000);
    w.copy(`${A}.jsonl`, 4000);
    const r = w.lead();
    assert.equal(r.code, 0, r.err);
    const start = w.log().at(-1);
    assert.equal(resumed(start), A);
    assert.ok(!start.argv.includes('--continue'));
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

  test('--continue is no option any more: exit 2, naming --new', () => world((w) => {
    const r = w.lead(['--continue']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown option --continue/);
    assert.match(r.err, /--new/);
    assert.deepEqual(w.log(), []);
  }));

  test('a newer entry that is not a plain session id is never resumed', () => world((w) => {
    w.copy(`${A}.jsonl`, 1000);
    w.copy('not-an-id.jsonl', 5000);
    w.copy(`${B}.jsonl.tmp-123`, 6000);
    w.copy(`--${B}.jsonl`, 7000);
    mkdirSync(join(w.home, 'factory-runs/zalo-lead/transcripts', `${B}.jsonl`));
    const r = w.lead(['--dry-run']);
    assert.match(r.out, new RegExp(`^session: resume ${A} `, 'm'));
    const none = join(w.home, 'factory-runs/zalo-lead/transcripts', `${A}.jsonl`);
    rmSync(none);
    assert.match(w.lead(['--dry-run']).out, /^session: new /m);
  }));

  test('another repository\'s copies are not this one\'s', () => world((w) => {
    w.copy(`${A}.jsonl`, 2000, 'other');
    assert.match(w.lead(['--dry-run']).out, /^session: new /m);
  }));
});

describe('lead through a symlink', () => {
  test('the shim finds lead.mjs by the real path: absolute link, relative link, a link to a link, from another cwd', () => world((w) => {
    const target = join(w.tree, 'packs/pstack/bin/lead');
    const bin = join(w.home, '.local/bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(target, join(bin, 'lead'));
    symlinkSync(relative(bin, target), join(bin, 'rel'));
    symlinkSync(join(bin, 'lead'), join(bin, 'chain'));
    const elsewhere = join(w.root, 'elsewhere');
    mkdirSync(elsewhere);
    for (const name of ['lead', 'rel', 'chain']) {
      const r = spawnSync(join(bin, name), ['zalo', '--dry-run'], { cwd: elsewhere, encoding: 'utf8', env: w.env(), timeout: 20000 });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(r.stdout.split('\n')[0], join(w.tree, 'zalo'), name);
    }
    assert.deepEqual(w.log(), []);
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
