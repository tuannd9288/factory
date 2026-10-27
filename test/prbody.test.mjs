// #133: the lines a pull request body carries (kit/.gate/bin/lib/prbody.mjs), read by verify-trusted, tier and acceptance.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const MOD = join(factory, 'kit/.gate/bin/lib/prbody.mjs');
const SHA = 'a'.repeat(40);
const load = () => import(MOD);

describe('the pull request body lines', () => {
  test('Team: takes a plain name or owner/name, and refuses a template placeholder, a space or nothing', async () => {
    const { team } = await load();
    assert.deepEqual(team('Team: team-x\n'), { ok: true, value: 'team-x' });
    assert.deepEqual(team('text\nTeam: hosted/copilot\r\n'), { ok: true, value: 'hosted/copilot' });
    assert.equal(team('Team: <your team\'s name>').ok, false);
    assert.equal(team('Team: two words').ok, false);
    assert.equal(team('Team:').ok, false);
    assert.equal(team('no line here').why, 'missing');
    assert.equal(team(undefined).why, 'missing');
  });

  test('a key written twice with two values is refused; twice with one value is that value', async () => {
    const { team } = await load();
    assert.equal(team('Team: a\nTeam: b').why, 'twice');
    assert.deepEqual(team('Team: a\nTeam: a'), { ok: true, value: 'a' });
  });

  test('Issue: is #<n> or none', async () => {
    const { issue } = await load();
    assert.deepEqual(issue('Issue: #12'), { ok: true, kind: 'number', number: 12 });
    assert.deepEqual(issue('Issue: none'), { ok: true, kind: 'none' });
    assert.equal(issue('Issue: #0').ok, false);
    assert.equal(issue('Issue: #<issue labelled task>').ok, false);
    assert.equal(issue('Closes #3').why, 'missing');
  });

  test('Claim: is 40 hex characters', async () => {
    const { claim } = await load();
    assert.deepEqual(claim(`Claim: ${SHA}`), { ok: true, sha: SHA });
    assert.equal(claim('Claim: abc123').ok, false);
    assert.equal(claim('Claim: <sha printed by .gate/bin/claim>').ok, false);
    assert.equal(claim('').why, 'missing');
  });

  test('a key is read at the start of a line only', async () => {
    const { team } = await load();
    assert.equal(team('see Team: team-x in the text').why, 'missing');
  });

  test('--team <file> exits 0 for a good body and 1 for a missing or placeholder Team:', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prbody-'));
    try {
      const body = (text) => {
        writeFileSync(join(dir, 'b'), text);
        return run(dir, process.execPath, [MOD, '--team', join(dir, 'b')]);
      };
      assert.equal(body('Team: team-x\n').code, 0);
      assert.equal(body('Closes #1\n').code, 1);
      assert.equal(body('Team: <name>\n').code, 1);
      assert.equal(run(dir, process.execPath, [MOD, '--team', join(dir, 'nofile')]).code, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
