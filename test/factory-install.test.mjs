// #177, #390: bin/install-factory. Run from a clone, it makes the machine's installed copy of the factory (or brings it to origin/main), runs
// that copy's own bin/install-factory, and that points ~/.local/bin/factory at the copy's bin/factory, replacing nothing else; on the MacBook
// it also writes the relay's and the queue's LaunchDaemons and prints the sudo line that installs them (#366). Each test runs it under a
// temporary HOME and LaunchDaemons folder, against a local bare repository as the origin and a fake launchctl, ssh, sudo and install first on
// PATH; nothing here touches the real ~/.local/bin, ~/Library, /Library or ~/WORKSPACES, and nothing reaches the network.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { HOST_ENV, factory, git, quiet, run } from './helpers.mjs';

const COPIED = ['bin', 'packs', 'kit', '.githooks'];

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
    writeFileSync(join(fake, 'launchctl'), ['#!/bin/sh', 'echo "$*" >>"$HOME/launchctl.log"',
      // Each job is loaded or not by its label: the last part of print's and bootout's target, the plist's name for bootstrap.
      'case "$1" in', 'print) [ -f "$HOME/loaded-${2##*/}" ] || exit 113 ;;',
      'bootstrap) : >"$HOME/loaded-$(basename "$3" .plist)" ;;', 'bootout) rm -f "$HOME/loaded-${2##*/}" ;;', 'esac', ''].join('\n'));
    writeFileSync(join(fake, 'ssh'), ['#!/bin/sh', 'case "$*" in *--newest*) echo 4 ;; esac', ''].join('\n'));
    // #366: gh as the queue's check meets it on the MacBook: the agents with their token in GH_TOKEN, the Human otherwise.
    writeFileSync(join(fake, 'gh'), ['#!/bin/sh', 'case "$*" in', '  "api user"*) if [ "$GH_TOKEN" = made-up-agents-token ]; then echo agent-bot; else echo tuannd9288; fi ;;', '  *) exit 1 ;;', 'esac', ''].join('\n'));
    // What the Human's sudo line runs: sudo runs its command; install (-o root -g wheel -m 644 <from> <to>) copies.
    writeFileSync(join(fake, 'sudo'), '#!/bin/sh\nexec "$@"\n');
    writeFileSync(join(fake, 'install'), '#!/bin/sh\n[ "$1 $2 $3 $4 $5 $6" = "-o root -g wheel -m 644" ] || exit 64\ncp "$7" "$8"\n');
    for (const name of ['launchctl', 'ssh', 'gh', 'sudo', 'install']) chmodSync(join(fake, name), 0o755);
    // The agents' GitHub token in the node's own store (#366); a test takes it away to see the queue's check refuse.
    mkdirSync(join(dir, 'profiles/tokens'), { recursive: true });
    writeFileSync(join(dir, 'profiles/tokens/fake-agent'), 'made-up-agents-token\n');
    const w = {
      dir, home, origin, seed,
      root: join(home, '.local/share/factory/checkout'),
      link: join(home, '.local/bin/factory'),
      wanted: join(dir, 'state/plist-wanted'),
      daemons: join(dir, 'LaunchDaemons'),
      // The code that runs is the clone's own bin/install-factory, whose HOME and place are the test's.
      install: (args = [], env = {}, from = join(factory, 'bin/install-factory')) =>
        run(factory, 'bash', [from, ...args], {
          HOME: home, PATH: `${fake}:${process.env.PATH}`, FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'),
          FACTORY_INSTALL_ORIGIN: origin, FACTORY_HOST_USER: 'nobody-here', FACTORY_CHECKOUT: '', XDG_DATA_HOME: '',
          AGENT_PROFILES: join(dir, 'profiles'), FACTORY_AGENT: 'fake-agent', FACTORY_PLIST_DIR: join(dir, 'LaunchDaemons'), ...env,
        }),
      // The line the run printed for the Human's sudo, run as he would, with the fakes; null when it printed none.
      sudo: (out) => {
        const line = out.split('\n').find((l) => l.startsWith('install-factory: to install and load them, run: '));
        if (!line) return null;
        mkdirSync(join(dir, 'LaunchDaemons'), { recursive: true });
        return run(dir, 'sh', ['-c', line.slice('install-factory: to install and load them, run: '.length)], { HOME: home, PATH: `${fake}:${process.env.PATH}` });
      },
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

const LABELS = ['io.github.tuannd9288.factory.relay', 'io.github.tuannd9288.factory.queue'];

test('on the MacBook it writes the relay\'s and the queue\'s LaunchDaemons, run by this user from the copy, runs their checks, loads nothing, and prints the sudo line that installs and loads both (#366)', () => world((w) => {
  const r = w.install();
  assert.equal(r.code, 0, r.out);
  for (const [label, tool] of [[LABELS[0], 'bin/factory-relay'], [LABELS[1], 'bin/factory-queue']]) {
    const text = readFileSync(join(w.wanted, `${label}.plist`), 'utf8');
    // A LaunchDaemon runs with nobody logged in, as this user, from the copy, which it names; it holds no token.
    assert.ok(text.includes(join(w.root, tool)) && !text.includes(factory), text);
    assert.match(text, new RegExp(`<key>UserName</key>\\s*<string>${userInfo().username}</string>`));
    assert.match(text, new RegExp(`<key>FACTORY_CHECKOUT</key>\\s*<string>${w.root}</string>`));
    assert.doesNotMatch(text, /made-up-agents-token/);
  }
  assert.ok(!w.launchctl().some((c) => /^(bootstrap|bootout|load)/.test(c)), 'it loads nothing itself');
  assert.match(r.out, /^check: gh login agent-bot$/m);
  // The line, run as the Human runs it, installs the two plists and loads each after its install.
  const sudo = w.sudo(r.out);
  assert.equal(sudo?.code, 0, sudo?.out ?? r.out);
  for (const label of LABELS) assert.equal(readFileSync(join(w.daemons, `${label}.plist`), 'utf8'), readFileSync(join(w.wanted, `${label}.plist`), 'utf8'));
  assert.deepEqual(w.launchctl().filter((c) => c.startsWith('bootstrap')), LABELS.map((l) => `bootstrap system ${join(w.daemons, `${l}.plist`)}`));
  // Run again with both installed as the copy renders them: nothing to do.
  const again = w.install();
  assert.equal(again.code, 0, again.out);
  assert.equal(w.sudo(again.out), null, again.out);
  // Without the agents' token in the node's store, the queue's check is not ready and says why, and so is the run.
  rmSync(join(w.daemons, `${LABELS[1]}.plist`));
  rmSync(join(w.dir, 'profiles/tokens/fake-agent'));
  const without = w.install();
  assert.notEqual(without.code, 0, without.out);
  assert.match(without.out, /^check: not ready: this node holds no GitHub token for the agents/m);
  assert.equal(w.sudo(without.out), null);
}));

test('a loaded job whose plist changed is booted out before its install, and the queue\'s daemon is named to stop (#366)', () => world((w) => {
  const first = w.install();
  assert.equal(w.sudo(first.out)?.code, 0, first.out);
  const installed = join(w.daemons, `${LABELS[1]}.plist`);
  writeFileSync(installed, `${readFileSync(installed, 'utf8')}<!-- an older plist -->\n`);
  const r = w.install();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /daemon\.lock.*SIGTERM/);
  const before = w.launchctl().length;
  assert.equal(w.sudo(r.out)?.code, 0, r.out);
  assert.deepEqual(w.launchctl().slice(before), [`bootout system/${LABELS[1]}`, `bootstrap system ${installed}`], 'the relay\'s, unchanged, is left as it is');
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(join(w.wanted, `${LABELS[1]}.plist`), 'utf8'));
}));

