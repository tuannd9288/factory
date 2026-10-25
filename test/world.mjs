// A copy of this factory with a repository onboarded from it, a local bare origin and a fake gh, for the tests of
// bin/kit-update and bin/kit-evidence. Nothing here touches the network or a real repository.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';

// A gh that answers what bin/kit-update may ask, as the agents' account, logs every call, and keeps the pull request body.
export const GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, a.join(' ') + '\n');
const said = (s) => { process.stdout.write(s + '\n'); process.exit(0); };
if (a[0] === 'auth' && a[1] === 'status') said(process.env.GH_LOGIN || 'tuan9288-agent');
if (a[0] === 'ruleset' && a[1] === 'check') {
  const rule = process.env.NO_RULE ? '' : '\n- pull_request: [required_approving_review_count: 0]\n  (configured in ruleset 1 from repository tuannd9288/app)\n';
  said('2 rules apply to branch main in repo tuannd9288/app\n\n- deletion\n  (configured in ruleset 1 from repository tuannd9288/app)\n' + rule);
}
if (a[0] === 'repo' && a[1] === 'view' && a.includes('nameWithOwner')) said('tuannd9288/app');
if (a[0] === 'repo' && a[1] === 'view' && a.includes('id')) said('R_kgDOtest');
if (a[0] === 'label') process.exit(0);
if (a[0] === 'pr' && a[1] === 'create') { fs.writeFileSync(process.env.PR_BODY, a[a.indexOf('--body') + 1]); fs.writeFileSync(process.env.PR_TITLE, a[a.indexOf('--title') + 1]); said('https://github.com/tuannd9288/app/pull/1'); }
process.stderr.write('fake gh: ' + a.join(' ') + '\n');
process.exit(1);
`;

/** A copy of this factory, committed with origin/main at it (plus `kit`'s files); an onboarded clone of a repository
 * whose bare origin sits beside it, merged to main and pushed. Then the tests change either side. */
export function world({ kit = {}, onboardArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-update-'));
  const fac = join(dir, 'factory');
  const tracked = git(factory, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n');
  for (const f of tracked.filter((f) => f && existsSync(join(factory, f)))) {
    mkdirSync(dirname(join(fac, f)), { recursive: true });
    copyFileSync(join(factory, f), join(fac, f));
    chmodSync(join(fac, f), statSync(join(factory, f)).mode);
  }
  write(fac, kit);
  git(fac, 'init', '-q', '-b', 'main');
  const first = commit(fac, {}, 'factory');
  git(fac, 'update-ref', 'refs/remotes/origin/main', first);
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, APP, 'start');
  const url = join(dir, 'remote/tuannd9288/app.git');
  git(dir, 'clone', '-q', '--bare', seed, url);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), GH);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  const ghLog = join(dir, 'gh.log');
  writeFileSync(ghLog, '');
  const body = join(dir, 'body.md');
  const title = join(dir, 'title.txt');
  const env = {
    ...quiet,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    GH_LOG: ghLog,
    PR_BODY: body,
    PR_TITLE: title,
    FACTORY_ROOT: join(dir, 'root'),
    AGENT_PROFILES: join(dir, 'profiles'),
    XDG_DATA_HOME: join(dir, 'xdg'),
    XDG_CONFIG_HOME: join(dir, 'xdg-config'),
  };
  mkdirSync(join(dir, 'root'));
  const onboard = run(dir, join(fac, 'bin/onboard'), [url, '--no-pr', ...onboardArgs], env);
  assert.equal(onboard.code, 0, onboard.out);
  const repo = join(dir, 'root/app');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'merge', '-q', '--ff-only', 'factory/kit');
  git(repo, 'push', '-q', 'origin', 'main');
  const repoCommit = (files, message = 'repository change') => {
    commit(repo, files, message);
    git(repo, 'push', '-q', 'origin', 'main');
  };
  const facCommit = (files, { onMain = true } = {}) => {
    const sha = commit(fac, files, 'factory change');
    if (onMain) git(fac, 'update-ref', 'refs/remotes/origin/main', sha);
    return sha;
  };
  const sha7 = () => git(fac, 'rev-parse', 'HEAD').slice(0, 7);
  const update = (args = ['app'], more = {}) => run(dir, join(fac, 'bin/kit-update'), args, { ...env, ...more });
  const calls = () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
  const state = () => ({
    branches: git(repo, 'branch', '--list'),
    head: git(repo, 'rev-parse', 'HEAD'),
    remote: git(dir, '--git-dir', url, 'for-each-ref', '--format=%(refname) %(objectname)'),
  });
  const show = (rev, path) => git(repo, 'show', `${rev}:${path}`);
  return { dir, fac, repo, url, body, title, update, repoCommit, facCommit, sha7, calls, state, show, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
