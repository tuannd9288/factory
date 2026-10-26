// The research eval's runner (#92, re-review 2): a run that skipped the key check says so, in what it prints and in its result file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalWorld } from './research-eval-world.mjs';

test('--skip-key-check prints "keys not checked" and the result file records keyCheck: false', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^keys not checked$/m);
  assert.equal(JSON.parse(readFileSync(join(w.run, 'research-eval-probe.json'), 'utf8')).keyCheck, false);
}));
