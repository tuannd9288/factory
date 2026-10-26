// The research eval's runner (#92, re-review 3): when bin/seat refuses to start a session (no free seat), the runner leaves neither
// a run folder nor a work folder of it, so that starting it again later is not refused as "left from an earlier run". The plain
// world is used: evalWorld's w.eval removes every re-* run folder after each run, which would hide a folder left behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fill, world } from './seat-world.mjs';
import { RUN_JS } from './research-eval-world.mjs';

test('a session bin/seat refused leaves no folder under the runs folder or the work folder', () => world((w) => {
  fill(w, 2, 4);
  const r = spawnSync(process.execPath, [RUN_JS, '--set', 'probe', '--run', w.run, '--work', w.work, '--poll-ms', '40', '--skip-key-check', '--go'], { encoding: 'utf8', cwd: w.root, env: w.env() });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /bin\/seat refused re-knip-reader-A-1/);
  assert.deepEqual(readdirSync(w.runs).filter((n) => n.startsWith('re-')), []);
  assert.deepEqual(readdirSync(w.work), []);
}));
