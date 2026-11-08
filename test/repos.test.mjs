// FAC-85: bin/lib/repos.mjs owns a repository's identity; githubRepo is the one parser of an origin URL that the seats, the ledger,
// the merge queue, Colly's status and the Codex step read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRepo } from '../bin/lib/repos.mjs';

test('githubRepo reads owner/name only where git reads github.com as the host, and nothing from another host or a path that is not owner/name', () => {
  for (const url of [
    'https://github.com/o/app', 'https://github.com/o/app.git', 'https://github.com/o/app/', 'https://github.com/o/app.git/',
    'ssh://git@github.com/o/app', 'ssh://git@github.com/o/app.git', 'git@github.com:o/app', 'git@github.com:o/app.git',
    'https://agent@github.com/o/app.git', 'http://github.com/o/app', 'git://github.com/o/app.git', 'deploy@github.com:o/app.git',
    'https://github.com/o/app\n', 'https://www.github.com/o/app', 'git+ssh://git@github.com/o/app.git',
  ]) assert.equal(githubRepo(url), 'o/app', url);
  assert.equal(githubRepo('git@github.com:Org-1/my.repo_2.git'), 'Org-1/my.repo_2');
  assert.equal(githubRepo('https://github.com/o/user.github.io'), 'o/user.github.io');
  for (const url of [
    'https://evilgithub.com/o/app', 'git@evilgithub.com:o/app', 'https://github.com.evil.com/o/app', 'https://gitlab.com/o/app',
    // github.com in the path, the user, the query or the fragment of another host, or after another host's scp-like colon.
    'https://evil.com/github.com/o/app', 'ssh://git@evil.com/github.com/o/app.git', 'git@evil.com:github.com/o/app', 'https://github.com@evil.com/o/app',
    'https://evil.com?@github.com/o/app', 'https://evil.com#@github.com/o/app', 'evil.com:x@github.com:o/app', 'evil::x@github.com:o/app',
    'https://evil.com\\@github.com/o/app', 'evil.com\\x@github.com:o/app',
    // Local paths to git.
    'github.com/o/app', 'x@github.com/o/app', 'file://github.com/o/app',
    // The host in another case than GitHub's, as no caller read it before.
    'https://GitHub.com/o/app', 'git@GitHub.com:o/app.git',
    'https://github.com/justone', 'https://github.com/o/app/extra', 'ssh://git@github.com:22/o/app', 'ssh://git@ssh.github.com:443/o/app.git',
    '', null, undefined,
  ]) assert.equal(githubRepo(url), null, String(url));
});
