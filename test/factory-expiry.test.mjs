// Anthropic authentication page, captured 2026-11-06 line 295: setup-token lasts one year.
// Fixed UTC dates and made-up tokens; no real store or vendor command is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountsText } from '../bin/lib/factory.mjs';

test('account list derives expiry from the added date and warns at seven days and after expiry', () => {
  const agentProfiles = mkdtempSync(join(tmpdir(), 'factory-expiry-'));
  const tokens = join(agentProfiles, 'tokens');
  const secret = 'made-up-expiry-test-token';
  try {
    mkdirSync(tokens);
    writeFileSync(join(tokens, 'fixture'), secret, { mode: 0o600 });
    const render = (added, now) => {
      const sidecar = join(tokens, '.fixture.added');
      if (added === null) rmSync(sidecar, { force: true });
      else writeFileSync(sidecar, `${added}\n`);
      const text = accountsText([], [{ name: 'fixture', letter: 'a' }], { agentProfiles, now: Date.parse(now) }).join('\n');
      assert.ok(!text.includes(secret));
      return text;
    };
    const early = render('2026-11-06', '2027-10-29T23:59:59Z');
    assert.match(early, /added 2026-11-06; expiry 2027-11-06/);
    assert.doesNotMatch(early, /WARNING/);
    assert.match(render('2026-11-06', '2027-10-30T00:00:00Z'), /WARNING: expires within 7 days/);
    assert.match(render('2026-11-06', '2027-11-05T23:59:59Z'), /WARNING: expires within 7 days/);
    assert.match(render('2026-11-06', '2027-11-06T00:00:00Z'), /WARNING: expired/);
    assert.match(render('2026-11-06', '2027-11-07T00:00:00Z'), /WARNING: expired/);
    // A calendar year is not always 365 days; clamp a leap-day anniversary to February's last day.
    assert.match(render('2023-03-01', '2024-01-01T00:00:00Z'), /expiry 2024-03-01/);
    assert.match(render('2024-02-29', '2025-01-01T00:00:00Z'), /expiry 2025-02-28/);
    const unknown = render(null, '2027-11-07T00:00:00Z');
    assert.match(unknown, /added unknown; expiry unknown/);
    assert.doesNotMatch(unknown, /WARNING/);
  } finally { rmSync(agentProfiles, { recursive: true, force: true }); }
});
