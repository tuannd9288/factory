// The pstack pack's own checks (moved from test/kit.test.mjs): its pin, and the points where pstack yields to the gate.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from '../../../test/helpers.mjs';

describe('the pstack pin', () => {
  const settings = JSON.parse(readFileSync(join(factory, 'packs/pstack/settings.json'), 'utf8'));

  test('pins pstack at one full commit, under a marketplace named for it, enabled for the project only', () => {
    const names = Object.keys(settings.extraKnownMarketplaces ?? {});
    assert.equal(names.length, 1, 'one pin');
    const [name] = names;
    const { source } = settings.extraKnownMarketplaces[name];
    assert.equal(source.source, 'settings');
    assert.equal(source.name, name);
    assert.equal(source.plugins.length, 1);
    const [plugin] = source.plugins;
    assert.equal(plugin.name, 'pstack');
    assert.equal(plugin.source.source, 'git-subdir');
    assert.equal(plugin.source.path, 'pstack');
    assert.match(plugin.source.url, /^(https:\/\/github\.com\/)?cursor\/plugins(\.git)?$/);
    assert.match(plugin.source.sha, /^[0-9a-f]{40}$/);
    assert.equal(plugin.source.ref, undefined, 'a branch or tag would move');
    // One marketplace name per pin: two repositories pinning two commits never share one record in a profile.
    assert.equal(name, `pstack-${plugin.source.sha.slice(0, 7)}`);
    assert.deepEqual(settings.enabledPlugins, { [`pstack@${name}`]: true });
  });

  test('AGENTS.md installs the pack\'s pin at project scope, never at user scope', () => {
    const [name] = Object.keys(settings.extraKnownMarketplaces ?? {});
    const installs = [...readFileSync(join(factory, 'AGENTS.md'), 'utf8').matchAll(/`(claude plugin install [^`]*)`/g)].map((m) => m[1]);
    assert.ok(installs.length, 'AGENTS.md gives no install command');
    for (const line of installs) assert.equal(line, `claude plugin install pstack@${name} --scope project`);
  });
});

describe('the pstack pack\'s AGENTS.md', () => {
  const text = () => readFileSync(join(factory, 'packs/pstack/AGENTS.md'), 'utf8');

  test('says that no point is left where pstack yields: the kit says each rule once, so the section lists none', () => {
    // The pack's file is the section alone: it runs from its heading to its end.
    const section = text().startsWith('## Where pstack yields\n') ? text().slice('## Where pstack yields\n'.length) : '';
    assert.doesNotMatch(section, /^## /m);
    assert.equal(section.split('\n- ').length - 1, 0, section);
    assert.match(section, /No point\s+is left where they yield/);
  });
});
