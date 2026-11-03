// #370 slice 2: the MacBook's relay (bin/lib/relay.mjs, bin/factory-relay). A pass reads the Mac mini's news lines through an injected `fetch`
// (or, for the commands, a fake ssh first on PATH) and posts through a fake `post`; a Lead's socket file is a file in a temporary state
// folder. No network, no listening socket. The wording of a log line is not tested (#112).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { job, pass } from '../bin/lib/relay.mjs';
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
  const w = {
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
        // The Mac mini's side honours --after, as bin/factory-events does.
        fetch: (after) => (asked.push(after), { status: 0, stdout: lines.filter((e) => e.seq > after).map((e) => `${JSON.stringify(e)}\n`).join(''), stderr: '' }),
        ...over,
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return w;
}

test('the first pass puts the cursor at the newest seq and wakes nothing; the next relays a new line once and moves the cursor', async () => {
  const w = world();
  try {
    w.serve([news(1), news(2)]);
    assert.equal(await w.pass(), 0);
    assert.deepEqual([w.posts.length, w.cursor()], [0, '2']);
    w.serve([news(1), news(2), news(3)]);
    assert.equal(await w.pass(), 0);
    assert.equal(w.posts.length, 1);
    assert.equal(w.posts[0].file, join(w.state, 'lead-here', 'app-pstack.socket'));
    assert.match(w.posts[0].content, /checks-red/);
    assert.equal(w.cursor(), '3');
    assert.deepEqual(w.asked.slice(-1), [2]);
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
    assert.match(w.posts[0].content, /o\/app#7/);
    assert.equal(w.cursor(), '7');
  } finally {
    w.cleanup();
  }
});

test('a post that fails is logged and not tried again', async () => {
  const w = world();
  try {
    w.serve([]);
    await w.pass();
    w.serve([news(1)]);
    let calls = 0;
    await w.pass({ post: () => (calls += 1, { posted: false, why: 'refused' }) });
    await w.pass({ post: () => (calls += 1, { posted: false, why: 'refused' }) });
    assert.deepEqual([calls, w.cursor()], [1, '1']);
    assert.ok(w.logs.length >= 1);
  } finally {
    w.cleanup();
  }
});

test('a failing ssh leaves the cursor and says so; a cursor above the Mac mini newest starts afresh without waking', async () => {
  const w = world();
  try {
    w.serve([news(1)]);
    await w.pass();
    w.serve([news(1), news(2)]);
    assert.equal(await w.pass({ fetch: () => ({ status: 255, stdout: '', stderr: 'Permission denied' }) }), 1);
    assert.equal(w.cursor(), '1');
    assert.ok(w.logs.some((l) => /Permission denied/.test(l)));
    // The Mac mini's file was made anew: it prints from its first line and says so on stderr.
    w.serve([news(1)]);
    await w.pass({ fetch: () => ({ status: 0, stdout: `${JSON.stringify(news(1))}\n`, stderr: 'factory-events: --after 1 is above the highest seq in events.jsonl (1); starting from its first line' }) });
    assert.deepEqual([w.posts.length, w.cursor()], [0, '1']);
  } finally {
    w.cleanup();
  }
});

test('plist renders a LaunchAgent that runs the relay every 60 s with no user key and no KeepAlive', () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'));
  try {
    const text = plist(job({ HOME: home, PATH: process.env.PATH }));
    assert.match(text, /<string>io\.github\.tuannd9288\.factory\.relay<\/string>/);
    assert.ok(!text.includes('<key>UserName</key>'));
    assert.ok(!text.includes('KeepAlive'));
    assert.match(text, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.match(text, /bin\/factory-relay<\/string>\s*<string>run<\/string>/);
    assert.ok(text.includes(join(home, 'Library/Logs/factory/relay.log')));
    const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(text)[1].split(':');
    assert.ok(path.includes(join(process.execPath, '..')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** The command with a fake ssh first on PATH that exits `code` after printing `out` to stdout; it logs its arguments to $HOME/calls, which is the job's too. */
function command(args, { code = 0, out = '', hostUser = 'nobody-here' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cmd-'));
  writeFileSync(join(dir, 'ssh'), ['#!/bin/sh', 'printf \'%s\\n\' "$*" >>"$HOME/calls"', `printf '%s' '${out}'`, `exit ${code}`, ''].join('\n'));
  chmodSync(join(dir, 'ssh'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, FACTORY_STATE: join(dir, 'state'), FACTORY_HOST_USER: hostUser };
  const r = spawnSync(join(factory, 'bin/factory-relay'), args, { encoding: 'utf8', env });
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) : [];
  return { dir, code: r.status, out: r.stdout + r.stderr, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('check reports a failing ssh and makes the log folder', () => {
  const r = command(['check'], { code: 255 });
  try {
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ssh .* failed/);
    assert.match(r.out, /not ready/);
    assert.ok(existsSync(join(r.dir, 'Library/Logs/factory')));
  } finally {
    r.cleanup();
  }
});

test('check is ready when ssh works and a pass runs', () => {
  const r = command(['check']);
  try {
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ready/);
    assert.ok(r.calls.some((c) => c.includes('BatchMode=yes') && c.includes('--news')));
  } finally {
    r.cleanup();
  }
});

test('run reads the news by ssh with BatchMode and a cursor, and its first pass sets the cursor from the newest line', () => {
  const line = JSON.stringify({ seq: 4, type: 'start', kind: 'merged', key: 'merged o/app#1', what: 'w', where: 'u', lead: 'app-pstack', woke: false, why: 'no file' });
  const r = command(['run'], { out: `${line}\n` });
  try {
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls[0].includes('BatchMode=yes') && /--news --after 0$/.test(r.calls[0]));
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
