// #370 slice 2: the MacBook's relay (bin/lib/relay.mjs, bin/factory-relay). A pass reads the Mac mini's news lines through an injected `fetch`
// and `newest` (or, for the commands, a fake ssh first on PATH) and posts through a fake `post`; a Lead's socket file is a file in a temporary
// state folder. No network, no listening socket. Exit codes, posts and cursor values are asserted, never the wording of a log line (#112).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { HOST, check, guard, job, main, pass } from '../bin/lib/relay.mjs';
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
      news(6, { what: 'y'.repeat(300), where: path }),
      news(7, { where: 'https://github.com/o/app/pull/7' }),
    ]);
    await w.pass();
    assert.equal(w.posts.length, 2);
    assert.ok(w.posts[0].content.includes(`${HOST}:${path}`));
    assert.ok(w.posts[1].content.includes('https://github.com/o/app/pull/7') && !w.posts[1].content.includes(`${HOST}:`));
    assert.equal(w.cursor(), '7');
  } finally {
    w.cleanup();
  }
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
    await w.pass({ fetch: () => ({ status: 0, stdout: `${JSON.stringify(news(1))}\n${JSON.stringify(news(2))}\n`, stderr: 'factory-events: --after 1 is above the highest seq in events.jsonl (2); starting from its first line' }) });
    assert.deepEqual([w.posts.length, w.cursor()], [0, '2']);
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
  try {
    assert.deepEqual(guard(r.clone), { refuse: null, note: null });
    assert.equal(typeof guard(r.tree).refuse, 'string');
    r.git(r.clone, 'checkout', '-q', '-b', 'other');
    const g = guard(r.clone);
    assert.equal(g.refuse, null);
    assert.equal(typeof g.note, 'string');
    const env = { HOME: r.dir, PATH: process.env.PATH, FACTORY_HOST_USER: 'nobody-here' };
    await assert.rejects(main(['plist'], env, r.tree));
    await assert.rejects(main(['check'], env, r.tree));
  } finally {
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

/** `check` in this process, with a fake ssh: it answers `--newest` with 4 and logs its calls under HOME. */
function checkWith({ code = 0, cursor = null, sock = '/agent.sock' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-check-'));
  writeFileSync(join(dir, 'ssh'), ['#!/bin/sh', 'printf \'%s sock=%s\\n\' "$*" "$SSH_AUTH_SOCK" >>"$HOME/calls"', 'case "$*" in *--newest*) echo 4 ;; esac', `exit ${code}`, ''].join('\n'));
  chmodSync(join(dir, 'ssh'), 0o755);
  const state = join(dir, 'state');
  if (cursor !== null) {
    mkdirSync(state);
    writeFileSync(join(state, 'relay.cursor'), `${cursor}\n`);
  }
  const was = console.log;
  console.log = () => {};
  let exit;
  try {
    exit = check({ HOME: dir, PATH: `${dir}:${process.env.PATH}`, FACTORY_STATE: state, SSH_AUTH_SOCK: sock });
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

test('check passes when ssh works: it passes SSH_AUTH_SOCK on, sets the cursor to the newest seq only when there is none, and posts nothing', () => {
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
