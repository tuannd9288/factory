// #177, #390: bin/install-factory. Run from a clone, it makes the machine's installed copy of the factory (or brings it to origin/main), runs
// that copy's own bin/install-factory, and that points ~/.local/bin/factory at the copy's bin/factory, replacing nothing else; on the MacBook
// it also loads the relay's LaunchAgent. Each test runs it under a temporary HOME, against a local bare repository as the origin and a fake
// launchctl and ssh first on PATH; nothing here touches the real ~/.local/bin, ~/Library or ~/WORKSPACES, and nothing reaches the network.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { factory, git, quiet, run } from './helpers.mjs';

const COPIED = ['bin', 'packs', 'kit'];

/** An origin (a bare repository) that holds this clone's code as one commit on main, and a HOME with fake launchctl and ssh. */
function world(f) {
  // The real path: the script links to the copy's real path, and tmpdir() may be a link (macOS's /tmp, /var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-install-')));
  try {
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    for (const name of COPIED) cpSync(join(factory, name), join(seed, name), { recursive: true, filter: (p) => !p.includes('node_modules') });
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'the code');
    const origin = join(dir, 'origin.git');
    git(dir, 'clone', '-q', '--bare', seed, origin);
    const home = join(dir, 'home');
    const fake = join(dir, 'fake');
    mkdirSync(home);
    mkdirSync(fake);
    writeFileSync(join(fake, 'launchctl'), ['#!/bin/sh', 'echo "$*" >>"$HOME/launchctl.log"', // $HOME/linger counts how many more prints still find the job after a bootout, and a bootstrap in that gap fails (the race).
      // Each job is loaded or not by its label: the last part of print's and bootout's target, the plist's name for bootstrap.
      'n=$(cat "$HOME/linger" 2>/dev/null || echo 0)', 'case "$1" in',
      'print) [ -f "$HOME/loaded-${2##*/}" ] && exit 0; [ "$n" -gt 0 ] || exit 1; echo $((n - 1)) >"$HOME/linger" ;;',
      'bootstrap) [ "$n" -eq 0 ] || exit 5; : >"$HOME/loaded-$(basename "$3" .plist)" ;;', 'bootout) rm -f "$HOME/loaded-${2##*/}" ;;', 'esac', ''].join('\n'));
    writeFileSync(join(fake, 'ssh'), ['#!/bin/sh', 'case "$*" in *--newest*) echo 4 ;; esac', ''].join('\n'));
    // #366: gh as the queue's check meets it on the MacBook: the agents with their token in GH_TOKEN, the Human otherwise.
    writeFileSync(join(fake, 'gh'), ['#!/bin/sh', 'case "$*" in', '  "api user"*) if [ "$GH_TOKEN" = made-up-agents-token ]; then echo agent-bot; else echo tuannd9288; fi ;;', '  *) exit 1 ;;', 'esac', ''].join('\n'));
    for (const name of ['launchctl', 'ssh', 'gh']) chmodSync(join(fake, name), 0o755);
    // The agents' GitHub token in the node's own store (#366); a test takes it away to see the queue's check refuse.
    mkdirSync(join(dir, 'profiles/tokens'), { recursive: true });
    writeFileSync(join(dir, 'profiles/tokens/fake-agent'), 'made-up-agents-token\n');
    const w = {
      dir, home, origin, seed,
      root: join(home, '.local/share/factory/checkout'),
      link: join(home, '.local/bin/factory'),
      plist: join(home, 'Library/LaunchAgents/io.github.tuannd9288.factory.relay.plist'),
      // The code that runs is the clone's own bin/install-factory, whose HOME and place are the test's.
      install: (args = [], env = {}, from = join(factory, 'bin/install-factory')) =>
        run(factory, 'bash', [from, ...args], {
          HOME: home, PATH: `${fake}:${process.env.PATH}`, FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'),
          FACTORY_INSTALL_ORIGIN: origin, FACTORY_HOST_USER: 'nobody-here', FACTORY_CHECKOUT: '', XDG_DATA_HOME: '',
          AGENT_PROFILES: join(dir, 'profiles'), FACTORY_AGENT: 'fake-agent', ...env,
        }),
      launchctl: () => (existsSync(join(home, 'launchctl.log')) ? readFileSync(join(home, 'launchctl.log'), 'utf8').split('\n').filter(Boolean) : []),
      push: (text) => {
        writeFileSync(join(seed, 'note'), text);
        git(seed, 'add', '-A');
        git(seed, 'commit', '-qm', text);
        git(seed, 'push', '-q', origin, 'main');
        return git(seed, 'rev-parse', 'HEAD');
      },
    };
    return f(w);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('from a clone it makes the installed copy, links factory to the copy\'s bin/factory, and can be run again', () => world((w) => {
  const r = w.install();
  assert.equal(r.code, 0, r.out);
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), git(w.origin, 'rev-parse', 'main'));
  assert.equal(git(w.root, 'branch', '--show-current'), 'main');
  assert.equal(readlinkSync(w.link), join(w.root, 'bin/factory'));
  assert.ok(existsSync(w.link), 'the link reaches bin/factory');
  assert.ok(!readlinkSync(w.link).startsWith(factory), 'the link does not lead back into the clone that ran it');
  const again = w.install();
  assert.equal(again.code, 0, again.out);
  assert.equal(readlinkSync(w.link), join(w.root, 'bin/factory'));
}));

