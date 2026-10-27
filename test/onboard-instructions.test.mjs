// bin/onboard and the instruction files (#132): the repository keeps its own AGENTS.md and CLAUDE.md, and the kit puts
// one marked Gate block at the start of AGENTS.md. A file that cannot take it (over 150 lines or 32 KiB, malformed
// markers, CRLF, a CLAUDE.md that does not reach AGENTS.md) is refused: the clone is removed and nothing of the
// repository's is written. The rulebooks are invented, at the sizes of five product rulebooks.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, git, quiet, run } from './helpers.mjs';
import { EXECUTABLE, OWN_VERIFY, PRE_COMMIT, PRE_PUSH, SIZE, seeded } from './seed-world.mjs';
import { FIVE, carrierOf, rulebook } from './instruction-fixtures.mjs';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const SECTION = readFileSync(join(factory, 'kit/.gate/gate-section.md'), 'utf8');

/** A seeded repository with this AGENTS.md and carrier (text or a link), onboarded without --own. */
function world(agents, carrier = { text: '@AGENTS.md\n' }, files = {}) {
  const claude = carrier === null ? { 'CLAUDE.md': null } : carrier.link !== undefined ? { 'CLAUDE.md': null } : { 'CLAUDE.md': carrier.text };
  return seeded({ 'AGENTS.md': agents, ...claude, ...files }, { own: false, links: carrier?.link !== undefined ? { 'CLAUDE.md': carrier.link } : {} });
}
/** The exact bytes of a path on factory/kit, and its mode; null when absent. */
const blob = (s, path) => run(s.repo, 'git', ['show', `factory/kit:${path}`], quiet).out;
const modeOf = (s, path, rev = 'factory/kit') => git(s.repo, 'ls-tree', rev, '--', path).split(' ')[0] || null;

