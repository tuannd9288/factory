// packs/pstack/lead.md (#404, FAC-79): roleOf and roleFor read its markers, so they must be paired and never nested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = readFileSync(fileURLToPath(new URL('../lead.md', import.meta.url)), 'utf8');

test('the markers of lead.md are paired and never nested', () => {
  for (const form of ['github', 'linear', 'here', 'nohere']) {
    const opens = [...text.matchAll(new RegExp(`<!--${form}-->`, 'g'))].length;
    const closes = [...text.matchAll(new RegExp(`<!--/${form}-->`, 'g'))].length;
    assert.equal(opens, closes, form);
    assert.ok(opens > 0, form);
    assert.doesNotMatch(text, new RegExp(`<!--${form}-->(?:(?!<!--/${form}-->)[\\s\\S])*<!--(?:github|linear)-->`), `${form} spans nest`);
  }
});