test('the copy\'s fetch is anonymous: its own config holds an empty credential.helper', () => world((w) => {
  assert.equal(w.install().code, 0);
  const r = run(w.root, 'git', ['config', '--local', '--get-all', 'credential.helper'], quiet);
  assert.equal(r.code, 0);
  assert.equal(r.out, '\n');
}));

test('a second run brings the copy to the commit main moved to, and leaves it be, with the refusal told, when a local change is in the way', () => world((w) => {
  assert.equal(w.install().code, 0);
  const tip = w.push('second');
  const r = w.install();
  assert.equal(r.code, 0, r.out);
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), tip);
  // A refusal is told in queue-checkout.failed; the copy stays where it was and the run goes on with it.
  const later = w.push('third');
  writeFileSync(join(w.root, 'note'), 'an edit');
  const refused = w.install();
  assert.equal(refused.code, 0, refused.out);
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), tip);
  assert.ok(existsSync(join(w.dir, 'state/queue-checkout.failed')));
  assert.notEqual(later, tip);
}));

test('it refuses a folder where the copy goes when that is not a clone, and leaves it as it is', () => world((w) => {
  mkdirSync(w.root, { recursive: true });
  writeFileSync(join(w.root, 'mine'), 'x');
  const r = w.install();
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(join(w.root, 'mine'), 'utf8'), 'x');
  assert.ok(!existsSync(join(w.root, '.git')));
  assert.ok(!existsSync(w.link));
}));

test('the command runs through the link', () => world((w) => {
  assert.equal(w.install().code, 0);
  const r = run(w.dir, w.link, ['--bogus'], { HOME: w.home });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /usage: bin\/factory/);
}));

test('keeps the folder\'s other files, and an existing ~/.local/bin', () => world((w) => {
  mkdirSync(join(w.home, '.local/bin'), { recursive: true });
  writeFileSync(join(w.home, '.local/bin/other'), 'x');
  assert.equal(w.install().code, 0);
  assert.equal(readFileSync(join(w.home, '.local/bin/other'), 'utf8'), 'x');
  assert.equal(readlinkSync(w.link), join(w.root, 'bin/factory'));
}));

