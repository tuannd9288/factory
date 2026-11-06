// #351: the wake line and its post to a Claude Code inbox socket (bin/lib/wake.mjs), against a real unix socket served in a temporary
// folder. Nothing else is connected to.
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { alive, post, postSync, recordedPath, wakeLine } from '../bin/lib/wake.mjs';

/** A listener on `path` that keeps what each connection sent. */
function serve(path) {
  const got = [];
  const server = createServer((c) => {
    let text = '';
    c.on('data', (d) => (text += d));
    c.on('end', () => got.push(text));
  });
  return new Promise((done) => server.listen(path, () => done({ server, got })));
}

const until = async (test, ms = 3000) => {
  for (const start = Date.now(); !test() && Date.now() - start < ms; ) await new Promise((r) => setTimeout(r, 10));
};

async function world(body) {
  const dir = mkdtempSync(join(tmpdir(), 'wake-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the line is one JSON object, type and message.content alone, with no priority and no auth line, and ends in one newline', () => {
  const line = wakeLine('o/app', 7, 1700000000000);
  assert.ok(line.endsWith('}\n') && line.indexOf('\n') === line.length - 1, JSON.stringify(line));
  const o = JSON.parse(line);
  assert.deepEqual(Object.keys(o), ['type', 'message']);
  assert.equal(o.type, 'user');
  assert.deepEqual(Object.keys(o.message), ['content']);
  assert.match(o.message.content, /^\[factory\] wake #1700000000000-\d+: new comment on o\/app#7; re-read the issue\.$/);
});

test('the number in the line differs on every post, also within one millisecond', () => {
  const seen = new Set();
  for (let i = 0; i < 5; i++) seen.add(JSON.parse(wakeLine('o/app', 7, 1700000000000)).message.content);
  assert.equal(seen.size, 5);
  assert.ok(!seen.has(JSON.parse(wakeLine('o/app', 7, 1700000000001)).message.content));
});

test('post writes the line to the socket the file records, with or without a leading uds:', async () => {
  await world(async (dir) => {
    const sock = join(dir, 's');
    const { server, got } = await serve(sock);
    try {
      const file = join(dir, 'socket');
      writeFileSync(file, `${sock}\n`);
      const line = wakeLine('o/app', 7);
      assert.deepEqual(await post(file, line), { posted: true });
      writeFileSync(file, `uds:${sock}\n`);
      const again = wakeLine('o/app', 7);
      assert.deepEqual(await post(file, again), { posted: true });
      await until(() => got.length === 2);
      assert.deepEqual(got, [line, again]);
      assert.equal(recordedPath(file), sock);
    } finally {
      server.close();
    }
  });
});

test('postSync posts the same line from a process of its own', async () => {
  await world(async (dir) => {
    const sock = join(dir, 's');
    const { server, got } = await serve(sock);
    try {
      const file = join(dir, 'socket');
      writeFileSync(file, `${sock}\n`);
      const line = wakeLine('o/app', 9);
      assert.deepEqual(postSync(file, line), { posted: true });
      await until(() => got.length === 1);
      assert.deepEqual(got, [line]);
    } finally {
      server.close();
    }
    assert.deepEqual(postSync(join(dir, 'none'), 'x\n'), { posted: false, why: 'no file' });
  });
});

test('a missing file, an empty one and a relative path post nothing', async () => {
  await world(async (dir) => {
    assert.deepEqual(await post(join(dir, 'none'), 'x\n'), { posted: false, why: 'no file' });
    writeFileSync(join(dir, 'empty'), '\n');
    assert.deepEqual(await post(join(dir, 'empty'), 'x\n'), { posted: false, why: 'no file' });
    writeFileSync(join(dir, 'rel'), 's.sock\n');
    assert.deepEqual(await post(join(dir, 'rel'), 'x\n'), { posted: false, why: 'not an absolute path' });
    writeFileSync(join(dir, 'gone'), `${join(dir, 'no-such.sock')}\n`);
    assert.deepEqual(await post(join(dir, 'gone'), 'x\n'), { posted: false, why: 'no file' });
  });
});

test('a regular file and a symlink to a socket are refused, and the socket is not written to', async () => {
  await world(async (dir) => {
    const sock = join(dir, 's');
    const { server, got } = await serve(sock);
    try {
      writeFileSync(join(dir, 'plain'), 'x');
      const file = join(dir, 'socket');
      writeFileSync(file, `${join(dir, 'plain')}\n`);
      assert.deepEqual(await post(file, 'x\n'), { posted: false, why: 'not a socket' });
      symlinkSync(sock, join(dir, 'link'));
      writeFileSync(file, `${join(dir, 'link')}\n`);
      assert.deepEqual(await post(file, 'x\n'), { posted: false, why: 'not a socket' });
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(got, []);
    } finally {
      server.close();
    }
  });
});

test('a socket of another user is refused', async () => {
  await world(async (dir) => {
    const sock = join(dir, 's');
    const { server, got } = await serve(sock);
    const real = process.getuid;
    try {
      const file = join(dir, 'socket');
      writeFileSync(file, `${sock}\n`);
      process.getuid = () => real.call(process) + 1;
      assert.deepEqual(await post(file, 'x\n'), { posted: false, why: 'not ours' });
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(got, []);
    } finally {
      process.getuid = real;
      server.close();
    }
  });
});

test('a socket file nothing listens on is refused', async () => {
  await world(async (dir) => {
    const sock = join(dir, 's');
    // A process that listens and is killed leaves its socket file behind.
    spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    const file = join(dir, 'socket');
    writeFileSync(file, `${sock}\n`);
    assert.deepEqual(await post(file, 'x\n'), { posted: false, why: 'refused' });
  });
});


test('alive validates the record and connects without writing, destroying live, refused and timed-out connections', async (t) => {
  let path;
  let socketFile = true;
  let owner = process.getuid();
  let event = 'connect';
  const connections = [];
  t.mock.method(fs, 'readFileSync', () => {
    if (path === undefined) throw new Error('missing record');
    return path;
  });
  t.mock.method(fs, 'lstatSync', () => {
    if (socketFile === null) throw new Error('missing socket');
    return { isSocket: () => socketFile, uid: owner };
  });
  t.mock.method(net, 'createConnection', (address) => {
    assert.equal(address, '/fixture/inbox.sock');
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; };
    socket.write = socket.end = () => assert.fail('alive must not write or end with data');
    connections.push(socket);
    if (event) process.nextTick(() => socket.emit(event));
    return socket;
  });
  syncBuiltinESMExports();
  try {
    for (path of [undefined, '', '\n', 'relative.sock']) assert.equal(await alive('/fixture/record'), false);
    path = '/fixture/inbox.sock';
    for (socketFile of [null, false]) assert.equal(await alive('/fixture/record'), false);
    socketFile = true;
    owner += 1;
    assert.equal(await alive('/fixture/record'), false);
    assert.equal(connections.length, 0);
    owner = process.getuid();
    for (path of ['/fixture/inbox.sock\n', 'uds:/fixture/inbox.sock\n']) {
      assert.equal(await alive('/fixture/record'), true);
      assert.equal(connections.at(-1).destroyed, true);
    }
    event = 'error';
    assert.equal(await alive('/fixture/record'), false);
    assert.equal(connections.at(-1).destroyed, true);
    event = null;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = alive('/fixture/record');
    t.mock.timers.tick(3000);
    assert.equal(await pending, false);
    assert.equal(connections.at(-1).destroyed, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
