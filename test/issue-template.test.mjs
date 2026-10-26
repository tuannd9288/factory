// #82: the factory's own issue template asks for the sublayer, naming all 17 codes of the one list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the task template starts with the Sublayer line, lists every code and name, then the sections', async () => {
  const { SUBLAYERS } = await import('../bin/lib/sublayers.mjs');
  const template = readFileSync(join(root, '.github/ISSUE_TEMPLATE/task.md'), 'utf8');
  const body = template.replace(/^---\n[\s\S]*?\n---\n/, '');
  assert.match(body, /^\*\*Sublayer:\*\* /m);
  for (const s of SUBLAYERS) assert.ok(body.includes(`${s.code} ${s.name}`), `names ${s.code} ${s.name}`);
  const sections = [...body.matchAll(/^\*\*(Goal|Acceptance|Limits|Prior art)\.?\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(sections, ['Goal', 'Acceptance', 'Limits', 'Prior art']);
});