test('it replaces a link whose target ends in /bin/factory (the old one into a dev clone), and refuses a file, a folder or any other link', () => world((w) => {
  mkdirSync(join(w.home, '.local/bin'), { recursive: true });
  symlinkSync('/Users/someone/Desktop/TuanHub/tools/factory/bin/factory', w.link);
  let r = w.install();
  assert.equal(r.code, 0, r.out);
  assert.equal(readlinkSync(w.link), join(w.root, 'bin/factory'));
  const loaded = w.launchctl().length;
  rmSync(w.link);
  writeFileSync(w.link, 'my own factory');
  r = w.install();
  assert.notEqual(r.code, 0);
  assert.match(r.out, new RegExp(w.link.replace(/[.]/g, '\\.')));
  assert.equal(readFileSync(w.link, 'utf8'), 'my own factory');
  rmSync(w.link);
  mkdirSync(w.link);
  assert.notEqual(w.install().code, 0);
  assert.ok(lstatSync(w.link).isDirectory());
  rmSync(w.link, { recursive: true });
  symlinkSync('/somewhere/else/factory', w.link);
  assert.notEqual(w.install().code, 0);
  assert.equal(readlinkSync(w.link), '/somewhere/else/factory');
  rmSync(w.link);
  symlinkSync(join(w.dir, 'missing'), w.link);
  assert.notEqual(w.install().code, 0, 'a dangling link is not ours either');
  assert.equal(readlinkSync(w.link), join(w.dir, 'missing'));
  assert.equal(w.launchctl().length, loaded, 'a refused link loads nothing');
}));

test('on the MacBook it writes the relay\'s LaunchAgent and the queue\'s for the copy through a rename, loads them, and runs their checks (#366)', () => world((w) => {
  const r = w.install();
  assert.equal(r.code, 0, r.out);
  const text = readFileSync(w.plist, 'utf8');
  assert.ok(text.includes(join(w.root, 'bin/factory-relay')));
  assert.ok(!text.includes(factory), 'the job names nothing of the clone that ran it');
  const queue = join(w.home, 'Library/LaunchAgents/io.github.tuannd9288.factory.queue.plist');
  assert.deepEqual(readdirSync(join(w.home, 'Library/LaunchAgents')).sort(), ['io.github.tuannd9288.factory.queue.plist', 'io.github.tuannd9288.factory.relay.plist']);
  // The node's daemon starts from the copy's queue job, which follows the copy, runs as his user and holds no token.
  const job = readFileSync(queue, 'utf8');
  assert.ok(job.includes(join(w.root, 'bin/factory-queue')) && !job.includes(factory), job);
  assert.match(job, new RegExp(`<key>FACTORY_CHECKOUT</key>\\s*<string>${w.root}</string>`));
  assert.doesNotMatch(job, /UserName|made-up-agents-token/);
  const calls = w.launchctl();
  for (const plist of [w.plist, queue]) assert.ok(calls.some((c) => c.startsWith('bootstrap gui/') && c.endsWith(plist)), calls.join('\n'));
  assert.ok(!calls.some((c) => c.startsWith('bootout')), 'nothing was loaded to unload');
  assert.match(r.out, /check: ready/);
  assert.match(r.out, /^check: gh login agent-bot$/m);
  assert.match(r.out, /^check: ready; the Human loads the job$/m);
  // Without the agents' token in the node's store, the queue's check is not ready and says why, and so is the run.
  rmSync(join(w.dir, 'profiles/tokens/fake-agent'));
  const without = w.install();
  assert.notEqual(without.code, 0, without.out);
  assert.match(without.out, /^check: not ready: this node holds no GitHub token for the agents/m);
}));

test('a loaded job is unloaded before the new one is loaded', () => world((w) => {
  assert.equal(w.install().code, 0);
  const before = w.launchctl().length;
  assert.equal(w.install().code, 0);
  const calls = w.launchctl().slice(before);
  const out = calls.findIndex((c) => c.startsWith('bootout gui/') && c.endsWith('/io.github.tuannd9288.factory.relay'));
  const inn = calls.findIndex((c) => c.startsWith('bootstrap gui/'));
  assert.ok(out >= 0 && inn > out, calls.join('\n'));
}));

