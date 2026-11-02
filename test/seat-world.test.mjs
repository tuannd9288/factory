// #330: the bin/seat tests' cleanup kills every process its run folder records. A supervisor removes its run-<tag>.child file
// when its session ends, so a file listed by the cleanup can be gone by the time it is read; the cleanup must skip it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killRecorded } from './seat-world.mjs';

test('a pid file removed between the listing and its read is skipped, and the other recorded process is still killed', async () => {
  const run = mkdtempSync(join(tmpdir(), 'seat-world-kill-'));
  const kids = ['a', 'b'].map(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }));
  const ends = kids.map((k) => new Promise((resolve) => k.on('exit', (code, signal) => resolve(signal))));
  try {
    kids.forEach((k, i) => writeFileSync(join(run, `run-${'ab'[i]}.child`), String(k.pid)));
    // Whichever file the listing gives first, its supervisor ends now: that file goes after the listing and before its read.
    let removed = null;
    const read = (file) => {
      if (removed === null) {
        removed = file;
        rmSync(file);
      }
      return readFileSync(file, 'utf8');
    };
    assert.doesNotThrow(() => killRecorded(run, read));
    assert.equal(await ends[removed.endsWith('run-a.child') ? 1 : 0], 'SIGKILL');
  } finally {
    for (const k of kids) k.kill('SIGKILL');
    rmSync(run, { recursive: true, force: true });
  }
});
