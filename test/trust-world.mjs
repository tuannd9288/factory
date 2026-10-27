// A repository with the kit, a local bare factory with some history, and the helpers to commit a candidate and run
// `instructions.mjs objects` on it (#132). The factory's main: F1 holds the block S1; a pull request branch put an
// intermediate block MID in its first commit P and S2 in its last, and was merged with a merge commit F2 (so P is reached
// only through the merge's second parent); S3 came after and a later commit F3 put S2 back. No network.
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repoWithKit, run } from './helpers.mjs';
import { replaceGate } from '../kit/.gate/bin/lib/instructions.mjs';

export function trustWorld() {
  const r = repoWithKit();
  const S1 = readFileSync(join(r.repo, '.gate/gate-section.md'), 'utf8');
  const S2 = S1.replace('gate-section-v1', 'gate-section-v2');
  const S3 = S1.replace('gate-section-v1', 'gate-section-v3');
  const MID = S1.replace('gate-section-v1', 'gate-section-intermediate');
  const w = join(r.dir, 'facw');
  mkdirSync(w);
  git(w, 'init', '-q', '-b', 'main');
  const F1 = commit(w, { 'kit/.gate/gate-section.md': S1 }, 'kit one');
  git(w, 'switch', '-q', '-c', 'pr', F1);
  const P = commit(w, { 'kit/.gate/gate-section.md': MID }, 'intermediate, rewritten before the merge');
  commit(w, { 'kit/.gate/gate-section.md': S2 }, 'final');
  git(w, 'switch', '-q', 'main');
  git(w, 'merge', '-q', '--no-ff', '-m', 'merge pr', 'pr');
  const F2 = git(w, 'rev-parse', 'HEAD');
  const R1 = commit(w, { 'kit/.gate/gate-section.md': S3 }, 'kit three, reverted later');
  const F3 = commit(w, { 'kit/.gate/gate-section.md': S2 }, 'revert kit three');
  git(r.dir, 'clone', '-q', '--bare', w, join(r.dir, 'fac.git'));
  const factory = join(r.dir, 'fac.git');
  git(r.repo, 'switch', '-q', 'main');
  commit(r.repo, { '.gate/kit-commit': `${F1}\n` }, 'record the kit commit');
  git(r.repo, 'push', '-q', 'origin', 'main');
  const baseSha = git(r.repo, 'rev-parse', 'HEAD');
  const agents = readFileSync(join(r.repo, 'AGENTS.md'), 'utf8');
  const trusted = join(r.dir, 'trusted');
  git(r.dir, 'clone', '-q', join(r.dir, 'app.git'), trusted);
  const objects = (base = baseSha, env = {}) =>
    run(trusted, process.execPath, [join(trusted, '.gate/bin/lib/instructions.mjs'), 'objects', '--repo', r.repo, '--base', base], { GATE_FACTORY_URL: factory, ...env });
  /** A commit on `from` that writes `files`, with `links` (path -> target) made first. */
  const candidate = (files, from = baseSha, links = {}) => {
    git(r.repo, 'reset', '-q', '--hard');
    git(r.repo, 'switch', '-q', '-C', 'c', from);
    for (const [path, target] of Object.entries(links)) {
      rmSync(join(r.repo, path), { force: true });
      symlinkSync(target, join(r.repo, path));
    }
    return commit(r.repo, files, 'candidate');
  };
  const update = (to, key, extra = {}) => ({ 'AGENTS.md': replaceGate(agents, to), '.gate/gate-section.md': to, '.gate/kit-commit': key, ...extra });
  return { r, trusted, factory, baseSha, S1, S2, S3, MID, F1, F2, F3, P, R1, agents, objects, candidate, update, cleanup: () => r.cleanup() };
}