test('it fails when check fails: a job whose log or state sits under Desktop is not ready', () => world((w) => {
  const r = w.install([], { FACTORY_STATE: join(w.home, 'Desktop/state') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not ready/);
}));

test('on the Mac mini it makes the link only: no launchd step, no plist, and the copy is ~/WORKSPACES', () => world((w) => {
  const r = w.install([], { FACTORY_HOST_USER: userInfo().username });
  assert.equal(r.code, 0, r.out);
  assert.equal(readlinkSync(w.link), join(w.home, 'WORKSPACES/bin/factory'));
  assert.deepEqual(w.launchctl(), []);
  assert.ok(!existsSync(join(w.home, 'Library')));
}));

test('FACTORY_CHECKOUT and XDG_DATA_HOME name where the copy goes', () => world((w) => {
  const named = join(w.dir, 'named');
  assert.equal(w.install([], { FACTORY_CHECKOUT: named }).code, 0);
  assert.equal(readlinkSync(w.link), join(named, 'bin/factory'));
  rmSync(w.link);
  assert.equal(w.install([], { FACTORY_CHECKOUT: '', XDG_DATA_HOME: join(w.dir, 'data') }).code, 0);
  assert.equal(readlinkSync(w.link), join(w.dir, 'data/factory/checkout/bin/factory'));
}));

test('the first clone carries an empty credential.helper and cannot prompt', () => world((w) => {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(w.dir, 'fake/git'), ['#!/bin/sh', 'printf \'%s|%s\\n\' "$GIT_TERMINAL_PROMPT" "$*" >>"$HOME/git.log"', `exec ${real} "$@"`, ''].join('\n'));
  chmodSync(join(w.dir, 'fake/git'), 0o755);
  assert.equal(w.install().code, 0);
  const clones = readFileSync(join(w.home, 'git.log'), 'utf8').split('\n').filter((l) => / clone /.test(l));
  assert.equal(clones.length, 1, clones.join('\n'));
  assert.match(clones[0], /^0\|-c credential\.helper= clone /);
}));

test('run from the copy, it follows main first and runs itself once more from the moved copy', () => world((w) => {
  assert.equal(w.install().code, 0);
  const script = readFileSync(join(w.seed, 'bin/install-factory'), 'utf8');
  writeFileSync(join(w.seed, 'bin/install-factory'), script.replace('set -euo pipefail\n', 'set -euo pipefail\necho "newer code ran"\n'));
  git(w.seed, 'commit', '-qam', 'newer install-factory');
  git(w.seed, 'push', '-q', w.origin, 'main');
  const tip = git(w.seed, 'rev-parse', 'HEAD');
  rmSync(w.link);
  rmSync(w.plist);
  const r = w.install([], {}, join(w.root, 'bin/install-factory'));
  assert.equal(r.code, 0, r.out);
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), tip);
  assert.equal(r.out.split('newer code ran').length - 1, 1, r.out);
  assert.equal(readlinkSync(w.link), join(w.root, 'bin/factory'));
  assert.ok(existsSync(w.plist));
}));

test('run from the copy, a refused follow is told and the run goes on with the copy as it is', () => world((w) => {
  assert.equal(w.install().code, 0);
  const before = git(w.root, 'rev-parse', 'HEAD');
  w.push('second');
  writeFileSync(join(w.root, 'note'), 'an edit');
  rmSync(w.link);
  const r = w.install([], {}, join(w.root, 'bin/install-factory'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not moved/);
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), before);
  assert.equal(readlinkSync(w.link), join(w.root, 'bin/factory'));
}));

test('after bootout it waits until the job is gone before it loads the new one', () => world((w) => {
  assert.equal(w.install().code, 0);
  writeFileSync(join(w.home, 'linger'), '3');
  const before = w.launchctl().length;
  const r = w.install();
  assert.equal(r.code, 0, r.out);
  const calls = w.launchctl().slice(before);
  const out = calls.findIndex((c) => c.startsWith('bootout '));
  const inn = calls.findIndex((c) => c.startsWith('bootstrap '));
  assert.ok(calls.slice(out + 1, inn).filter((c) => c.startsWith('print ')).length >= 3, calls.join('\n'));
}));

test('when the job is still there after the wait, bootstrap fails and a line says so and to run it again', () => world((w) => {
  assert.equal(w.install().code, 0);
  writeFileSync(join(w.home, 'linger'), '1000');
  const r = w.install([], { FACTORY_INSTALL_WAIT: '1' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /install-factory: launchctl bootstrap of io\.github\.tuannd9288\.factory\.relay failed; run this same line again/);
}));

test('takes no argument', () => world((w) => {
  assert.notEqual(w.install(['--force']).code, 0);
  assert.ok(!existsSync(join(w.home, '.local')));
}));
