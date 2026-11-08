// bin/lib/status.mjs (FAC-85, fix 12): the steps' markers, written and read in one place. A gh error's redaction in a marker is checked
// through the queue's own run in test/queue-visible.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFailed, markFailed, markOk, readMarkers, repoMarker } from '../bin/lib/status.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'status-'));

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
