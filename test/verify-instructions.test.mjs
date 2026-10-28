// .gate/bin/verify --only instructions (#132): the working tree's AGENTS.md and CLAUDE.md against the kit's Gate block,
// the 150-line and 32 KiB limits, the carrier and the kit files the block names. The rulebooks are invented, at the sizes
// of the five product repositories.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoWithKit, script } from './helpers.mjs';
import { FIVE, carrierOf, rulebook } from './instruction-fixtures.mjs';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');

describe('verify --only instructions', () => {
  let r;
  let section;
  before(() => {
    r = repoWithKit();
    section = readFileSync(join(r.repo, '.gate/gate-section.md'), 'utf8');
  });
  after(() => r.cleanup());

  const at = (path) => join(r.repo, path);
  /** Sets AGENTS.md and CLAUDE.md ({ text } or { link }), whatever was there; null drops CLAUDE.md. */
  const put = (agents, claude = { text: '@AGENTS.md\n' }) => {
    for (const path of ['AGENTS.md', 'CLAUDE.md']) rmSync(at(path), { recursive: true, force: true });
    writeFileSync(at('AGENTS.md'), agents);
    if (claude?.link !== undefined) symlinkSync(claude.link, at('CLAUDE.md'));
    else if (claude?.dir) mkdirSync(at('CLAUDE.md'));
    else if (claude) writeFileSync(at('CLAUDE.md'), claude.text);
  };
  const check = () => script(r.repo, 'verify', ['--only', 'instructions']);
  const green = (out) => assert.equal(out.code, 0, out.out);
  const red = (out, why) => {
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /verify: instructions failed/);
    if (why) assert.match(out.out, why);
  };
  const composed = async (rulebookText) => (await lib()).insertGate(rulebookText, section);

  test('passes four of the five invented rulebooks with the block put in, each with its own carrier', async () => {
    for (const key of ['A', 'B', 'C', 'E']) {
      put(await composed(rulebook(FIVE[key])), carrierOf(FIVE[key].carrier));
      green(check());
    }
  });

  test('refuses the 384-line rulebook with the lines and bytes it would have, and does not touch it', async () => {
    const text = await composed(rulebook(FIVE.D));
    put(text, carrierOf('symlink'));
    red(check(), /AGENTS\.md has \d+ lines \(at most 150\) and \d+ bytes \(at most 32768\)/);
    assert.equal(readFileSync(at('AGENTS.md'), 'utf8'), text);
  });

  test('accepts a relative symlink as the carrier', async () => {
    put(await composed(rulebook(FIVE.A)), { link: 'AGENTS.md' });
    green(check());
    put(await composed(rulebook(FIVE.A)), { link: './AGENTS.md' });
    green(check());
  });

  test('a minimal repository with neither ARCHITECTURE.md nor docs/ passes', async () => {
    put(await composed('# app\n'));
    assert.ok(!existsSync(at('ARCHITECTURE.md')) && !existsSync(at('docs')));
    green(check());
  });

  test('the limits are 150 lines and 32768 bytes, not one fewer', async () => {
    const { countLines } = await lib();
    const head = `${section}\n`;
    const lines = (n) => head + 'x\n'.repeat(n - countLines(head));
    put(lines(150));
    green(check());
    put(lines(151));
    red(check(), /151 lines \(at most 150\)/);
    const bytes = (n) => `${head}${'a'.repeat(n - Buffer.byteLength(head) - 1)}\n`;
    put(bytes(32768));
    green(check());
    put(bytes(32769));
    red(check(), /32769 bytes \(at most 32768\)/);
  });

  test('a missing, malformed, duplicate, misplaced or altered block is red', async () => {
    const good = await composed(rulebook(FIVE.E));
    put('# app\n\nrules only\n');
    red(check(), /no Gate block/);
    put(good.replace('<!-- factory:gate:end -->\n', ''));
    red(check(), /malformed/);
    put(`${good}\n${section}`);
    red(check(), /more than one/);
    put(`Intro text.\n\n${good}`);
    red(check(), /not at the start/);
    put(good.replace('issue labelled `task`', 'issue labelled `chore`'));
    red(check(), /not \.gate\/gate-section\.md/);
  });

  test('the working tree is judged against its own .gate/gate-section.md; trusting that copy is verify-trusted\'s job', async () => {
    const edited = section.replace('Gate marker: gate-section-v1', 'Gate marker: forged');
    put(await (await lib()).insertGate(rulebook(FIVE.E), edited));
    writeFileSync(at('.gate/gate-section.md'), edited);
    green(check());
    writeFileSync(at('.gate/gate-section.md'), section);
    red(check(), /not \.gate\/gate-section\.md/);
  });

  test('a missing or wrong CLAUDE.md is red', async () => {
    const good = await composed(rulebook(FIVE.E));
    put(good, null);
    red(check(), /CLAUDE\.md is missing/);
    put(good, { text: 'AGENTS.md\n' });
    red(check(), /first line of CLAUDE\.md/);
    put(good, { link: '/abs/AGENTS.md' });
    red(check(), /absolute/);
    put(good, { link: '../elsewhere/AGENTS.md' });
    red(check(), /\.\./);
    put(good, { link: 'CLAUDE.md' });
    red(check(), /itself|cycle/);
    put(good, { dir: true });
    red(check(), /CLAUDE\.md/);
  });

  test('an AGENTS.md that is a link, or is missing, is red', async () => {
    const good = await composed(rulebook(FIVE.E));
    put(good);
    rmSync(at('AGENTS.md'));
    red(check(), /AGENTS\.md is missing/);
    writeFileSync(at('real.md'), good);
    symlinkSync('real.md', at('AGENTS.md'));
    red(check(), /AGENTS\.md is not a regular file/);
    rmSync(at('real.md'));
  });

  test('a kit file the block names that is gone is red, and named', async () => {
    put(await composed(rulebook(FIVE.E)));
    for (const path of ['.gate/bin/tier', '.claude/skills/gate-red/SKILL.md', '.gate/enforced-rules.md']) {
      const text = readFileSync(at(path));
      rmSync(at(path));
      red(check(), new RegExp(`${path.replace(/[./]/g, '\\$&')} is missing`));
      writeFileSync(at(path), text, { mode: path.startsWith('.gate/bin/') ? 0o755 : 0o644 });
    }
    green(check());
  });
});
