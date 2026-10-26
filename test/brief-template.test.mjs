// bin/brief-template.md (#90): the Lead's brief, #67's four parts extended to seven fields, then Colly's message attached as
// data under the heading bin/brief-check cuts the brief at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { ATTACHMENT_HEADING, body } from '../bin/lib/brief-check.mjs';

const template = readFileSync(join(factory, 'bin/brief-template.md'), 'utf8');
const headings = template.split('\n').filter((line) => /^## /.test(line));

test('the template has the seven fields of #90 in order, then the attachment', () => {
  assert.deepEqual(headings, [
    '## Goal',
    "## The Human's words and their source",
    '## What is settled',
    '## What is still open',
    '## How Colly read it',
    '## Where things are',
    '## What to report back',
    ATTACHMENT_HEADING,
  ]);
});

test('the attachment heading occurs once, so the brief is cut where the template says', () => {
  assert.equal(template.split('\n').filter((line) => line === ATTACHMENT_HEADING).length, 1);
  assert.ok(!body(template).includes(ATTACHMENT_HEADING));
});

test('each field says what goes in it, and the rule of verbatim quotes is stated', () => {
  for (const heading of headings.slice(0, -1)) {
    const at = template.indexOf(`${heading}\n`);
    const next = template.indexOf('\n## ', at + 1);
    assert.ok(template.slice(at + heading.length, next).trim().length > 20, `${heading} has no guidance`);
  }
  assert.match(template, /verbatim/);
  assert.match(template, /keeps the language the Human wrote it in/);
  assert.match(template, /bin\/brief-check/);
});
