// The factory's own AGENTS.md has one section with the layers, their sublayers and the contracts between them, and what
// checks each contract (#80). Names come from the Human's sourced table of 2026-10-25; the section is English only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

  // Fix round 1 (#80): the IEEE clause was confirmed, the keys resolve from the repository, H9 gets its five rules,
  // 1e lists what the Human decided, and H3 cites only a line that binds a commit. Every test above is unchanged.
  test('cites IEEE as [IEEE], read in the draft amendment, with nothing left unconfirmed', () => {
    const s = section();
    assert.match(s, /IEEE 802\.3[^\n]*\[IEEE\]/);
    assert.match(s, /P802\.3as\/D0\.1/);
    assert.doesNotMatch(s, /Colly quoted|not confirmed/);
  });

  test('points the source keys to the table on #80, not to a file outside the repository', () => {
    const s = section();
    assert.ok(s.includes('https://github.com/tuannd9288/factory/issues/80#issuecomment-6399460150'));
    assert.doesNotMatch(s, /report\.md/);
  });

  test('H9 states its five rules, has no check yet, and says what the check will be', () => {
    const h9 = blocks(section()).find((b) => b.startsWith('- **H9**'));
    assert.match(h9, /Checked by: none yet/);
    for (const n of [1, 2, 3, 4, 5]) assert.ok(h9.includes(`(${n})`), `no rule (${n})`);
    for (const word of ['0d', '1b', '#58', 'K3', 'herdr agent send-keys', 'herdr pane send-keys', 'rex send', 'rex send-key']) {
      assert.ok(h9.includes(word), `H9 lacks ${word}`);
    }
    assert.match(h9, /stops every surface/);
    assert.match(h9, /not yet in the kit's deny rules/);
  });

  test('1e lists no Ghostty on any of its lines, and marks each pending item', () => {
    const block = blocks(section()).find((b) => b.startsWith('- **1e '));
    assert.doesNotMatch(block, /Ghostty/);
    assert.match(block, /K1 = C, pending/);
    assert.match(block, /\(T3, pending\)/);
  });

  test('2b names the modules a repository lists in .gate/modules', () => {
    const block = blocks(section()).find((b) => b.startsWith('- **2b '));
    assert.match(block, /modules \(#70\)/);
    assert.ok(block.includes('`.gate/modules`'));
  });

  // Fix round 2 (#80, Colly): a contract's sentence states the factory's rule and is no quote; an organization's
  // quote sits on an optional "Prior art [KEY]" line.
  test('each contract states its own sentence, which is not a quote', () => {
    const sentences = [
      'Work enters through one issue.',
      'Work leaves through one pull request that carries its evidence.',
      'A verdict binds exactly one commit.',
      'Knowledge is files in the repository, changed by pull request.',
      'A way of working is a pack of data.',
      'Tools are commands; permissions live outside the instructions.',
      'Model choice lives outside the way of working.',
      'An improvement comes back as ordinary work.',
      'A surface is only a window.',
    ];
    const contracts = blocks(section()).filter((b) => /^- \*\*H[0-9]\*\*/.test(b));
    contracts.forEach((b, i) => {
      const after = b.replace(/^- \*\*H[0-9]\*\*:?\s*/, '');
      assert.ok(after.startsWith(sentences[i]), `H${i + 1} does not open with its sentence: ${after.slice(0, 60)}`);
      assert.doesNotMatch(after, /^["“]/, `H${i + 1} opens with a quote mark`);
    });
  });

  test('a Prior art line reads Prior art [KEY]: "…", and each contract that has one has it once', () => {
    for (const b of blocks(section()).filter((x) => /^- \*\*H[0-9]\*\*/.test(x))) {
      const found = b.match(/Prior art/g) ?? [];
      assert.ok(found.length <= 1, `two Prior art lines in ${b.slice(0, 20)}`);
      if (found.length) assert.match(b, /\n {2}Prior art \[[A-Z]+[0-9]*\]: ".+"\s*$/, `malformed Prior art: ${b.slice(0, 20)}`);
    }
  });

  test('every path in a "Checked by" exists, with its cited lines in range', () => {
    let seen = 0;
    for (const b of blocks(section()).filter((x) => /^- \*\*H[0-9]\*\*/.test(x))) {
      const segment = b.slice(b.indexOf('Checked by:')).split('\n  Prior art')[0];
      if (/^Checked by: none yet/.test(segment)) continue;
      for (const m of segment.matchAll(/`([^`\s]+?)(?::(\d+)(?:-(\d+))?)?`/g)) {
        const [, path, from, to] = m;
        if (!/[/.]/.test(path)) continue; // a name in backticks, such as `factory`, is no path
        const file = join(factory, path);
        assert.ok(existsSync(file), `${label(b)} cites ${path}, which does not exist`);
        seen += 1;
        if (from) {
          const lines = readFileSync(file, 'utf8').split('\n').length;
          assert.ok(Number(from) >= 1 && Number(to ?? from) <= lines && Number(from) <= Number(to ?? from),
            `${label(b)} cites ${path}:${from}${to ? `-${to}` : ''}, outside its ${lines} lines`);
        }
      }
    }
    assert.ok(seen >= 15, `only ${seen} checked paths found`);
  });

  test('H3 does not cite the ruleset line that only requires an up-to-date branch', () => {
    const h3 = blocks(section()).find((b) => b.startsWith('- **H3**'));
    assert.doesNotMatch(h3, /ruleset\.json/);
    assert.match(h3, /kit\/scripts\/lib\/approval\.mjs/);
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
