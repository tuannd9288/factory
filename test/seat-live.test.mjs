// bin/seat (#117): a pid file counts as a live session only when its process is this user's and did not start after the file
// was written (a pid the system gave to a later process is not the session that wrote it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lib = () => import('../bin/lib/seat.mjs');

function runs(body) {
  const root = mkdtempSync(join(tmpdir(), 'seat-live-'));
  mkdirSync(join(root, 'issue-1'));
  const put = (name, text, ext) => writeFileSync(join(root, 'issue-1', `run-${name}.${ext}`), `${text}\n`);
  try {
    return body(root, put);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a pid file holding pid 1, a process of another user, is not a live session', async () => {
  const { liveCount } = await lib();
  runs((root, put) => {
    put('init', 1, 'pid');
    put('init', 2, 'seat');
    assert.equal(liveCount(root, 2), 0);
  });
});

test('a pid file written before its process started is a reused pid, not a live session; one written after counts', async () => {
  const { liveCount } = await lib();
  runs((root, put) => {
    const file = join(root, 'issue-1', 'run-old.pid');
    put('old', process.pid, 'pid');
    put('old', 2, 'seat');
    assert.equal(liveCount(root, 2), 1, 'written after this process started');
    const past = new Date(Date.now() - 3600 * 1000);
    utimesSync(file, past, past);
    assert.equal(liveCount(root, 2), 0, 'written an hour ago, before this process started');
  });
});
