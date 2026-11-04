// #370 slice 2: the MacBook's relay (bin/lib/relay.mjs, bin/factory-relay). A pass reads the Mac mini's news lines through an injected `fetch`
// and `newest` (or, for the commands, a fake ssh first on PATH) and posts through a fake `post`; a Lead's socket file is a file in a temporary
// state folder. No network, no listening socket. Exit codes, posts and cursor values are asserted, never the wording of a log line (#112).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { HOST, check, guard, install, job, main, pass, readNewest, readNews } from '../bin/lib/relay.mjs';
import { plist } from '../bin/lib/queue.mjs';

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

test('plist renders a LaunchAgent that runs the relay every 60 s with no user key and no KeepAlive, and a PATH of the folders node and ssh are found in, not the Cellar one', () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'));
  const bin = stubs();
  try {
    const j = job({ HOME: home, PATH: bin });
    assert.deepEqual(j.env.PATH.split(':'), [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    const text = plist(j);
    assert.match(text, /<string>io\.github\.tuannd9288\.factory\.relay<\/string>/);
    assert.ok(!text.includes('<key>UserName</key>'));
    assert.ok(!text.includes('KeepAlive'));
    assert.match(text, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.match(text, /bin\/factory-relay<\/string>\s*<string>run<\/string>/);
    assert.ok(text.includes(join(home, 'Library/Logs/factory/relay.log')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

/** A repository on main with one commit, and a linked worktree of it on another branch. */
function repos() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-git-'));
  const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  const clone = join(dir, 'clone');
  mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'main');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'x');
  const tree = join(dir, 'tree');
  git(clone, 'worktree', 'add', '-q', tree, '-b', 'side');
  return { dir, clone, tree, git };
}

test('a linked worktree is refused by plist and check with a rejection; a clone on another branch is only noted; main is neither', async () => {
  const r = repos();
  const bin = stubs();
  try {
    assert.deepEqual(guard(r.clone), { refuse: null, note: null });
    assert.equal(typeof guard(r.tree).refuse, 'string');
    r.git(r.clone, 'checkout', '-q', '-b', 'other');
    const g = guard(r.clone);
    assert.equal(g.refuse, null);
    assert.equal(typeof g.note, 'string');
    // The stub ssh is first on PATH: were the guard not to refuse, `check` would call it and never a real ssh.
    const env = { HOME: r.dir, PATH: `${bin}:${process.env.PATH}`, FACTORY_HOST_USER: 'nobody-here' };
    await assert.rejects(main(['plist'], env, r.tree));
    await assert.rejects(main(['check'], env, r.tree));
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(r.dir, { recursive: true, force: true });
  }
});

/** The commands, as processes, with a fake ssh first on PATH that exits `code` after printing `out` to stdout; it logs its arguments and
 * SSH_AUTH_SOCK to $HOME/calls, which is the job's too. */
function command(args, { code = 0, out = '', hostUser = 'nobody-here' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cmd-'));
  writeFileSync(join(dir, 'ssh'), ['#!/bin/sh', 'printf \'%s sock=%s\\n\' "$*" "$SSH_AUTH_SOCK" >>"$HOME/calls"', `printf '%s' '${out}'`, `exit ${code}`, ''].join('\n'));
  chmodSync(join(dir, 'ssh'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, FACTORY_STATE: join(dir, 'state'), FACTORY_HOST_USER: hostUser };
  const r = spawnSync(join(factory, 'bin/factory-relay'), args, { encoding: 'utf8', env });
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) : [];
  return { dir, code: r.status, out: r.stdout + r.stderr, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `check` in this process, with a fake ssh: it answers `--newest` with 4 and logs its calls under HOME. A fake launchctl answers `getenv` with
 * `sock` (the job's SSH_AUTH_SOCK) and `print` with `printed` (null: the job is not loaded). The copy is a folder with an executable
 * bin/factory-relay at relay/current, or, with `copyAt`, a symlink from there to that path under HOME. `state` is a path under HOME. */
function checkWith({ code = 0, cursor = null, sock = '/agent.sock', printed = null, copyAt = null, state: stateAt = 'state', installed = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-check-'));
  writeFileSync(join(dir, 'ssh'), ['#!/bin/sh', 'printf \'%s sock=%s\\n\' "$*" "$SSH_AUTH_SOCK" >>"$HOME/calls"', 'case "$*" in *--newest*) echo 4 ;; esac', `exit ${code}`, ''].join('\n'));
  writeFileSync(join(dir, 'launchctl'), ['#!/bin/sh', 'case "$1" in', `getenv) printf '%s' '${sock}' ;;`, printed === null ? 'print) exit 113 ;;' : `print) printf '%s\\n' '${printed}' ;;`, 'esac', ''].join('\n'));
  chmodSync(join(dir, 'ssh'), 0o755);
  chmodSync(join(dir, 'launchctl'), 0o755);
  const relay = join(dir, '.local/share/factory/relay');
  const copy = join(relay, 'current');
  mkdirSync(relay, { recursive: true });
  if (copyAt) {
    mkdirSync(join(dir, copyAt, 'bin'), { recursive: true });
    writeFileSync(join(dir, copyAt, 'bin/factory-relay'), '#!/bin/sh\n');
    chmodSync(join(dir, copyAt, 'bin/factory-relay'), 0o755);
    symlinkSync(join(dir, copyAt), copy);
  } else {
    mkdirSync(join(copy, 'bin'), { recursive: true });
    writeFileSync(join(copy, 'bin/factory-relay'), '#!/bin/sh\n');
    chmodSync(join(copy, 'bin/factory-relay'), 0o755);
  }
  if (installed) {
    mkdirSync(join(dir, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(join(dir, 'Library/LaunchAgents/io.github.tuannd9288.factory.relay.plist'), installed.replaceAll('$HOME', dir));
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
    exit = check({ HOME: dir, PATH: `${dir}:${process.env.PATH}`, FACTORY_STATE: state, SSH_AUTH_SOCK: 'the-test-own.sock' });
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

test('check passes when ssh works: it passes launchd\'s SSH_AUTH_SOCK on, sets the cursor to the newest seq only when there is none, and posts nothing', () => {
  const none = checkWith();
  const kept = checkWith({ cursor: 9 });
  try {
    assert.deepEqual([none.exit, none.cursor], [0, '4']);
    assert.ok(none.calls.every((c) => c.endsWith('sock=/agent.sock')));
    assert.ok(none.calls.some((c) => c.includes('BatchMode=yes') && c.includes('--newest')));
    assert.deepEqual([kept.exit, kept.cursor], [0, '9']);
  } finally {
    none.cleanup();
    kept.cleanup();
  }
});

test('the ssh probe gets the SSH_AUTH_SOCK launchctl getenv prints, none when that is empty, and never the test\'s own', () => {
  const none = checkWith({ sock: '' });
  try {
    assert.equal(none.exit, 0);
    assert.ok(none.calls.length > 0 && none.calls.every((c) => c.endsWith('sock=')));
  } finally {
    none.cleanup();
  }
});

test('check fails, and probes no ssh, when the copy, the log or the state folder sits under Desktop, through a symlink too', () => {
  const state = checkWith({ state: 'Desktop/state' });
  const clone = checkWith({ copyAt: 'Desktop/clone' });
  try {
    for (const r of [state, clone]) {
      assert.equal(r.exit, 1);
      assert.deepEqual(r.calls, []);
    }
  } finally {
    state.cleanup();
    clone.cleanup();
  }
});

test('check fails when an installed plist names a path under Desktop, and passes when it names the copy', () => {
  const bad = checkWith({ installed: '<plist><dict><key>ProgramArguments</key><array><string>$HOME/Desktop/x/bin/factory-relay</string><string>run</string></array></dict></plist>' });
  const good = checkWith({ installed: '<plist><dict><string>$HOME/.local/share/factory/relay/current/bin/factory-relay</string><string>run</string></dict></plist>' });
  try {
    assert.deepEqual([bad.exit, bad.calls], [1, []]);
    assert.equal(good.exit, 0);
  } finally {
    bad.cleanup();
    good.cleanup();
  }
});

test('check fails when the loaded job last exited with 126 or any code but 0, and passes at 0 or when the job is not loaded', () => {
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

test('check fails when the copy is not there', () => {
  const r = checkWith();
  try {
    rmSync(join(r.dir, '.local'), { recursive: true });
    const was = console.log;
    console.log = () => {};
    try {
      assert.equal(check({ HOME: r.dir, PATH: `${r.dir}:${process.env.PATH}`, FACTORY_STATE: join(r.dir, 'state') }), 1);
    } finally {
      console.log = was;
    }
  } finally {
    r.cleanup();
  }
});

/** A small clone with one commit that holds an executable bin/factory-relay. */
function smallClone() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-copy-'));
  const clone = join(dir, 'clone');
  mkdirSync(join(clone, 'bin'), { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const commit = (text) => {
    writeFileSync(join(clone, 'bin/factory-relay'), `#!/bin/sh\n# ${text}\n`);
    chmodSync(join(clone, 'bin/factory-relay'), 0o755);
    git('add', '-A');
    git('commit', '-q', '-m', text);
    return git('rev-parse', 'HEAD').stdout.trim();
  };
  return { dir, clone, commit, git };
}

test('the job runs from relay/current under HOME; install copies HEAD there, a second commit swaps the link and removes the old copy', () => {
  const c = smallClone();
  const home = join(c.dir, 'home');
  const env = { HOME: home, PATH: process.env.PATH };
  const relay = join(home, '.local/share/factory/relay');
  try {
    const j = job(env);
    assert.equal(j.program[0], join(relay, 'current/bin/factory-relay'));
    assert.equal(j.cwd, join(relay, 'current'));
    const first = c.commit('one');
    assert.deepEqual(install(c.clone, env), { sha: first, dirty: false });
    assert.equal(realpathSync(join(relay, 'current')), realpathSync(join(relay, first)));
    accessSync(j.program[0], constants.X_OK);
    const second = c.commit('two');
    writeFileSync(join(c.clone, 'loose'), 'not committed');
    assert.deepEqual(install(c.clone, env), { sha: second, dirty: true });
    assert.equal(realpathSync(join(relay, 'current')), realpathSync(join(relay, second)));
    assert.deepEqual(readdirSync(relay).sort(), ['current', second].sort());
    assert.ok(readFileSync(j.program[0], 'utf8').includes('two'));
    assert.ok(!existsSync(join(relay, 'current/loose')));
    install(c.clone, env);
    assert.deepEqual(readdirSync(relay).sort(), ['current', second].sort());
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
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
    const r = command([verb], { hostUser: userInfo().username });
    try {
      assert.equal(r.code, 2, r.out);
      assert.deepEqual(r.calls, []);
    } finally {
      r.cleanup();
    }
  }
});
