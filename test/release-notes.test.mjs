// INN-40 item 5: scripts/release-notes <tag> [file] prints the tag's own section of CHANGELOG.md, which
// .github/workflows/release.yml publishes as the version's GitHub Release, and fails when there is none. No tag, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

test('release-notes prints only the tag\'s own section, and fails for a tag with none', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const changelog = join(dir, 'CHANGELOG.md');
  writeFileSync(changelog, [
    '# Changelog', '',
    '## v1.0.10 - 2026-12-03', '', 'Tenth.', '', '- Fix: ten.', '',
    '## v1.0.1 - 2026-11-20', '', 'The first fix.', '', '- Fix: one.', '- Fix: two.', '',
    '## v1.0.0 - 2026-11-10', '', 'The first version.', '',
  ].join('\n'));
  const run = (tag) => spawnSync(join(factory, 'scripts/release-notes'), [tag, changelog], { encoding: 'utf8' });

  const one = run('v1.0.1');
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, 'The first fix.\n\n- Fix: one.\n- Fix: two.\n');

  const none = run('v2.0.0');
  assert.equal(none.status, 1);
  assert.equal(none.stdout, '');
});
