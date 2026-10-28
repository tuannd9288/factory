// A byte-order mark at the start of AGENTS.md is refused, not handled (#132): the block must come first, and the kit does
// not move or strip a mark the repository put there. The refusal is the same one CRLF gets, from insertGate and so from
// the composition onboard writes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const BLOCK = '<!-- factory:gate:begin -->\n## Gate\n<!-- factory:gate:end -->\n';

describe('a BOM at the start of AGENTS.md', () => {
  test('insertGate refuses it, with its own problem, whatever follows', async () => {
    const { insertGate } = await lib();
    for (const text of ['﻿# App\n\nrules\n', '﻿rules\n', '﻿']) assert.throws(() => insertGate(text, BLOCK), (e) => e.problem === 'bom', JSON.stringify(text));
  });

  test('composeAgents refuses it too, and a BOM further down is only text', async () => {
    const { composeAgents } = await lib();
    assert.throws(() => composeAgents('﻿# App\n', BLOCK, 'app'), (e) => e.problem === 'bom');
    assert.equal(composeAgents('# App\n\nsee ﻿ here\n', BLOCK, 'app'), `# App\n\n${BLOCK}\nsee ﻿ here\n`);
  });
});
