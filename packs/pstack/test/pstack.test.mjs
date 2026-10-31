// The pstack pack's pin (moved from test/kit.test.mjs): Claude Code reads these keys from a team's .claude/settings.json,
// where the team copies them (INSTALL.md); no kit code composes them.
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
    // Upstream's Claude Code build, not the Cursor tree at `pstack` (#182).
    assert.equal(plugin.source.path, 'harness/pstack/claude-code');
    assert.match(plugin.source.url, /^(https:\/\/github\.com\/)?cursor\/plugins(\.git)?$/);
    assert.match(plugin.source.sha, /^[0-9a-f]{40}$/);
    assert.equal(plugin.source.ref, undefined, 'a branch or tag would move');
    // One marketplace name per pin: two repositories pinning two commits never share one record in a profile.
    assert.equal(name, `pstack-${plugin.source.sha.slice(0, 7)}`);
    assert.deepEqual(settings.enabledPlugins, { [`pstack@${name}`]: true });
  });

  test('holds the pin as the installer writes it, two-space JSON in the installer\'s key order, and no permissions', () => {
    const text = readFileSync(join(factory, 'packs/pstack/settings.json'), 'utf8');
    assert.equal(text, `${JSON.stringify(settings, null, 2)}\n`);
    assert.deepEqual(Object.keys(settings), ['enabledPlugins', 'extraKnownMarketplaces', 'skillOverrides']);
  });
});
