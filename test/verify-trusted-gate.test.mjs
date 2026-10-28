// verify-trusted and the Gate block (#132): main's code reads the candidate's instruction files as git objects, before
// main's protected files are laid over them, and tells an ordinary pull request from a kit update. An ordinary one leaves
// the block, .gate/gate-section.md and .gate/kit-commit as the base has them. An update changes them, and only the
// public factory's main can vouch for the new bytes: the commit it names must be on that main, and its
// kit/.gate/gate-section.md must be the candidate's block. No test uses the network: the factory is a local bare repository.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repoWithKit, run } from './helpers.mjs';

const lib = () => import('../kit/.gate/bin/lib/instructions.mjs');
const HEX = (c) => c.repeat(40);

describe('verify-trusted reads the candidate\'s Gate block as objects', () => {
  let r;
  let trusted;
  let factory;
  let baseSha;
  let S1;
  let S2;
  let FORGED;
  let F1;
  let F2;
  let SIDE;
  let agents;

  before(() => {
    r = repoWithKit();
    S1 = readFileSync(join(r.repo, '.gate/gate-section.md'), 'utf8');
    S2 = S1.replace('gate-section-v1', 'gate-section-v2');
    FORGED = S1.replace('gate-section-v1', 'gate-section-forged');
    // The factory: main holds the kit's block (F1) and a later one (F2); a side branch, not on main, holds the forged one.
    const w = join(r.dir, 'facw');
    mkdirSync(w);
    git(w, 'init', '-q', '-b', 'main');
    F1 = commit(w, { 'kit/.gate/gate-section.md': S1 }, 'kit one');
    F2 = commit(w, { 'kit/.gate/gate-section.md': S2 }, 'kit two');
    git(w, 'switch', '-q', '-c', 'side', F1);
    SIDE = commit(w, { 'kit/.gate/gate-section.md': FORGED }, 'a side branch');
    git(w, 'switch', '-q', 'main');
    git(r.dir, 'clone', '-q', '--bare', w, join(r.dir, 'fac.git'));
    factory = join(r.dir, 'fac.git');
    // The base: the kit as onboarded, with the factory commit it was laid from.
    git(r.repo, 'switch', '-q', 'main');
    commit(r.repo, { '.gate/kit-commit': `${F1}\n` }, 'record the kit commit');
    git(r.repo, 'push', '-q', 'origin', 'main');
    baseSha = git(r.repo, 'rev-parse', 'HEAD');
    agents = readFileSync(join(r.repo, 'AGENTS.md'), 'utf8');
    trusted = join(r.dir, 'trusted');
    git(r.dir, 'clone', '-q', join(r.dir, 'app.git'), trusted);
  });
  after(() => r.cleanup());

  const objects = (base = baseSha, env = {}) =>
    run(trusted, process.execPath, [join(trusted, '.gate/bin/lib/instructions.mjs'), 'objects', '--repo', r.repo, '--base', base], { GATE_FACTORY_URL: factory, ...env });
  /** A candidate: a commit on `from` (default the base) that writes `files`; the working tree is left as committed. */
  const candidate = (files, from = baseSha) => {
    git(r.repo, 'reset', '-q', '--hard');
    git(r.repo, 'switch', '-q', '-C', 'c', from);
    return commit(r.repo, files, 'candidate');
  };
  const update = async (to, key, extra = {}) => {
    const { replaceGate } = await lib();
    return { 'AGENTS.md': replaceGate(agents, to), '.gate/gate-section.md': to, '.gate/kit-commit': key, ...extra };
  };
  const green = (out) => assert.equal(out.code, 0, out.out);
  const red = (out, why) => {
    assert.equal(out.code, 1, out.out);
    if (why) assert.match(out.out, why);
  };

  test('an ordinary pull request that edits only the tail passes, the block and its file as the base has them', () => {
    candidate({ 'AGENTS.md': `${agents}\n## The repository's own\n\nA fact the code cannot tell.\n` });
    green(objects());
  });

  test('an ordinary pull request that edits the block and .gate/gate-section.md together is red, whatever kit commit it names', async () => {
    const pair = async (key) => update(FORGED, key);
    // The forged pair is consistent in the candidate's own files, so a check that read the working tree against the
    // candidate's own copy would pass it. Each variant names a different way to vouch for it.
    candidate(await pair(`${F1}\n`));
    red(objects(), /factory/);
    candidate(await pair(`${HEX('b')}\n`));
    red(objects(), /not on the factory's main/);
    candidate(await pair(`${F2}\n`));
    red(objects(), /not the kit's/);
    candidate(await pair(`${SIDE}\n`));
    red(objects(), /not on the factory's main/);
  });

  test('a kit update with the tail unchanged passes: the new block, its file and the commit come from one factory commit', async () => {
    candidate(await update(S2, `${F2}\n`));
    green(objects());
  });

  test('the same update with one byte of the tail changed is red', async () => {
    candidate(await update(S2, `${F2}\n`, { 'AGENTS.md': `${(await lib()).replaceGate(agents, S2)}x` }));
    red(objects(), /tail/);
  });

  test('the same update with CLAUDE.md changed is red', async () => {
    candidate(await update(S2, `${F2}\n`, { 'CLAUDE.md': '@AGENTS.md\n\nA new addendum.\n' }));
    red(objects(), /CLAUDE\.md/);
  });

  test('an update that names a commit the file does not match, a malformed commit line or no commit is red', async () => {
    candidate(await update(S2, `${F1}\n`));
    red(objects(), /not the kit's/);
    candidate(await update(S2, `${F2}`));
    red(objects(), /\.gate\/kit-commit/);
    candidate(await update(S2, `${F2.toUpperCase()}\n`));
    red(objects(), /\.gate\/kit-commit/);
    candidate({ ...(await update(S2, `${F2}\n`)), '.gate/kit-commit': null });
    red(objects(), /\.gate\/kit-commit/);
  });

  test('an update may not go back: a commit older than the base\'s is red', async () => {
    const newer = candidate(await update(S2, `${F2}\n`));
    candidate(await update(S1, `${F1}\n`), newer);
    red(objects(newer), /older|back/);
  });

  test('a factory that cannot be fetched is red, never a pass', async () => {
    candidate(await update(S2, `${F2}\n`));
    red(objects(baseSha, { GATE_FACTORY_URL: join(r.dir, 'nowhere.git') }), /could not fetch/);
  });

  test('a block taken out, or an AGENTS.md over the limit, is red on the ordinary path too', () => {
    candidate({ 'AGENTS.md': '# app\n\nno block here\n' });
    red(objects(), /no Gate block/);
    candidate({ 'AGENTS.md': `${agents}${'x\n'.repeat(150)}` });
    red(objects(), /lines \(at most 150\)/);
  });

  test('reads the commit, not the checkout: a forged commit passes nothing for a clean working tree, a good one for a dirty one', async () => {
    candidate(await update(FORGED, `${HEX('b')}\n`));
    // The checkout is put back to the base's files after the commit. A reader of the working tree sees a good tree.
    git(r.repo, 'restore', '--worktree', '--source', baseSha, '--', 'AGENTS.md', '.gate/gate-section.md', '.gate/kit-commit');
    red(objects(), /not on the factory's main/);
    candidate(await update(S2, `${F2}\n`));
    writeFileSync(join(r.repo, 'AGENTS.md'), 'garbage, uncommitted\n');
    writeFileSync(join(r.repo, 'CLAUDE.md'), 'garbage\n');
    rmSync(join(r.repo, '.gate/bin/tier'));
    green(objects());
    git(r.repo, 'checkout', '-q', '--', '.');
  });

  test('a base with no .gate/gate-section.md cannot be judged and is red', () => {
    git(r.repo, 'reset', '-q', '--hard');
    git(r.repo, 'switch', '-q', '-C', 'bare', baseSha);
    const without = commit(r.repo, { '.gate/gate-section.md': null }, 'a base without the block file');
    candidate({ 'src/more.js': 'export const more = 1;\n' }, without);
    red(objects(without), /base/);
  });

  describe('end to end', () => {
    const verifyTrusted = (env = {}) => run(trusted, join(trusted, '.gate/bin/verify-trusted'), [r.repo, baseSha], { GATE_FACTORY_URL: factory, ...env });

    test('a forged pair is red at verify-trusted, with main\'s other checks still run', async () => {
      candidate(await update(FORGED, `${HEX('b')}\n`));
      const out = verifyTrusted();
      red(out, /verify-trusted: the candidate's instruction files/);
    });

    test('a kit update with the tail unchanged passes verify-trusted', async () => {
      candidate(await update(S2, `${F2}\n`));
      const out = verifyTrusted();
      green(out);
      assert.match(out.out, /main's verify and red-check pass on the candidate/);
    });
  });
});
