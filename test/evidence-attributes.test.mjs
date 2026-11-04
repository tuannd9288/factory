// bin/kit-evidence and .gitattributes (#380): the review-categories block is the kit file's text at the factory commit, and
// outside it the text is the repository's own, as the base had it. Over git objects only, on a factory of two commits.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run, write } from './helpers.mjs';
import { insertBlock } from '../bin/lib/attributes.mjs';

const block = (version) => `# factory:review-categories:begin (the kit's)\nAGENTS.md review-agent-guidance\n# version ${version}\n# factory:review-categories:end (yours below)\n`;
const OLD = block(1);
const NEW = block(2);
const SECTION = '<!-- factory:gate:begin -->\n## Gate\n<!-- factory:gate:end -->\n';
const KIT = { 'kit/.gate/gate-section.md': SECTION, 'kit/.github/CODEOWNERS': '* @OWNER\n', 'kit/.gate/config.sh': 'gate_fast() { :; }\n' };

/** A factory whose second commit holds the block NEW (the first, OLD); a repository whose main holds `had` (the repository's own
 * .gitattributes, or with `updating` that text under the block OLD); on factory/kit, what onboard or kit-update lays. */
function world({ had = null, updating = false, laid = {}, kitBlock = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-attrs-'));
  const fac = join(dir, 'factory');
  mkdirSync(fac);
  git(fac, 'init', '-q', '-b', 'main');
  const first = commit(fac, { ...KIT, ...(kitBlock ? { 'kit/.gate/review-categories': OLD } : {}) }, 'kit one');
  const kit = commit(fac, kitBlock ? { 'kit/.gate/review-categories': NEW } : { 'kit/.gate/config.sh': 'gate_fast() { true; }\n' }, 'kit two');
  const repo = join(dir, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const baseText = updating ? insertBlock(had ?? '', OLD) : had;
  write(repo, { 'README.md': '# app\n', 'AGENTS.md': `# app\n\n${SECTION}`, 'CLAUDE.md': '@AGENTS.md\n', '.gitattributes': baseText });
  if (updating) write(repo, { '.gate/review-categories': OLD, '.gate/gate-section.md': SECTION, '.gate/kit-commit': `${first}\n`, '.gate/kit-files': '.gate/gate-section.md\n.gate/kit-commit\n.gate/kit-files\n.gate/review-categories\n' });
  const base = commit(repo, {}, 'start');
  git(repo, 'switch', '-q', '-c', 'factory/kit');
  const files = ['.github/CODEOWNERS', '.gate/config.sh', '.gate/gate-section.md', '.gate/kit-commit', '.gate/kit-files', ...(kitBlock ? ['.gate/review-categories'] : [])].sort();
  const text = baseText == null ? NEW : updating ? NEW + baseText.slice(OLD.length) : insertBlock(baseText, NEW);
  write(repo, {
    '.github/CODEOWNERS': '* @tuannd9288\n',
    '.gate/config.sh': kitBlock ? 'gate_fast() { :; }\n' : 'gate_fast() { true; }\n',
    '.gate/gate-section.md': SECTION,
    '.gate/kit-commit': `${kit}\n`,
    '.gate/kit-files': `${files.join('\n')}\n`,
    ...(kitBlock ? { '.gate/review-categories': NEW, '.gitattributes': text } : {}),
    ...laid,
  });
  commit(repo, {}, 'Join the factory');
  const evidence = () => run(dir, join(factory, 'bin/kit-evidence'), ['--factory', fac, '--commit', kit, '--repo', repo, '--base', base, '--head', 'HEAD', '--slug', 'tuannd9288/app', '--id', '1234']);
  const change = (files2) => {
    write(repo, files2);
    return commit(repo, {}, 'change');
  };
  return { dir, repo, evidence, change, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const using = (options, body) => {
  const w = world(options);
  try {
    body(w);
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
const own = '*.png binary\nsrc/** review-implementation\n';

describe('kit evidence: .gitattributes', () => {
  test('passes a repository with none (the block alone) and one with its own lines (the block first, the lines kept)', () => {
    using({}, (w) => pass(w.evidence()));
    using({ had: own }, (w) => pass(w.evidence()));
  });

  test('fails a head with no block, a block that is not the kit\'s, a second block and a missing file', () => {
    using({ had: own }, (w) => {
      w.change({ '.gitattributes': own });
      fail(w.evidence(), /^ {2}differs: \.gitattributes \(/m);
    });
    using({ had: own }, (w) => {
      w.change({ '.gitattributes': insertBlock(own, OLD) });
      fail(w.evidence(), /^ {2}differs: \.gitattributes \(/m);
    });
    using({ had: own }, (w) => {
      w.change({ '.gitattributes': `${NEW}\n${NEW}` });
      fail(w.evidence(), /^ {2}differs: \.gitattributes \(/m);
    });
    using({ had: own }, (w) => {
      w.change({ '.gitattributes': null });
      fail(w.evidence(), /^ {2}missing: \.gitattributes/m);
    });
  });

  test('fails the repository\'s own lines changed or dropped, with the block as the kit has it', () => {
    using({ had: own }, (w) => {
      w.change({ '.gitattributes': `${NEW}\n${own}*.jpg binary\n` });
      fail(w.evidence(), /^ {2}differs: \.gitattributes \(/m);
    });
    using({ had: own }, (w) => {
      w.change({ '.gitattributes': NEW });
      fail(w.evidence(), /^ {2}differs: \.gitattributes \(/m);
    });
  });

  test('an update replaces only the block: the head and the tail are the base\'s, and a change to either fails', () => {
    using({ updating: true, had: `${own}no final newline`.replace('\n', '\n\n') }, (w) => pass(w.evidence()));
    using({ updating: true, had: own }, (w) => {
      w.change({ '.gitattributes': `${NEW}\n${own}x` });
      fail(w.evidence(), /^ {2}differs: \.gitattributes \(/m);
    });
    // A head of blank lines, which the repository owns: the update keeps it, and one more blank line fails.
    using({ updating: true, had: own }, (w) => {
      w.change({ '.gitattributes': `\n${NEW}\n${own}` });
      fail(w.evidence(), /^ {2}differs: \.gitattributes \(/m);
    });
  });

  test('a factory commit from before the block leaves .gitattributes as the base had it', () => {
    using({ had: own, kitBlock: false }, (w) => pass(w.evidence()));
    using({ had: own, kitBlock: false }, (w) => {
      w.change({ '.gitattributes': insertBlock(own, NEW) });
      fail(w.evidence(), /^ {2}extra: \.gitattributes/m);
    });
  });
});
