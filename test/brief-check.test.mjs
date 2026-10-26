// bin/brief-check (#90): compares a brief with the relay it came from, with no model call. It fails when a span the
// relay puts in double quotes is missing from the brief's own body, and names each one. It does not check numbers (Colly,
// 2026-10-26): a number's place in a brief needs context to judge, and review holds it.
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

// Unit cases for the quote rule.

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

test('numbers: a number the relay holds and the brief lacks is not reported', async () => {
  const { missing } = await lib();
  assert.deepEqual(missing('about 50 tokens', 'khoảng 50–100 token, 2.5 and 1,000, in #71'), []);
  assert.deepEqual(missing('', 'Cost $10,22 in 25 minutes.'), []);
});

test('body: the brief ends at the attachment heading; what follows is data and carries nothing', async () => {
  const { ATTACHMENT_HEADING, body, missing } = await lib();
  assert.equal(ATTACHMENT_HEADING, "## Colly's message, attached as data");
  assert.equal(body(`Goal.\n\n${ATTACHMENT_HEADING}\n\n> 99`), 'Goal.\n\n');
  assert.equal(body('No attachment, so 5 stays.'), 'No attachment, so 5 stays.');
  assert.deepEqual(missing(`Goal.\n\n${ATTACHMENT_HEADING}\n\n> "x"`, '"x"'), [{ kind: 'quote', value: 'x' }]);
});

// The script, on the recorded messages.

// Case C is the source "Progressive disclosure". The brief writes it in lower case, and the check folds no case. The
// brief also turns the factory's rule "không skill cấp user" into English. Case B, the number 50–100, is not the script's.
test('it fails the real #71 brief against message 3, and names exactly the quotes it misses', () => {
  const r = brief([fixture('issue-71-brief.md'), fixture('message-3.md')]);
  assert.deepEqual(r, { code: 1, out: 'missing quote: "Progressive disclosure"\nmissing quote: "không skill cấp user"\n', err: '' });
});

test('it passes a brief written from the template that carries message 3', () => {
  const r = brief([fixture('issue-71-brief-carrying.md'), fixture('message-3.md')]);
  assert.deepEqual(r, { code: 0, out: 'brief-check: the brief carries every quote of the relay\n', err: '' });
});

test('it does not count the attached section: the real #71 brief with message 3 pasted under the heading still fails', async () => {
  const { ATTACHMENT_HEADING } = await lib();
  withFiles({ 'brief.md': `${read('issue-71-brief.md')}\n${ATTACHMENT_HEADING}\n\n${read('message-3.md')}` }, (dir) => {
    const r = brief([join(dir, 'brief.md'), fixture('message-3.md')]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^missing quote: "Progressive disclosure"$/m);
  });
});

// bin/brief-template.md is what a Lead writes a brief from; brief-check reads its attachment heading and nothing else of it.
test('a brief built from bin/brief-template.md is cut at its attachment: a quote only the attached message holds is missing', () => {
  const template = readFileSync(join(factory, 'bin/brief-template.md'), 'utf8');
  const relay = 'Colly: the Human said "refuse an empty name".\n';
  const attached = (text) => `${text}\n${relay}`;
  withFiles({ 'relay.md': relay, 'carries.md': attached(template.replace('## Goal\n', '## Goal\n\n"refuse an empty name"\n')), 'only-attached.md': attached(template) }, (dir) => {
    assert.equal(brief([join(dir, 'carries.md'), join(dir, 'relay.md')]).code, 0);
    assert.deepEqual(brief([join(dir, 'only-attached.md'), join(dir, 'relay.md')]), { code: 1, out: 'missing quote: "refuse an empty name"\n', err: '' });
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
