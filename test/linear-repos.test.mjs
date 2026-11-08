import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onLinear, registryFile } from '../bin/lib/linear-repos.mjs';

test('the registry, keyed by name as onboard writes it, answers for the name its callers pass (FAC-85)', (t) => {
  const state = mkdtempSync(join(tmpdir(), 'linear-repos-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  mkdirSync(join(state, 'linear'), { recursive: true });
  writeFileSync(registryFile(state), JSON.stringify({ factory: { key: 'FAC', teamId: 'team-fac' } }));
  assert.deepEqual(onLinear('factory', state), { key: 'FAC', teamId: 'team-fac' });
  assert.equal(onLinear('zalo-gateway', state), null);
});
