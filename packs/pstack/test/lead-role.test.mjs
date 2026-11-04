// packs/pstack/lead.md and roleOf (#404): the file holds each issue step in its GitHub and its Linear form, and a Lead gets one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { roleOf } from '../bin/lead.mjs';

const text = readFileSync(fileURLToPath(new URL('../lead.md', import.meta.url)), 'utf8');

test('the markers of lead.md are paired and never nested', () => {
  for (const form of ['github', 'linear']) {
    const opens = [...text.matchAll(new RegExp(`<!--${form}-->`, 'g'))].length;
    const closes = [...text.matchAll(new RegExp(`<!--/${form}-->`, 'g'))].length;
    assert.equal(opens, closes, form);
    assert.ok(opens > 0, form);
    assert.doesNotMatch(text, new RegExp(`<!--${form}-->(?:(?!<!--/${form}-->)[\\s\\S])*<!--(?:github|linear)-->`), `${form} spans nest`);
  }
});

test('the GitHub form has no Linear step and no marker, and the Linear form has no gh issue call and no marker', () => {
  const github = roleOf(text, false);
  const linear = roleOf(text, true);
  for (const out of [github, linear]) assert.doesNotMatch(out, /<!--/);
  assert.doesNotMatch(github, /factory linear/);
  assert.match(github, /gh issue view/);
  assert.doesNotMatch(linear, /gh issue/);
  assert.match(linear, /factory linear take/);
  assert.match(linear, /factory linear list --team-key \{\{TEAMKEY\}\}/);
  assert.doesNotMatch(github, /TEAMKEY/);
  // the rest of the loop is the same in both forms
  for (const out of [github, linear]) assert.match(out, /scripts\/ship --body-file/);
});

test('each form names the way an issue closes: Closes for GitHub, Fixes with the key for Linear', () => {
  assert.match(roleOf(text, false), /`Closes #<n>`/);
  assert.doesNotMatch(roleOf(text, false), /Fixes </);
  assert.match(roleOf(text, true), /`Fixes <KEY>`/);
  assert.doesNotMatch(roleOf(text, true), /Closes #/);
});
