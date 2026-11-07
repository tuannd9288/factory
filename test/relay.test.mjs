// #370 slice 2: the MacBook's relay (bin/lib/relay.mjs, bin/factory-relay). A pass reads the Mac mini's news lines through an injected `fetch`
// and `newest` (or, for the commands, a fake ssh first on PATH) and posts through a fake `post`; a Lead's socket file is a file in a temporary
// state folder. No network, no listening socket. Exit codes, posts and cursor values are asserted, never the wording of a log line (#112).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { HOST_ENV, factory, git } from './helpers.mjs';
import { HOST, check, follow, job, pass, readNewest, readNews } from '../bin/lib/relay.mjs';
import { installedRoot } from '../bin/lib/factory.mjs';
import { plist } from '../bin/lib/queue.mjs';

/** The environment of a MacBook user: nobody here is the factory host's user. */
const MAC = { FACTORY_HOST_USER: 'nobody-here' };

/** A news line as the Mac mini's sweep writes it. */
const news = (seq, over = {}) => ({ seq, at: 't', type: 'start', kind: 'checks-red', key: `checks-red o/app#${seq} h`, text: 'ignored', what: `o/app#${seq} head h: a check failed`, where: `https://github.com/o/app/pull/${seq}`, lead: 'app-pstack', woke: false, why: 'no file', ...over });

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-'));
  const state = join(dir, 'state');
  mkdirSync(join(state, 'lead-here'), { recursive: true });
  writeFileSync(join(state, 'lead-here', 'app-pstack.socket'), `${join(dir, 's.sock')}\n`);
  const posts = [];
  const logs = [];
  let lines = [];
  const asked = [];
  return {
    dir,
    state,
    posts,
    logs,
    asked,
    serve: (list) => (lines = list),
    cursor: () => (existsSync(join(state, 'relay.cursor')) ? readFileSync(join(state, 'relay.cursor'), 'utf8').trim() : null),
    pass: (over = {}) =>
      pass({
        state,
        log: (l) => logs.push(l),
        post: (file, line) => (posts.push({ file, content: JSON.parse(line).message.content }), { posted: true }),
        // The Mac mini's side honours --after, as bin/factory-events does, and `--newest` answers with the number alone.
        fetch: (after) => (asked.push(after), { status: 0, stdout: lines.filter((e) => e.seq > after).map((e) => `${JSON.stringify(e)}\n`).join(''), stderr: '' }),
        newest: () => ({ status: 0, stdout: `${Math.max(0, ...lines.map((e) => e.seq))}\n`, stderr: '' }),
        ...over,
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('the first pass reads no line: it puts the cursor at the newest seq and wakes nothing; the next relays a new line once', async () => {
  const w = world();
  try {
    w.serve([news(1), news(2)]);
    assert.equal(await w.pass(), 0);
    assert.deepEqual([w.posts.length, w.cursor(), w.asked.length], [0, '2', 0]);
    w.serve([news(1), news(2), news(3)]);
    assert.equal(await w.pass(), 0);
    assert.equal(w.posts.length, 1);
    assert.equal(w.posts[0].file, join(w.state, 'lead-here', 'app-pstack.socket'));
    assert.ok(w.posts[0].content.includes(news(3).what) && w.posts[0].content.includes(news(3).where));
    assert.equal(w.cursor(), '3');
    assert.deepEqual(w.asked, [2]);
    await w.pass();
    assert.deepEqual([w.posts.length, w.cursor()], [1, '3']);
  } finally {
    w.cleanup();
  }
});

test('a line the Mac mini delivered, one it could not for a busy Lead, one with no Lead and one with no socket file here are not relayed, and the cursor passes them', async () => {
  const w = world();
  try {
    w.serve([]);
    await w.pass();
    w.serve([
      news(1, { woke: true, why: undefined }),
      news(2, { why: 'timed out' }),
      news(3, { why: 'not ours' }),
      news(4, { why: 'not a socket' }),
      news(5, { lead: null, why: undefined }),
      news(6, { lead: 'other-lead' }),
      news(7, { why: 'refused' }),
    ]);
    await w.pass();
    assert.equal(w.posts.length, 1);
    assert.ok(w.posts[0].content.includes(news(7).what));
    assert.equal(w.cursor(), '7');
  } finally {
    w.cleanup();
  }
});

test('a line is relayed only with a what and where of at most 300 characters and a GitHub URL or an absolute path, which carries the Mac mini host', async () => {
  const w = world();
  try {
    w.serve([]);
    await w.pass();
    const path = '/Users/factory/factory-runs/app-1/run-worker.jsonl';
    w.serve([
      news(1, { what: 'x'.repeat(301) }),
      news(2, { where: 'w'.repeat(301) }),
      news(3, { where: 'http://example.com/pull/1' }),
      news(4, { where: 'relative/path' }),
      news(5, { where: 7 }),
      news(6, { what: 'word '.repeat(40).trim(), where: path }),
      news(7, { where: 'https://github.com/o/app/pull/7' }),
      news(8, { what: 'first line\nsecond line' }),
      news(9, { where: 'https://github.com/o/app/pull/9\u0007' }),
    ]);
    await w.pass();
    assert.equal(w.posts.length, 2);
    assert.ok(w.posts[0].content.includes(`${HOST}:${path}`));
    assert.ok(w.posts[1].content.includes('https://github.com/o/app/pull/7') && !w.posts[1].content.includes(`${HOST}:`));
    assert.equal(w.cursor(), '9');
  } finally {
    w.cleanup();
  }
});

test('the ssh read is made with a 64 MiB buffer, BatchMode and the cursor; the newest read asks for --newest alone', () => {
  const calls = [];
  const run = (cmd, args, options) => (calls.push({ cmd, args, options }), { status: 0, stdout: '', stderr: '' });
  readNews(7, { run });
  readNewest({ run });
  assert.deepEqual(calls.map((c) => c.options.maxBuffer), [64 * 1024 * 1024, 64 * 1024 * 1024]);
  assert.ok(calls.every((c) => c.cmd === 'ssh' && c.args.includes('BatchMode=yes') && c.args.includes('--news')));
  assert.deepEqual(calls[0].args.slice(-2), ['--after', '7']);
  assert.equal(calls[1].args.at(-1), '--newest');
});

test('a post that fails is not tried again', async () => {
  const w = world();
  try {
    w.serve([]);
    await w.pass();
    w.serve([news(1)]);
    let calls = 0;
    await w.pass({ post: () => (calls += 1, { posted: false, why: 'refused' }) });
    await w.pass({ post: () => (calls += 1, { posted: false, why: 'refused' }) });
    assert.deepEqual([calls, w.cursor()], [1, '1']);
  } finally {
    w.cleanup();
  }
});

test('a read that fails, a full buffer included, leaves the cursor and the pass fails; a failing newest leaves no cursor', async () => {
  const w = world();
  try {
    w.serve([news(1)]);
    assert.equal(await w.pass({ newest: () => ({ status: 255, stdout: '', stderr: 'no' }) }), 1);
    assert.equal(w.cursor(), null);
    assert.equal(await w.pass({ newest: () => ({ status: 0, stdout: 'not a number\n', stderr: '' }) }), 1);
    assert.equal(w.cursor(), null);
    await w.pass();
    assert.equal(w.cursor(), '1');
    w.serve([news(1), news(2)]);
    assert.equal(await w.pass({ fetch: () => ({ status: 255, stdout: '', stderr: 'Permission denied' }) }), 1);
    assert.equal(await w.pass({ fetch: () => ({ status: null, stdout: '', stderr: 'spawnSync ssh ENOBUFS', error: { code: 'ENOBUFS' } }) }), 1);
    assert.deepEqual([w.cursor(), w.posts.length], ['1', 0]);
  } finally {
    w.cleanup();
  }
});

test('a cursor above the Mac mini newest starts afresh from the newest seq, relays none of the lines it printed and wakes nothing', async () => {
  const w = world();
  try {
    w.serve([news(1)]);
    await w.pass();
    // The Mac mini's file was made anew: it prints from its first line and says so on stderr.
    w.serve([news(1), news(2)]);
    let newests = 0;
    const newest = () => (newests += 1, { status: 0, stdout: '2\n', stderr: '' });
    await w.pass({ newest, fetch: () => ({ status: 0, stdout: `${JSON.stringify(news(1))}\n${JSON.stringify(news(2))}\n`, stderr: 'factory-events: --after 1 is above the highest seq in events.jsonl (2); starting from its first line' }) });
    assert.deepEqual([w.posts.length, w.cursor(), newests], [0, '2', 1]);
  } finally {
    w.cleanup();
  }
});

/** A folder with `node` and `ssh` executables in it, for a PATH. */
function stubs() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-bin-'));
  for (const name of ['node', 'ssh']) {
    writeFileSync(join(dir, name), '#!/bin/sh\n');
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

test('plist renders a LaunchDaemon run by the user that printed it, with its HOME, every 60 s and no KeepAlive, and a PATH of the folders node and ssh are found in, not the Cellar one (#366)', () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'));
  const bin = stubs();
  try {
    const j = job({ HOME: home, PATH: bin, ...MAC });
    assert.deepEqual(j.env.PATH.split(':'), [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    const text = plist(j);
    assert.match(text, /<string>io\.github\.tuannd9288\.factory\.relay<\/string>/);
    // A LaunchDaemon runs with nobody logged in, as this user, who has no other HOME there.
    assert.match(text, new RegExp(`<key>UserName</key>\\s*<string>${userInfo().username}</string>`));
    assert.equal(j.env.HOME, home);
    // The sweep renders it with FACTORY_CHECKOUT set (queue.mjs's job), the Human's shell without: the plist is the same, or the sweep would
    // report it as differing from the installed one at every pass.
    assert.equal(plist(job({ HOME: home, PATH: bin, ...MAC, FACTORY_CHECKOUT: installedRoot({ HOME: home, ...MAC }) })), text);
    assert.ok(!text.includes('KeepAlive'));
    assert.match(text, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.match(text, /bin\/factory-relay<\/string>\s*<string>run<\/string>/);
    assert.ok(text.includes(join(home, 'Library/Logs/factory/relay.log')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('installedRoot: FACTORY_CHECKOUT first, ~/WORKSPACES on the factory host, XDG_DATA_HOME or ~/.local/share on the MacBook', () => {
  const home = '/home/someone';
  const host = { HOME: home, ...HOST_ENV };
  assert.equal(installedRoot({ ...host, FACTORY_CHECKOUT: '/x/checkout' }), '/x/checkout');
  assert.equal(installedRoot({ ...MAC, HOME: home, FACTORY_CHECKOUT: '/x/checkout' }), '/x/checkout');
  assert.equal(installedRoot(host), join(home, 'WORKSPACES'));
  assert.equal(installedRoot({ ...MAC, HOME: home }), join(home, '.local/share/factory/checkout'));
  assert.equal(installedRoot({ ...MAC, HOME: home, XDG_DATA_HOME: '/data' }), '/data/factory/checkout');
  assert.equal(installedRoot({ ...MAC, HOME: home, XDG_DATA_HOME: '' }), join(home, '.local/share/factory/checkout'));
});

test('the job runs the installed copy, not the clone the code sits in, and keeps the settings that move it', () => {
  const home = '/home/someone';
  const bin = stubs();
  try {
    const j = job({ HOME: home, PATH: bin, ...MAC });
    const root = join(home, '.local/share/factory/checkout');
    assert.deepEqual([j.program, j.cwd], [[join(root, 'bin/factory-relay'), 'run'], root]);
    const named = job({ HOME: home, PATH: bin, ...MAC, FACTORY_CHECKOUT: '/opt/fc', XDG_DATA_HOME: '/data' });
    assert.deepEqual([named.program[0], named.cwd], ['/opt/fc/bin/factory-relay', '/opt/fc']);
    assert.deepEqual([named.env.FACTORY_CHECKOUT, named.env.XDG_DATA_HOME], ['/opt/fc', '/data']);
    assert.ok(![j.program[0], j.cwd].some((p) => p.startsWith(factory)));
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

/** An origin (a bare repository) with one commit on main, and the installed copy cloned from it at HOME/.local/share/factory/checkout. */
function installedWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-installed-'));
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  const push = (text) => {
    writeFileSync(join(seed, 'file'), text);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', text);
    git(seed, 'push', '-q', join(dir, 'origin.git'), 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  git(seed, 'commit', '-qm', 'first', '--allow-empty');
  git(dir, 'clone', '-q', '--bare', seed, join(dir, 'origin.git'));
  const home = join(dir, 'home');
  const root = join(home, '.local/share/factory/checkout');
  mkdirSync(join(home, '.local/share/factory'), { recursive: true });
  git(dir, 'clone', '-q', '--branch', 'main', join(dir, 'origin.git'), root);
  return { dir, home, root, state: join(dir, 'state'), runs: join(dir, 'runs'), push, head: () => git(root, 'rev-parse', 'HEAD'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a pass brings the installed copy to origin/main before it reads the news, and a later commit reaches it with no step by hand', async () => {
  const w = installedWorld();
  try {
    const order = [];
    const logs = [];
    const run = () =>
      pass({
        state: w.state, root: w.root, runs: w.runs, env: { ...process.env, ...MAC, HOME: w.home }, log: (l) => logs.push(l),
        newest: () => (order.push(order.includes('follow') ? 'newest' : 'newest-first'), { status: 0, stdout: '1\n', stderr: '' }),
        follower: (a) => (order.push('follow'), follow(a)),
      });
    const tip = w.push('second');
    assert.notEqual(w.head(), tip);
    assert.equal(await run(), 0);
    assert.equal(w.head(), tip);
    assert.deepEqual(order, ['follow', 'newest']);
    const next = w.push('third');
    await run();
    assert.equal(w.head(), next);
  } finally {
    w.cleanup();
  }
});

test('the follow step counts no run live when the run folders hold none, and logs its status only when it differs from the last pass\'s', () => {
  const w = installedWorld();
  try {
    const logs = [];
    let live;
    const statuses = [{ status: 'current' }, { status: 'current' }, { status: 'refused', why: 'offline' }, { status: 'refused', why: 'offline' }, { status: 'current' }];
    const counts = statuses.map((s) => {
      follow({ root: w.root, state: w.state, runs: w.runs, log: (l) => logs.push(l), move: (a) => ((live = a.live()), s) });
      return logs.length;
    });
    assert.equal(live, 0);
    assert.deepEqual(counts, [1, 1, 2, 2, 3]);
    // A raise is told like a refusal, once, and stops nothing.
    follow({ root: w.root, state: w.state, runs: w.runs, log: (l) => logs.push(l), move: () => { throw new Error('boom'); } });
    assert.equal(logs.length, 4);
  } finally {
    w.cleanup();
  }
});

test('a copy that cannot follow stays where it was, and the refusal is in queue-checkout.failed', async () => {
  const w = installedWorld();
  try {
    const before = w.head();
    w.push('second');
    writeFileSync(join(w.root, 'file'), 'a local change');
    const logs = [];
    await pass({ state: w.state, root: w.root, runs: w.runs, env: { ...process.env, ...MAC, HOME: w.home }, log: (l) => logs.push(l), newest: () => ({ status: 0, stdout: '1\n', stderr: '' }) });
    assert.equal(w.head(), before);
    assert.ok(existsSync(join(w.state, 'queue-checkout.failed')));
    assert.ok(existsSync(join(w.state, 'relay.cursor')), 'the pass relayed all the same');
  } finally {
    w.cleanup();
  }
});

/** The commands, as processes, with a fake ssh first on PATH that exits `code` after printing `out` to stdout; it logs its arguments and
 * SSH_AUTH_SOCK to $HOME/calls, which is the job's too. */
function command(args, { code = 0, out = '', place = MAC } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cmd-'));
  writeFileSync(join(dir, 'ssh'), ['#!/bin/sh', 'printf \'%s sock=%s\\n\' "$*" "$SSH_AUTH_SOCK" >>"$HOME/calls"', `printf '%s' '${out}'`, `exit ${code}`, ''].join('\n'));
  chmodSync(join(dir, 'ssh'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, FACTORY_STATE: join(dir, 'state'), ...place };
  const r = spawnSync(join(factory, 'bin/factory-relay'), args, { encoding: 'utf8', env });
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) : [];
  return { dir, code: r.status, out: r.stdout + r.stderr, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `check` in this process, with a fake ssh: it answers `--newest` with 4 and logs its calls and SSH_AUTH_SOCK under HOME. A fake launchctl
 * answers `print system/<the relay's label>` with `printed` (null: the job is not loaded) and any other domain as not found. The installed
 * copy is a folder with an executable bin/factory-relay at the default place under HOME, or, with `copyAt`, a symlink from there to that path
 * under HOME, or, with `copy` false, none. `state` is a path under HOME; `installed` is the text of an installed plist in the LaunchDaemons
 * folder (FACTORY_PLIST_DIR), `$HOME` standing for HOME. */
function checkWith({ code = 0, cursor = null, printed = null, copyAt = null, copy = true, state: stateAt = 'state', installed = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-check-'));
  writeFileSync(join(dir, 'ssh'), ['#!/bin/sh', 'printf \'%s sock=%s\\n\' "$*" "$SSH_AUTH_SOCK" >>"$HOME/calls"', 'case "$*" in *--newest*) echo 4 ;; esac', `exit ${code}`, ''].join('\n'));
  writeFileSync(join(dir, 'launchctl'), ['#!/bin/sh', '[ "$1 $2" = "print system/io.github.tuannd9288.factory.relay" ] || exit 113',
    printed === null ? 'exit 113' : `printf '%s\\n' '${printed}'`, ''].join('\n'));
  chmodSync(join(dir, 'ssh'), 0o755);
  chmodSync(join(dir, 'launchctl'), 0o755);
  const root = join(dir, '.local/share/factory/checkout');
  const program = (at) => {
    mkdirSync(join(at, 'bin'), { recursive: true });
    writeFileSync(join(at, 'bin/factory-relay'), '#!/bin/sh\n');
    chmodSync(join(at, 'bin/factory-relay'), 0o755);
  };
  if (copyAt) {
    program(join(dir, copyAt));
    mkdirSync(join(dir, '.local/share/factory'), { recursive: true });
    symlinkSync(join(dir, copyAt), root);
  } else if (copy) program(root);
  const daemons = join(dir, 'LaunchDaemons');
  if (installed) {
    mkdirSync(daemons, { recursive: true });
    writeFileSync(join(daemons, 'io.github.tuannd9288.factory.relay.plist'), installed.replaceAll('$HOME', dir));
  }
  const state = join(dir, stateAt);
  if (cursor !== null) {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'relay.cursor'), `${cursor}\n`);
  }
  const was = console.log;
  console.log = () => {};
  let exit;
  try {
    // The test's own SSH_AUTH_SOCK is in the environment `check` is given; the probe gets none, as the LaunchDaemon has none.
    exit = check({ HOME: dir, PATH: `${dir}:${process.env.PATH}`, FACTORY_STATE: state, FACTORY_PLIST_DIR: daemons, SSH_AUTH_SOCK: 'the-test-own.sock', ...MAC });
  } finally {
    console.log = was;
  }
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) : [];
  const read = existsSync(join(state, 'relay.cursor')) ? readFileSync(join(state, 'relay.cursor'), 'utf8').trim() : null;
  return { dir, exit, calls, cursor: read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('check fails on a failing ssh and makes the log folder, and never sets a cursor then', () => {
  const r = checkWith({ code: 255 });
  try {
    assert.equal(r.exit, 1);
    assert.ok(existsSync(join(r.dir, 'Library/Logs/factory')));
    assert.equal(r.cursor, null);
  } finally {
    r.cleanup();
  }
});

test('check passes when ssh works with no ssh agent, as the LaunchDaemon has none, never the caller\'s; it sets the cursor to the newest seq only when there is none, and posts nothing (#366)', () => {
  const none = checkWith();
  const kept = checkWith({ cursor: 9 });
  try {
    assert.deepEqual([none.exit, none.cursor], [0, '4']);
    assert.ok(none.calls.length > 0 && none.calls.every((c) => c.endsWith('sock=')));
    assert.ok(none.calls.some((c) => c.includes('BatchMode=yes') && c.includes('--newest')));
    assert.deepEqual([kept.exit, kept.cursor], [0, '9']);
  } finally {
    none.cleanup();
    kept.cleanup();
  }
});

test('check fails, and probes no ssh, when the installed copy, the log or the state folder sits under Desktop, through a symlink too', () => {
  const state = checkWith({ state: 'Desktop/state' });
  const clone = checkWith({ copyAt: 'Desktop/clone' });
  const docs = checkWith({ copyAt: 'Documents/clone' });
  try {
    for (const r of [state, clone, docs]) {
      assert.equal(r.exit, 1);
      assert.deepEqual(r.calls, []);
    }
  } finally {
    state.cleanup();
    clone.cleanup();
    docs.cleanup();
  }
});

test('check fails when the installed LaunchDaemon plist names a path under Desktop, and passes when it names the installed copy (#366)', () => {
  const bad = checkWith({ installed: '<plist><dict><key>ProgramArguments</key><array><string>$HOME/Desktop/x/bin/factory-relay</string><string>run</string></array></dict></plist>' });
  const good = checkWith({ installed: '<plist><dict><string>$HOME/.local/share/factory/checkout/bin/factory-relay</string><string>run</string></dict></plist>' });
  try {
    assert.deepEqual([bad.exit, bad.calls], [1, []]);
    assert.equal(good.exit, 0);
  } finally {
    bad.cleanup();
    good.cleanup();
  }
});

test('check fails when the loaded system job last exited with 126 or any code but 0, and passes at 0 or when the job is not loaded (#366)', () => {
  const r126 = checkWith({ printed: '\tlast exit code = 126' });
  const r0 = checkWith({ printed: '\tlast exit code = 0' });
  try {
    assert.deepEqual([r126.exit, r126.calls], [1, []]);
    assert.equal(r0.exit, 0);
  } finally {
    r126.cleanup();
    r0.cleanup();
  }
});

test('check fails when the installed copy is not there', () => {
  const r = checkWith({ copy: false });
  try {
    assert.deepEqual([r.exit, r.calls], [1, []]);
  } finally {
    r.cleanup();
  }
});

test('run reads the newest seq by ssh with BatchMode on its first pass and sets the cursor from it, reading no line', () => {
  const r = command(['run'], { out: '4\n' });
  try {
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls.length, 1);
    assert.ok(r.calls[0].includes('BatchMode=yes') && r.calls[0].includes('--news --newest'));
    assert.equal(readFileSync(join(r.dir, 'state/relay.cursor'), 'utf8').trim(), '4');
  } finally {
    r.cleanup();
  }
});

test('run and check refuse to run as the factory host user, and call no ssh', () => {
  for (const verb of ['run', 'check']) {
    const r = command([verb], { place: HOST_ENV });
    try {
      assert.equal(r.code, 2, r.out);
      assert.deepEqual(r.calls, []);
    } finally {
      r.cleanup();
    }
  }
});
