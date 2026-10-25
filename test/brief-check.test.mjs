// bin/brief-check (#90): compares a brief with the relay it came from, with no model call. It fails when a span the
// relay puts in double quotes, or a number in the relay, is missing from the brief's own body, and names each one.
// The fixtures in test/fixtures/relay/ are recorded data and keep the Human's language; see the README beside them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const fixture = (name) => join(factory, 'test/fixtures/relay', name);
const read = (name) => readFileSync(fixture(name), 'utf8');
const lib = () => import('../bin/lib/brief-check.mjs');

function brief(args) {
  const r = spawnSync(join(factory, 'bin/brief-check'), args, { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function withFiles(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'brief-check-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Unit cases for the two rules.

test('quotes: every straight or curly double-quoted span, with whitespace collapsed', async () => {
  const { quotes } = await lib();
  assert.deepEqual(quotes('He said "one  two\nthree" and “four” then "five".'), ['one two three', 'four', 'five']);
});

test('quotes: a curly span and a straight span of the same words are the same quote', async () => {
  const { missing } = await lib();
  assert.deepEqual(missing('Brief: “giữ nguyên văn” here.', 'Relay: "giữ nguyên văn".'), []);
  assert.deepEqual(missing('Brief: "giữ nguyên văn" here.', 'Relay: “giữ nguyên văn”.'), []);
});

test('quotes: a changed word, case or ending is a missing quote', async () => {
  const { missing } = await lib();
  assert.deepEqual(missing('He asked to keep it.', 'He said "Keep it verbatim."'), [{ kind: 'quote', value: 'Keep it verbatim.' }]);
  assert.deepEqual(missing('"keep it verbatim"', 'He said "Keep it verbatim"'), [{ kind: 'quote', value: 'Keep it verbatim' }]);
  assert.deepEqual(missing('"Keep it verbatim"', 'He said "Keep it verbatim."'), [{ kind: 'quote', value: 'Keep it verbatim.' }]);
});

test('quotes: the quote may sit anywhere in the brief, in or out of quotation marks', async () => {
  const { missing } = await lib();
  assert.deepEqual(missing('Keep   it\nverbatim', 'He said "Keep it verbatim"'), []);
});

test('numbers: a run of digits, with a decimal point or a comma inside it', async () => {
  const { numbers } = await lib();
  assert.deepEqual(numbers('50–100, 2.5 and 1,000; v2.1.308 in #71 (+14/−7).'), ['50', '100', '2.5', '1,000', '2.1.308', '71', '14', '7']);
  assert.deepEqual(numbers('Done. 3, then 4.'), ['3', '4']);
});

test('numbers: a brief that writes "50 to 100" carries 50–100', async () => {
  const { missing } = await lib();
  assert.deepEqual(missing('about 50 to 100 tokens', 'khoảng 50–100 token'), []);
});

test('numbers: a number inside a longer number is not carried', async () => {
  const { missing } = await lib();
  assert.deepEqual(missing('150 lines', 'at most 50 lines'), [{ kind: 'number', value: '50' }]);
  assert.deepEqual(missing('a 1,500 limit', 'a 1,000 limit'), [{ kind: 'number', value: '1,000' }]);
});

test('numbers: each missing number is named once', async () => {
  const { missing } = await lib();
  assert.deepEqual(missing('', '7 and 7 and 8'), [{ kind: 'number', value: '7' }, { kind: 'number', value: '8' }]);
});

test('body: the brief ends at the attachment heading; what follows is data and carries nothing', async () => {
  const { ATTACHMENT_HEADING, body, missing } = await lib();
  assert.equal(ATTACHMENT_HEADING, "## Colly's message, attached as data");
  assert.equal(body(`Goal.\n\n${ATTACHMENT_HEADING}\n\n> 99`), 'Goal.\n\n');
  assert.equal(body('No attachment, so 5 stays.'), 'No attachment, so 5 stays.');
  assert.deepEqual(missing(`Goal.\n\n${ATTACHMENT_HEADING}\n\n> "x" 99`, '"x" 99'), [
    { kind: 'quote', value: 'x' },
    { kind: 'number', value: '99' },
  ]);
});

// The script, on the recorded messages.

// Case B is "khoảng 50–100 token mỗi skill". The brief never says 100, so 100 is named. It does say "line 50" once
// (about AGENTS.md), so by the literal rule it carries a 50; the check has no context to tell the two apart.
test('it fails the real #71 brief against message 3, and names the case-B number', () => {
  const r = brief([fixture('issue-71-brief.md'), fixture('message-3.md')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^missing number: 100$/m);
  assert.match(r.out, /^missing quote: "Progressive disclosure"$/m);
  assert.equal(r.err, '');
});

test('it passes a brief written from the template that carries message 3', () => {
  const r = brief([fixture('issue-71-brief-carrying.md'), fixture('message-3.md')]);
  assert.deepEqual(r, { code: 0, out: 'brief-check: the brief carries every quote and number of the relay\n', err: '' });
});

test('it does not count the attached section: the real #71 brief with message 3 pasted under the heading still fails', async () => {
  const { ATTACHMENT_HEADING } = await lib();
  withFiles({ 'brief.md': `${read('issue-71-brief.md')}\n${ATTACHMENT_HEADING}\n\n${read('message-3.md')}` }, (dir) => {
    const r = brief([join(dir, 'brief.md'), fixture('message-3.md')]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^missing number: 100$/m);
  });
});

test('it takes exactly two files, and says so when a file cannot be read', () => {
  const none = brief([]);
  assert.equal(none.code, 2);
  assert.match(none.err, /usage: bin\/brief-check <brief> <relay>/);
  const gone = brief([fixture('issue-71-brief.md'), fixture('no-such-file.md')]);
  assert.equal(gone.code, 2);
  assert.match(gone.err, /no-such-file\.md/);
});
