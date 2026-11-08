// FAC-85: bin/lib/repos.mjs owns a repository's identity; githubRepo is the one parser of an origin URL that the seats, the ledger,
// the merge queue, Colly's status and the Codex step read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRepo } from '../bin/lib/repos.mjs';

test('githubRepo reads owner/name from every shape of a GitHub origin, and nothing from another host or a path that is not owner/name', () => {
  for (const url of [
    'https://github.com/o/app', 'https://github.com/o/app.git', 'https://github.com/o/app/', 'https://github.com/o/app.git/',
    'ssh://git@github.com/o/app', 'ssh://git@github.com/o/app.git', 'git@github.com:o/app', 'git@github.com:o/app.git',
    'https://agent@github.com/o/app.git', 'http://github.com/o/app', 'git://github.com/o/app.git', 'https://github.com/o/app\n',
  ]) assert.equal(githubRepo(url), 'o/app', url);
  assert.equal(githubRepo('git@github.com:Org-1/my.repo_2.git'), 'Org-1/my.repo_2');
  assert.equal(githubRepo('https://github.com/o/user.github.io'), 'o/user.github.io');
  for (const url of [
    'https://evilgithub.com/o/app', 'git@evilgithub.com:o/app', 'https://github.com.evil.com/o/app', 'https://gitlab.com/o/app',
    'https://github.com/justone', 'https://github.com/o/app/extra', 'ssh://git@github.com:22/o/app', '', null, undefined,
  ]) assert.equal(githubRepo(url), null, String(url));
});
