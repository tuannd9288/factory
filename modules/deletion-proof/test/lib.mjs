// What the deletion-proof module's tests share: a repository with the module on, its knip config protected, and a fake npx
// standing in for knip. No test here reaches the network, npm or the real knip.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repoWithKit, script } from '../../../test/helpers.mjs';

export const entry = (file, found = {}) => ({ file, files: [], exports: [], types: [], dependencies: [], ...found });
export const report = (...entries) => JSON.stringify({ issues: entries });
export const ex = (file, ...names) => entry(file, { exports: names.map((name, i) => ({ name, line: 1 + i, col: 1, pos: i })) });
export const fl = (file) => entry(file, { files: [{ name: file }] });

export const PREPARE = '\ngate_prepare() { touch "$1/.prepared"; }\n';

/** A repository whose main has the module on, a JSON knip config that .gate/protected names, and a gate_prepare that marks
 * the checkout it prepared. `dir` also holds a fake npx: it logs where it ran and prints the file FAKE_KNIP_REPORT. */
export function moduleRepo(extra = {}) {
  const r = repoWithKit({ 'knip.json': '{}\n', ...extra }, ['--module', 'deletion-proof']);
  git(r.repo, 'switch', '-q', 'main');
  commit(
    r.repo,
    {
      '.gate/protected': `${readFileSync(join(r.repo, '.gate/protected'), 'utf8')}knip.json\n`,
      '.gate/config.sh': `${readFileSync(join(r.repo, '.gate/config.sh'), 'utf8')}${PREPARE}`,
    },
    'protect knip.json',
  );
  git(r.repo, 'push', '-q', 'origin', 'main');
  git(r.repo, 'switch', '-q', 'work');
  const bin = join(r.dir, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npx'),
    [
      '#!/bin/sh',
      // Where it runs, whether that folder is empty, and the folder knip is told to look at (--directory), with its commit and mark.
      'dir=; prev=; for a in "$@"; do [ "$prev" = --directory ] && dir=$a; prev=$a; done',
      'echo "pwd=$(pwd -P) empty=$([ -z "$(ls -A)" ] && echo yes || echo no) dir=$dir head=$(git -C "$dir" rev-parse HEAD 2>/dev/null) prepared=$([ -f "$dir/.prepared" ] && echo yes || echo no) args=$*" >>"$FAKE_NPX_LOG"',
      'cat "$FAKE_KNIP_REPORT"',
      'exit "${FAKE_KNIP_EXIT:-1}"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'npx'), 0o755);
  const log = join(r.dir, 'npx.log');
  const env = (knip, more = {}) => {
    writeFileSync(join(r.dir, 'report.json'), knip ?? report());
    return { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_LOG: log, FAKE_KNIP_REPORT: join(r.dir, 'report.json'), ...more };
  };
  let n = 0;
  /** Commits `base` and then `head` on a branch off main and runs red-check against the base, with the fake knip printing
   * `knip`. `body` is the pull request body. */
  const attempt = ({ base = {}, head = {}, knip, body, symlink, link, more = {}, args = [] }) => {
    n += 1;
    git(r.repo, 'switch', '-q', '-C', `case${n}`, 'origin/main');
    commit(r.repo, base, `base ${n}`);
    if (link) {
      // A link in the base itself: [target, path].
      git(r.repo, 'rm', '-q', '-f', '--ignore-unmatch', link[1]);
      symlinkSync(link[0], join(r.repo, link[1]));
      commit(r.repo, {}, `base link ${n}`);
    }
    const sha = git(r.repo, 'rev-parse', 'HEAD');
    if (symlink) {
      git(r.repo, 'rm', '-q', symlink[1]);
      symlinkSync(symlink[0], join(r.repo, symlink[1]));
    }
    commit(r.repo, head, `head ${n}`);
    const options = ['--base', sha, ...args];
    if (body !== undefined) {
      writeFileSync(join(r.dir, 'body.txt'), body);
      options.push('--body', join(r.dir, 'body.txt'));
    }
    return { ...script(r.repo, 'red-check', options, env(knip, more)), base: sha };
  };
  return { ...r, attempt, env, log, bin };
}