test('it fails when check fails: a job whose log or state sits under Desktop is not ready', () => world((w) => {
  const r = w.install([], { FACTORY_STATE: join(w.home, 'Desktop/state') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not ready/);
}));

test('on the Mac mini it makes the link only: no launchd step, no plist, and the copy is ~/WORKSPACES', () => world((w) => {
  const r = w.install([], HOST_ENV);
  assert.equal(r.code, 0, r.out);
  assert.equal(readlinkSync(w.link), join(w.home, 'WORKSPACES/bin/factory'));
  assert.deepEqual(w.launchctl(), []);
  assert.ok(!existsSync(join(w.home, 'Library')));
}));

test('Mac mini setup installs shared subject hooks and preserves existing hook configurations', () => world((w) => {
  const env = { HOME: w.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', ...HOST_ENV };
  const root = join(w.home, 'WORKSPACES');
  const config = (...args) => run(root, 'git', ['config', ...args], env);
  const installed = w.install([], env);
  assert.equal(installed.code, 0, installed.out);
  assert.equal(config('--get', 'core.hooksPath').out.trim(), join(root, '.githooks'));
  assert.deepEqual(readdirSync(join(root, '.githooks')), ['commit-msg']);
  const again = w.install([], env);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /core.hooksPath.*left as it is/);
  const worktree = join(w.dir, 'worktree');
  git(root, 'worktree', 'add', '-qb', 'worker', worktree);
  for (const cwd of [root, worktree]) {
    const commit = (subject) => run(cwd, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-qm', subject], env);
    const bad = commit('x'.repeat(73));
    assert.notEqual(bad.code, 0, bad.out);
    assert.match(bad.out, /commit-msg: the subject has 73 characters; at most 72/);
    const good = commit('Accept a valid subject');
    assert.equal(good.code, 0, good.out);
  }
  assert.equal(config('--local', 'core.hooksPath', 'custom-hooks').code, 0);
  assert.match(w.install([], env).out, /core.hooksPath.*left as it is/);
  assert.equal(config('--get', 'core.hooksPath').out.trim(), 'custom-hooks');
  assert.equal(config('--local', '--unset', 'core.hooksPath').code, 0);
  const global = join(w.home, 'gitconfig');
  writeFileSync(global, '[core]\n\thooksPath = global-hooks\n');
  assert.match(w.install([], { ...env, GIT_CONFIG_GLOBAL: global }).out, /core.hooksPath.*left as it is/);
  assert.equal(config('--local', '--get', 'core.hooksPath').code, 1);
  const hook = join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  chmodSync(hook, 0o755);
  assert.match(w.install([], env).out, /hook.*left as it is/);
  assert.equal(config('--local', '--get', 'core.hooksPath').code, 1);
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
  const relay = join(w.wanted, `${LABELS[0]}.plist`);
  rmSync(relay);
  const r = w.install([], {}, join(w.root, 'bin/install-factory'));
  assert.equal(r.code, 0, r.out);
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), tip);
  assert.equal(r.out.split('newer code ran').length - 1, 1, r.out);
  assert.equal(readlinkSync(w.link), join(w.root, 'bin/factory'));
  assert.ok(existsSync(relay));
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

test('takes no argument', () => world((w) => {
  assert.notEqual(w.install(['--force']).code, 0);
  assert.ok(!existsSync(join(w.home, '.local')));
}));
