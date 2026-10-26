// #82: the one list of the 17 sublayers (bin/lib/sublayers.mjs) agrees with the map in AGENTS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the list holds the 17 sublayers of AGENTS.md, word for word', async () => {
  const { SUBLAYERS } = await import('../bin/lib/sublayers.mjs');
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const mapped = [...agents.matchAll(/^- \*\*([0-9][a-z]) (.+?)\*\*/gm)].map((m) => [m[1], m[2]]);
  assert.equal(mapped.length, 17);
  assert.deepEqual(SUBLAYERS.map((s) => [s.code, s.name]), mapped);
  for (const s of SUBLAYERS) {
    assert.equal(s.label, `sublayer-${s.code}`);
    assert.equal(s.description, `${s.code} ${s.name}`);
  }
});
