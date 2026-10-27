// bin/kit-evidence and the instruction files (#132): AGENTS.md is the repository's own text with the kit's Gate block at
// its start, nothing else of it changed; CLAUDE.md is the repository's own and untouched, or the one-line import where it
// had none; .gate/kit-commit names the factory commit. Over git objects only, on a factory of two commits.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run, write } from './helpers.mjs';
import { FIVE, rulebook } from './instruction-fixtures.mjs';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const NEW = readFileSync(join(factory, 'kit/.gate/gate-section.md'), 'utf8');
const OLD = NEW.replace('gate-section-v1', 'gate-section-v0');
const DENY = `${JSON.stringify({ permissions: { deny: ['Read(./.env*)'] } }, null, 2)}\n`;
const KIT = { 'kit/.claude/settings.json': DENY, 'kit/.github/CODEOWNERS': '* @OWNER\n/.gate/ @OWNER\n', 'kit/.gate/config.sh': 'gate_fast() { :; }\n' };

/** A factory whose first commit holds the block OLD and whose second, `kit`, holds NEW; a repository whose main holds
 * `had`; on factory/kit, what onboard (or kit-update, with `updating`) lays, with `laid` over it. */
async function world({ had = {}, link = null, laid = {}, updating = false, aware = true } = {}) {
  const { insertGate, replaceGate } = await lib();
  const dir = mkdtempSync(join(tmpdir(), 'evidence-instr-'));
  const fac = join(dir, 'factory');
  mkdirSync(fac);
  git(fac, 'init', '-q', '-b', 'main');
  const first = commit(fac, { ...KIT, 'kit/.gate/gate-section.md': OLD }, 'kit one');
  const kit = commit(fac, { 'kit/.gate/gate-section.md': NEW }, 'kit two');
  const repo = join(dir, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const baseAgents = updating ? insertGate(had['AGENTS.md'] ?? '# app\n\nrules\n', OLD) : had['AGENTS.md'];
  write(repo, { 'README.md': '# app\n', ...had, 'AGENTS.md': baseAgents ?? null });
  if (link) symlinkSync(link, join(repo, 'CLAUDE.md'));
  if (updating) write(repo, { '.gate/gate-section.md': OLD, '.gate/kit-commit': `${first}\n`, '.gate/kit-files': '.gate/gate-section.md\n.gate/kit-commit\n.gate/kit-files\n' });
  const base = commit(repo, {}, 'start');
  git(repo, 'switch', '-q', '-c', 'factory/kit');
  const files = [...Object.keys(KIT).map((p) => p.slice(4)), '.gate/gate-section.md', '.gate/kit-commit', '.gate/kit-files'].sort();
  const agents = baseAgents == null ? `# app\n\n${NEW}` : updating ? replaceGate(baseAgents, NEW) : insertGate(baseAgents, NEW);
  write(repo, {
    'AGENTS.md': agents,
    ...(link || had['CLAUDE.md'] !== undefined ? {} : { 'CLAUDE.md': '@AGENTS.md\n' }),
    '.claude/settings.json': DENY,
    '.github/CODEOWNERS': '* @tuannd9288\n/.gate/ @tuannd9288\n',
    '.gate/config.sh': KIT['kit/.gate/config.sh'],
    '.gate/gate-section.md': NEW,
    '.gate/kit-commit': `${kit}\n`,
    '.gate/kit-files': `${files.join('\n')}\n`,
    ...laid,
  });
  const head = commit(repo, {}, 'Join the factory');
  const evidence = (flags = []) => run(dir, join(factory, 'bin/kit-evidence'), ['--factory', fac, '--commit', kit, '--repo', repo, '--base', base, '--head', 'HEAD', '--slug', 'tuannd9288/app', '--id', '1234', ...flags]);
  const change = (files2) => {
    write(repo, files2);
    return commit(repo, {}, 'change');
  };
  return { dir, repo, kit, first, base, head, evidence, change, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const using = async (options, body) => {
  const w = await world(options);
  try {
    await body(w);
  } finally {
    w.cleanup();
  }
};
const pass = (out) => assert.equal(out.code, 0, out.out) ?? assert.match(out.out, /^kit-evidence: PASS$/m);
const fail = (out, line) => {
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /^kit-evidence: FAIL$/m);
  if (line) assert.match(out.out, line);
};

describe('kit evidence: AGENTS.md', () => {
  test('passes the repository\'s own file with the kit\'s block inserted, for four of the five invented rulebooks', async () => {
    for (const key of ['A', 'B', 'C', 'E']) await using({ had: { 'AGENTS.md': rulebook(FIVE[key]) } }, (w) => pass(w.evidence()));
  });

  test('passes a repository that had no AGENTS.md: a title and the block', () => using({}, (w) => pass(w.evidence())));

  test('fails a rewritten tail, a changed head, a second block, a block that is not the kit\'s, and a missing block', async () => {
    const { insertGate } = await lib();
    const own = '# app\n\nrules\nmore rules\n';
    await using({ had: { 'AGENTS.md': own } }, (w) => {
      w.change({ 'AGENTS.md': `${insertGate(own, NEW)}one more line\n` });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(/m);
    });
    await using({ had: { 'AGENTS.md': own } }, (w) => {
      w.change({ 'AGENTS.md': insertGate(own, NEW).replace('# app', '# renamed') });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(/m);
    });
    await using({ had: { 'AGENTS.md': own } }, (w) => {
      w.change({ 'AGENTS.md': `${insertGate(own, NEW)}\n${NEW}` });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(.*duplicate/m);
    });
    await using({ had: { 'AGENTS.md': own } }, (w) => {
      w.change({ 'AGENTS.md': insertGate(own, OLD) });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(.*not the kit's/m);
    });
    await using({ had: { 'AGENTS.md': own } }, (w) => {
      w.change({ 'AGENTS.md': own });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(.*missing/m);
    });
  });

  test('fails a composed file over the limits', () =>
    using({ had: { 'AGENTS.md': '# app\n' } }, (w) => {
      w.change({ 'AGENTS.md': `# app\n\n${NEW}\n${'x\n'.repeat(150)}` });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(.*lines \(at most 150\)/m);
    }));

  test('a tail that differs from the base\'s is the repository\'s --own file: allowed with --own, shown in full, and a failure without it', async () => {
    const { insertGate } = await lib();
    await using({ had: { 'AGENTS.md': '# app\n\nthe base\n' } }, (w) => {
      w.change({ 'AGENTS.md': insertGate('# app\n\nthe prepared file\nwith two lines\n', NEW) });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(/m);
      const out = w.evidence(['--own']);
      pass(out);
      assert.match(out.out, /\| the prepared file$/m);
      assert.match(out.out, /\| with two lines$/m);
    });
  });

  test('an update replaces only the block: the head and the tail are the base\'s', async () => {
    await using({ updating: true, had: { 'AGENTS.md': '# app\n\nrules\n\nno final newline' } }, (w) => pass(w.evidence()));
    await using({ updating: true }, (w) => {
      w.change({ 'AGENTS.md': `${readFileSync(join(w.repo, 'AGENTS.md'), 'utf8')}x` });
      fail(w.evidence(), /^ {2}differs: AGENTS\.md \(/m);
    });
  });
});

describe('kit evidence: CLAUDE.md and .gate/kit-commit', () => {
  test('a repository with no CLAUDE.md gets the one-line import and nothing else', async () => {
    await using({}, (w) => pass(w.evidence()));
    await using({}, (w) => {
      w.change({ 'CLAUDE.md': '@AGENTS.md\n\nmore\n' });
      fail(w.evidence(), /^ {2}differs: CLAUDE\.md \(/m);
    });
  });

  test('a CLAUDE.md the repository had stays as it was, its addendum and its symlink mode included', async () => {
    await using({ had: { 'CLAUDE.md': '@AGENTS.md\n\nUse plan mode.\n' } }, (w) => pass(w.evidence()));
    await using({ had: { 'CLAUDE.md': '@AGENTS.md\n\nUse plan mode.\n' } }, (w) => {
      w.change({ 'CLAUDE.md': '@AGENTS.md\n' });
      fail(w.evidence(), /^ {2}differs: CLAUDE\.md \(/m);
    });
    await using({ link: 'AGENTS.md' }, (w) => pass(w.evidence()));
    await using({ link: 'AGENTS.md' }, (w) => {
      rmSync(join(w.repo, 'CLAUDE.md'));
      w.change({ 'CLAUDE.md': 'AGENTS.md' });
      fail(w.evidence(), /^ {2}differs: CLAUDE\.md \(/m);
    });
  });

  test('fails a CLAUDE.md that does not reach AGENTS.md, even one the repository had', () =>
    using({ had: { 'CLAUDE.md': 'AGENTS.md\n' } }, (w) => fail(w.evidence(), /^ {2}differs: CLAUDE\.md \(/m)));

  test('.gate/kit-commit is the factory commit and a newline; anything else, or none, fails', async () => {
    await using({}, (w) => {
      w.change({ '.gate/kit-commit': `${w.first}\n` });
      fail(w.evidence(), /^ {2}differs: \.gate\/kit-commit/m);
    });
    await using({}, (w) => {
      w.change({ '.gate/kit-commit': null });
      fail(w.evidence(), /^ {2}missing: \.gate\/kit-commit/m);
    });
  });

  test('a .gate/pack in the head is a file the kit does not lay any more', () =>
    using({}, (w) => {
      w.change({ '.gate/pack': 'pstack\n' });
      fail(w.evidence(), /^ {2}extra: \.gate\/pack/m);
    }));
});
