// The layers-and-contracts section of the factory's own AGENTS.md (#80) is English and uses none of the names the Human
// struck. Its content is not pinned here: AGENTS.md is tier 3, so the Human approves every change to it (2026-10-25).
// Only the section is read: AGENTS.md:14 quotes the Human in his own words, and "user-level" elsewhere is not a name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const HEADING = '## Layers, sublayers and contracts';

const section = () => {
  const lines = readFileSync(join(factory, 'AGENTS.md'), 'utf8').split('\n');
  const start = lines.indexOf(HEADING);
  assert.notEqual(start, -1, `AGENTS.md has no "${HEADING}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

test('the layers section holds no Vietnamese letter and none of the struck names', () => {
  const body = section();
  assert.doesNotMatch(body, /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i);
  for (const word of [/level/i, /tầng/i, /Factory Lead/, /builder/i]) assert.doesNotMatch(body, word);
});
