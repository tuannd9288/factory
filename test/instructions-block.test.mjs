// The Gate block in a repository's AGENTS.md (#132): the kit owns one marked block at the start, after an optional
// title line, and the repository owns every byte after it. insertGate puts the block in, replaceGate swaps it, and
// splitGate tells the shapes that are red apart. The library is loaded inside each test, so a missing file fails a
// test, not the load.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const BEGIN = '<!-- factory:gate:begin -->';
const END = '<!-- factory:gate:end -->';
const BLOCK = `${BEGIN}\n## Gate\n\nGate marker: test-v1\n${END}\n`;
const OTHER = `${BEGIN}\n## Gate\n\nGate marker: test-v2\n${END}\n`;

describe('insertGate', () => {
  test('puts the block after the title line and its blank line, and a blank line before the rest', async () => {
    const { insertGate } = await lib();
    assert.equal(insertGate('# App\n\nOur rules.\n', BLOCK), `# App\n\n${BLOCK}\nOur rules.\n`);
  });

  test('adds the blank line a title line lacks, and nothing else', async () => {
    const { insertGate } = await lib();
    assert.equal(insertGate('# App\nOur rules.\n', BLOCK), `# App\n\n${BLOCK}\nOur rules.\n`);
  });

  test('a file with no title line gets the block at its first byte', async () => {
    const { insertGate } = await lib();
    assert.equal(insertGate('Our rules.\n', BLOCK), `${BLOCK}\nOur rules.\n`);
    assert.equal(insertGate('', BLOCK), BLOCK);
  });

  test('a title line alone, and blank lines at the start, are the head', async () => {
    const { insertGate } = await lib();
    assert.equal(insertGate('# App\n', BLOCK), `# App\n\n${BLOCK}`);
    assert.equal(insertGate('\n\nrules\n', BLOCK), `\n\n${BLOCK}\nrules\n`);
  });

  test('a second heading is not a title: only line 1 is', async () => {
    const { insertGate } = await lib();
    assert.equal(insertGate('Intro\n# App\n', BLOCK), `${BLOCK}\nIntro\n# App\n`);
    assert.equal(insertGate('## App\n', BLOCK), `${BLOCK}\n## App\n`);
  });

  test('taking the inserted bytes out gives the original back, with no final newline too', async () => {
    const { insertGate } = await lib();
    for (const text of ['# App\n\nrules\nmore', 'rules\n\n\nmore\n', '# App\n\nlast line, no newline']) {
      assert.equal(insertGate(text, BLOCK).replace(`${BLOCK}\n`, ''), text);
    }
    assert.equal(insertGate('# App\n', BLOCK).replace(`${BLOCK}`, '').replace('\n\n', '\n'), '# App\n');
  });

  test('is idempotent: a file that already starts with exactly the block comes back unchanged', async () => {
    const { insertGate } = await lib();
    const once = insertGate('# App\n\nrules\n', BLOCK);
    assert.equal(insertGate(once, BLOCK), once);
    assert.equal(insertGate(BLOCK, BLOCK), BLOCK);
  });

  test('refuses CRLF, a changed block, a stray marker, two blocks and a block that is not first', async () => {
    const { insertGate } = await lib();
    const refused = (text, problem) => assert.throws(() => insertGate(text, BLOCK), (e) => e.problem === problem, `${problem}: ${JSON.stringify(text)}`);
    refused('# App\r\n\r\nrules\r\n', 'crlf');
    refused(`# App\n\n${OTHER}\nrules\n`, 'altered');
    refused(`${BEGIN}\nrules\n`, 'malformed');
    refused(`rules\n${END}\n`, 'malformed');
    refused(`${BLOCK}\n${BLOCK}`, 'duplicate');
    refused(`Intro\n\n${BLOCK}`, 'not-at-start');
  });
});

describe('replaceGate', () => {
  test('swaps the block and keeps the head and every byte of the tail, a missing final newline included', async () => {
    const { insertGate, replaceGate } = await lib();
    for (const rest of ['rules\n', 'rules\n\n\n  indented\n', 'no newline at the end']) {
      const text = insertGate(`# App\n\n${rest}`, BLOCK);
      assert.equal(replaceGate(text, OTHER), `# App\n\n${OTHER}\n${rest}`);
    }
    assert.equal(replaceGate(BLOCK, OTHER), OTHER);
  });

  test('refuses a file with no block, or with one that is malformed', async () => {
    const { replaceGate } = await lib();
    assert.throws(() => replaceGate('rules\n', OTHER), (e) => e.problem === 'missing');
    assert.throws(() => replaceGate(`${BEGIN}\nrules\n`, OTHER), (e) => e.problem === 'malformed');
  });
});

describe('splitGate', () => {
  test('cuts a good file into head, block and tail that join back to the file', async () => {
    const { splitGate } = await lib();
    const text = `# App\n\n${BLOCK}\ntail one\ntail two`;
    const s = splitGate(text);
    assert.equal(s.ok, true);
    assert.deepEqual([s.head, s.block, s.tail], ['# App\n\n', BLOCK, '\ntail one\ntail two']);
    assert.equal(s.head + s.block + s.tail, text);
  });

  test('tells each red shape apart', async () => {
    const { splitGate } = await lib();
    const problem = (text) => splitGate(text).problem;
    assert.equal(problem('rules\n'), 'missing');
    assert.equal(problem(''), 'missing');
    assert.equal(problem(`${BEGIN}\nx\n`), 'malformed');
    assert.equal(problem(`x\n${END}\n`), 'malformed');
    assert.equal(problem(`${END}\n${BEGIN}\n`), 'malformed');
    assert.equal(problem(`${BLOCK}${BEGIN}\n`), 'duplicate');
    assert.equal(problem(`${BLOCK}${END}\n`), 'duplicate');
    assert.equal(problem(`Intro\n${BLOCK}`), 'not-at-start');
    assert.equal(problem(`# App\nIntro\n${BLOCK}`), 'not-at-start');
    assert.equal(problem(`﻿# App\n\n${BLOCK}`), 'not-at-start');
  });

  test('counts a marker line inside a code fence: a fence does not hide it', async () => {
    const { splitGate } = await lib();
    assert.equal(splitGate(`${BLOCK}\n\`\`\`\n${BEGIN}\n\`\`\`\n`).problem, 'duplicate');
  });

  test('a marker that is only part of a line is text', async () => {
    const { splitGate } = await lib();
    assert.equal(splitGate(`${BLOCK}\nsee ${BEGIN} above\n`).ok, true);
  });
});
