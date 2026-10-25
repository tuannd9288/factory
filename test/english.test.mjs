// #98: the pull request template is English, and its fields are the ones the kit pull request body also uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the pull request template is English, with the fields the kit pull request body also uses', () => {
  const template = readFileSync(join(root, 'kit/.github/pull_request_template.md'), 'utf8');
  assert.match(template, /^## Summary for the Human$/m);
  const fields = [...template.matchAll(/^- ([A-Za-z ]+): /gm)].map((m) => m[1]);
  assert.deepEqual(fields, ['Purpose', 'Change', 'Evidence', 'Tier', 'Rollback', 'Needs the Human']);
  assert.match(template, /No-red: <reason, at least 20 characters>/);
});
