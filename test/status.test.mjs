// bin/lib/status.mjs (FAC-85, fix 12): the steps' markers, written and read in one place. A gh error's redaction in a marker is checked
// through the queue's own run in test/queue-visible.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { clearFailed, markFailed, markOk, readMarkers, repoMarker } from '../bin/lib/status.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'status-'));
/** p, or a failure that names what, once ms have passed: a pass that hangs fails its test instead of holding the file open. */
function within(p, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
/** The marker `name` holds after markFailed in a fresh state folder, as lines. */
const failedLines = (why, opts) => {
  const dir = folder();
  try {
    markFailed(dir, 'step', why, opts);
    return readFileSync(join(dir, 'step.failed'), 'utf8').split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('what went wrong is cut to 200 characters after the time', () => {
  const [line] = failedLines('word '.repeat(60));
  assert.equal(line.slice(line.indexOf(' ') + 1).length, 200);
});

test('what went wrong is redacted before it is cut, so a cut never leaves part of a secret readable', () => {
  // 185 characters, then a 40-character run that redact() masks whole; cut first, its first 15 characters would stay.
  const [line] = failedLines(`${'word '.repeat(37)}A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0`);
  assert.match(line, /\[redacted\]$/);
  assert.ok(!line.includes('A1b2C3'), line);
});

test('the lines below the first are redacted too', () => {
  const lines = failedLines('2 worktrees kept', { more: [`/x token ghp_${'x1'.repeat(20)}`] });
  assert.equal(lines[1], '/x token [redacted]');
});

test('a daemon pass that raises leaves queue-run.failed with the time and its first line', async () => {
  const dir = folder();
  try {
    const state = join(dir, 'state');
    // A folder where the sweep's lock keeps its database: opening it raises inside runPass.
    mkdirSync(join(state, 'queue.lock.db'), { recursive: true });
    const worker = new Worker(new URL('../bin/lib/daemon-pass.mjs', import.meta.url), { workerData: { state, human: 'nobody' }, stdout: true, stderr: true });
    const ended = new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', resolve);
    });
    try {
      await within(ended, 10000, 'the daemon pass to end');
    } finally {
      await worker.terminate();
    }
    assert.match(readFileSync(join(state, 'queue-run.failed'), 'utf8'), /^20\d\d-\d\d-\d\dT[\d:.]+Z \S.*\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker holds the time and the first line, with more lines below a failure; a clean run removes it; the readers list each one', () => {
  const dir = folder();
  try {
    const state = join(dir, 'state');
    const now = Date.parse('2026-11-08T05:00:00.000Z');
    markFailed(state, repoMarker('o/app'), 'o/app: HTTP 502\nthe second line is not kept', { now });
    markFailed(state, 'queue-worktrees', '2 worktrees of merged work kept: /a and 1 more', { now, more: ['/a', '/b'] });
    markOk(state, repoMarker('o/app'), { now });
    assert.equal(readFileSync(join(state, 'queue-o-app.failed'), 'utf8'), '2026-11-08T05:00:00.000Z o/app: HTTP 502\n');
    assert.equal(readFileSync(join(state, 'queue-worktrees.failed'), 'utf8'), '2026-11-08T05:00:00.000Z 2 worktrees of merged work kept: /a and 1 more\n/a\n/b\n');
    writeFileSync(join(state, 'queue-o-app.position'), '{}\n');
    assert.deepEqual(readMarkers(state), [
      { file: 'queue-o-app.failed', name: 'queue-o-app', kind: 'failed', line: '2026-11-08T05:00:00.000Z o/app: HTTP 502' },
      { file: 'queue-o-app.ok', name: 'queue-o-app', kind: 'ok', line: '2026-11-08T05:00:00.000Z' },
      { file: 'queue-worktrees.failed', name: 'queue-worktrees', kind: 'failed', line: '2026-11-08T05:00:00.000Z 2 worktrees of merged work kept: /a and 1 more' },
    ]);
    clearFailed(state, repoMarker('o/app'));
    assert.deepEqual(readdirSync(state).sort(), ['queue-o-app.ok', 'queue-o-app.position', 'queue-worktrees.failed']);
    assert.equal(readMarkers(join(dir, 'none')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker that cannot be written says so on stderr, with what it would have said, and throws nothing', (t) => {
  const dir = folder();
  const lines = [];
  t.mock.method(process.stderr, 'write', (text) => lines.push(String(text)));
  try {
    const state = join(dir, 'a-file');
    writeFileSync(state, 'not a folder\n');
    markFailed(state, 'queue-run', 'the sweep raised Error: boom');
    t.mock.restoreAll();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /queue-run\.failed could not be written .*: \S+ the sweep raised Error: boom\n$/);
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
