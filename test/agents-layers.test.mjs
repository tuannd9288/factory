// The factory's own AGENTS.md has one section with the layers, their sublayers and the contracts between them, and what
// checks each contract (#80). Names come from the Human's sourced table of 2026-10-25; the section is English only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const HEADING = '## Layers, sublayers and contracts';
const LAYERS = ['Layer 0 Substrate', 'Layer 1 Orchestration', 'Layer 2 Workers', 'Layer 3 Merge gates', 'Layer 4 Observability & evals'];
const SUBLAYERS = [
  '0a Environment', '0b Tools & permissions', '0c Model configuration', '0d Harness & session',
  '1a Issues', '1b System of record', '1c Orchestrator-workers', '1d Monitoring', '1e Surfaces',
  '2a Context', '2b Skills & plugins', '2c Verification',
  '3a Required status checks', '3b Risk tiers', '3c Merge & rollback',
  '4a Observability & cost', '4b Evals',
];

const agents = () => readFileSync(join(factory, 'AGENTS.md'), 'utf8');
const section = () => {
  const text = agents();
  const start = text.split('\n').indexOf(HEADING);
  assert.notEqual(start, -1, `AGENTS.md has no "${HEADING}" section`);
  const lines = text.split('\n').slice(start + 1);
  const end = lines.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
};
// Items are bullets that open with a bold label: `- **Layer 0 Substrate** [SH] …`.
const items = (body) => body.split('\n').filter((l) => l.startsWith('- **'));
const label = (line) => line.match(/^- \*\*([^*]+)\*\*/)[1];
// An item runs from its bullet to the next one.
const blocks = (body) => body.split(/\n(?=- \*\*)/).filter((b) => b.startsWith('- **'));

describe('the layers-and-contracts section of the factory AGENTS.md', () => {
  test('exists under its heading', () => {
    assert.ok(section().trim().length > 0);
  });

  test('names exactly the five layers, each with a source key', () => {
    const layers = items(section()).filter((l) => label(l).startsWith('Layer '));
    assert.deepEqual(layers.map(label), LAYERS);
    for (const l of layers) assert.match(l, /\[[A-Z]+[0-9]*[,\]]/, `no source key: ${l}`);
  });

  test('names exactly the 17 sublayers, each with a source key', () => {
    const subs = items(section()).filter((l) => /^[0-4][a-e] /.test(label(l)));
    assert.deepEqual(subs.map(label), SUBLAYERS);
    for (const l of subs) assert.match(l, /\[[A-Z]+[0-9]*[,\]]|\(table\)/, `no source key: ${l}`);
  });

  test('takes "layer" and "sublayer" from IEEE 802.3', () => {
    assert.match(section(), /IEEE 802\.3/);
    assert.ok(section().includes('The LLC sublayer and the MAC sublayer together are intended to have the same function as that described in the OSI model for the Data Link Layer alone.'));
  });

  test('gives each contract H1 to H9 once, with what checks it', () => {
    const contracts = blocks(section()).filter((b) => /^- \*\*H[0-9]\*\*/.test(b));
    assert.deepEqual(contracts.map((b) => label(b)), ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9']);
    for (const b of contracts) {
      assert.match(b, /Checked by: (`[^`]*[/.][^`]*`|none yet)/, `no check or "none yet": ${b}`);
    }
    assert.match(contracts[6], /Checked by: none yet/);
  });

  test('H9 holds its rules, its check and #76', () => {
    const h9 = blocks(section()).find((b) => b.startsWith('- **H9**'));
    assert.ok(h9, 'no H9');
    assert.match(h9, /merge queue/);
    assert.match(h9, /pack probe/);
    assert.match(h9, /#76/);
  });

  test('holds no Vietnamese letter', () => {
    assert.doesNotMatch(section(), /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i);
  });

  test('holds none of the names the Human struck', () => {
    for (const word of [/level/i, /tầng/i, /Factory Lead/, /builder/i]) {
      assert.doesNotMatch(section(), word);
    }
  });
});