describe('bin/onboard composes the instruction files', () => {
  test('puts the block at the start of four of the five invented rulebooks and keeps each carrier as it was', async () => {
    const { insertGate } = await lib();
    for (const key of ['A', 'B', 'C', 'E']) {
      const text = rulebook(FIVE[key]);
      const carrier = carrierOf(FIVE[key].carrier);
      const s = world(text, carrier);
      try {
        const out = s.onboard();
        assert.equal(out.code, 0, `${key}: ${out.out}`);
        assert.equal(blob(s, 'AGENTS.md'), insertGate(text, SECTION), key);
        assert.equal(blob(s, 'CLAUDE.md'), carrier.text, key);
        assert.equal(modeOf(s, 'CLAUDE.md'), '100644');
        assert.equal(blob(s, '.gate/gate-section.md'), SECTION);
      } finally {
        s.cleanup();
      }
    }
  });

  test('keeps a CLAUDE.md that is a symlink as a symlink, with its target', async () => {
    const t = world(rulebook(FIVE.E), { link: 'AGENTS.md' });
    try {
      const out = t.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(modeOf(t, 'CLAUDE.md'), '120000');
      assert.equal(blob(t, 'CLAUDE.md'), 'AGENTS.md');
    } finally {
      t.cleanup();
    }
  });

  test('after onboard, the seeded files and their modes are as they were but the three named changes', async () => {
    const s = world(rulebook(FIVE.E));
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      const seededPaths = ['scripts/verify', 'scripts/size.mjs', '.githooks/pre-commit', '.githooks/pre-push', 'package.json', 'src/math.js', 'test/math.test.js', 'README.md', 'CLAUDE.md'];
      assert.equal(git(s.repo, 'diff', '--name-only', 'main', 'factory/kit', '--', ...seededPaths), '');
      for (const path of seededPaths) assert.equal(modeOf(s, path, 'main'), modeOf(s, path), path);
      assert.equal(blob(s, 'scripts/verify'), OWN_VERIFY);
      assert.equal(blob(s, 'scripts/size.mjs'), SIZE);
      assert.equal(blob(s, '.githooks/pre-commit'), PRE_COMMIT);
      assert.equal(blob(s, '.githooks/pre-push'), PRE_PUSH);
      for (const path of EXECUTABLE) assert.equal(modeOf(s, path), '100755', path);
      // The three changes: the Gate block in AGENTS.md, the kit's deny lines in settings.json, the hook folded into config.sh.
      assert.equal(git(s.repo, 'diff', '--name-only', 'main', 'factory/kit', '--', 'AGENTS.md', '.claude/settings.json'), '.claude/settings.json\nAGENTS.md');
      assert.match(blob(s, '.gate/config.sh'), /gate_fast\(\) \{ \.githooks\/pre-commit; \}/);
    } finally {
      s.cleanup();
    }
  });

  test('refuses the 384-line rulebook with its lines and bytes, removes the clone, and leaves the --own file as it was', async () => {
    const s = world(rulebook(FIVE.E), { text: '@AGENTS.md\n' });
    try {
      const own = rulebook(FIVE.D);
      writeFileSync(join(s.dir, 'big.md'), own);
      const out = s.onboard('--own', join(s.dir, 'big.md'));
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /AGENTS\.md has \d+ lines \(at most 150\) and \d+ bytes \(at most 32768\)/);
      assert.ok(!existsSync(s.repo), 'the clone is removed');
      assert.equal(readFileSync(join(s.dir, 'big.md'), 'utf8'), own);
    } finally {
      s.cleanup();
    }
  });

  test('refuses a repository AGENTS.md that is too long by lines or by bytes, with nothing of it written', async () => {
    const { countLines } = await lib();
    const head = `${SECTION}\n`;
    const room = 150 - countLines(head) - 1;
    for (const [text, why] of [[`# app\n${'x\n'.repeat(room + 1)}`, /\(at most 150\)/], [`${'a'.repeat(32768)}\n`, /\(at most 32768\)/]]) {
      const s = world(text);
      try {
        const out = s.onboard();
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, why);
        assert.ok(!existsSync(s.repo));
      } finally {
        s.cleanup();
      }
    }
  });

  test('--own takes a complete repository-prepared file, in place of the clone\'s AGENTS.md, and puts the block in it', async () => {
    const { insertGate } = await lib();
    const s = world('# app\n\nthe clone\'s own\n');
    try {
      const prepared = rulebook(FIVE.C);
      writeFileSync(join(s.dir, 'prepared.md'), prepared);
      const out = s.onboard('--own', join(s.dir, 'prepared.md'));
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, 'AGENTS.md'), insertGate(prepared, SECTION));
      assert.equal(readFileSync(join(s.dir, 'prepared.md'), 'utf8'), prepared);
    } finally {
      s.cleanup();
    }
  });

  test('a file that already starts with exactly the block gets no second one', async () => {
    const { insertGate } = await lib();
    const done = insertGate('# app\n\nrules\n', SECTION);
    const s = world(done);
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, 'AGENTS.md'), done);
    } finally {
      s.cleanup();
    }
  });

  test('refuses malformed markers, two blocks, a changed block and CRLF, and removes the clone', async () => {
    const { insertGate } = await lib();
    const good = insertGate('# app\n\nrules\n', SECTION);
    const cases = [
      good.replace('<!-- factory:gate:end -->\n', ''),
      `${good}\n${SECTION}`,
      good.replace('issue labelled `task`', 'issue labelled `chore`'),
      '# app\r\n\r\nrules\r\n',
    ];
    for (const text of cases) {
      const s = world(text);
      try {
        const out = s.onboard();
        assert.equal(out.code, 2, out.out);
        assert.ok(!existsSync(s.repo));
      } finally {
        s.cleanup();
      }
    }
  });

  test('without an AGENTS.md it writes a title and the block; without a CLAUDE.md, the import', async () => {
    const s = world(null, null);
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, 'AGENTS.md'), `# app\n\n${SECTION}`);
      assert.equal(blob(s, 'CLAUDE.md'), '@AGENTS.md\n');
      assert.equal(modeOf(s, 'CLAUDE.md'), '100644');
    } finally {
      s.cleanup();
    }
  });

  test('refuses a CLAUDE.md that does not reach AGENTS.md, and changes nothing', async () => {
    for (const carrier of [{ text: 'AGENTS.md\n' }, { link: '/etc/AGENTS.md' }, { link: '../AGENTS.md' }, { link: 'CLAUDE.md' }]) {
      const s = world(rulebook(FIVE.E), carrier);
      try {
        const out = s.onboard();
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, /CLAUDE\.md/);
        assert.ok(!existsSync(s.repo));
      } finally {
        s.cleanup();
      }
    }
  });

  test('a minimal repository with neither ARCHITECTURE.md nor docs/ is taken in', async () => {
    const s = world('# app\n');
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, 'AGENTS.md'), `# app\n\n${SECTION}`);
      assert.equal(modeOf(s, 'ARCHITECTURE.md'), null);
      assert.equal(modeOf(s, 'docs'), null);
    } finally {
      s.cleanup();
    }
  });

  test('a repository with no .claude/settings.json gets the kit\'s deny lines as the kit has them, with no pstack pin', async () => {
    const s = world(rulebook(FIVE.E), undefined, { '.claude/settings.json': null });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, '.claude/settings.json'), readFileSync(join(factory, 'kit/.claude/settings.json'), 'utf8'));
      assert.doesNotMatch(blob(s, '.claude/settings.json'), /pstack/);
    } finally {
      s.cleanup();
    }
  });

  test('a repository that has a pin keeps its bytes, the kit\'s deny lines apart', async () => {
    const s = world(rulebook(FIVE.E));
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.match(blob(s, '.claude/settings.json'), /"pstack@parcel-notes": true/);
    } finally {
      s.cleanup();
    }
  });

  test('records the factory commit in .gate/kit-commit and no pack: the inventory lists neither AGENTS.md, CLAUDE.md nor .gate/pack', async () => {
    const s = world(rulebook(FIVE.E));
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, '.gate/kit-commit'), `${git(factory, 'rev-parse', 'HEAD')}\n`);
      const inventory = blob(s, '.gate/kit-files').split('\n');
      for (const path of ['AGENTS.md', 'CLAUDE.md', '.gate/pack']) assert.ok(!inventory.includes(path), path);
      assert.ok(inventory.includes('.gate/kit-commit') && inventory.includes('.gate/gate-section.md'));
      assert.equal(modeOf(s, '.gate/pack'), null);
    } finally {
      s.cleanup();
    }
  });

  test('--pack is not an argument any more, and nothing is done', async () => {
    const s = world(rulebook(FIVE.E));
    try {
      const out = s.onboard('--pack', 'pstack');
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /unknown argument --pack/);
      assert.ok(!existsSync(s.repo));
    } finally {
      s.cleanup();
    }
  });
});
