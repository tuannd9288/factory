import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, run, write } from './helpers.mjs';

test('the factory keeps approval across a stack parent landing, but a changed patch needs approval (#456)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-approval-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, { 'base.txt': 'base\n' });
    git(dir, 'switch', '-qc', 'parent');
    const parent = commit(dir, { 'parent.txt': 'parent\n' });
    git(dir, 'switch', '-qc', 'child');
    const approved = commit(dir, { 'child.txt': 'child\n' });
    writeFileSync(join(dir, 'owners'), '* @reviewer\n');
    writeFileSync(join(dir, 'reviews.json'), JSON.stringify([{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: approved, submitted_at: '2026-11-05T00:00:00Z' }]));
    const judge = (head, base) => run(dir, 'sh', ['-c', 'node "$1" --owners owners --author writer --head "$2" --base "$3" < reviews.json', 'sh',
      join(factory, 'kit/.gate/bin/lib/approval.mjs'), head, base]);
    git(dir, 'switch', '-q', 'main');
    git(dir, 'merge', '--no-ff', parent, '-m', 'land parent');
    const base = git(dir, 'rev-parse', 'HEAD');
    assert.equal(judge(approved, base).code, 0);
    git(dir, 'switch', '-q', 'child');
    git(dir, 'merge', '--no-ff', 'main', '-m', 'update child');
    const carried = judge(git(dir, 'rev-parse', 'HEAD'), base);
    assert.equal(carried.code, 0, carried.out);
    assert.match(carried.out, /whose patch the head carries unchanged/);
    const changed = commit(dir, { 'child.txt': 'changed\n' });
    assert.equal(judge(changed, base).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Execute the workflow's actual shell step, with GitHub replaced by a shell function.
// The checked-out parser is real; neither the GitHub CLI nor the network is used.
const workflow = readFileSync(join(factory, '.github/workflows/approval.yml'), 'utf8');
const approvalStep = workflow.split('        run: |\n')[1]
  .split('\n').map((line) => line.replace(/^          /, '')).join('\n');
const fakeGithub = `
gh() {
  case "$*" in
    'api --paginate --slurp '*) cat reviews.json ;;
    'pr view '*) [ "$DRAFT" != unreadable ] || return 1; echo "$DRAFT" ;;
    'api -X POST '*)
      echo "$*" >> requests
      case "$*" in *"=$REFUSED") echo boom >&2; return 1 ;; esac ;;
    *) echo "unexpected GitHub call: $*" >&2; return 99 ;;
  esac
}
export -f gh
`;
for (const scenario of [
  { name: 'missing approval requests each user except the author', code: 1, requests: ['reviewer', 'second'] },
  { name: 'dismissed approval requests review again', state: 'DISMISSED', code: 1, requests: ['reviewer', 'second'] },
  { name: 'approved head requests nothing', state: 'APPROVED', code: 0, requests: [] },
  { name: 'draft requests nothing', draft: 'true', code: 1, requests: [] },
  { name: 'ready pull request requests review', draft: 'false', code: 1, requests: ['reviewer', 'second'] },
  { name: 'failed request preserves the result and continues', refused: 'reviewer', code: 1, requests: ['reviewer', 'second'] },
  { name: 'unreadable draft status requests nothing', draft: 'unreadable', code: 1, requests: [] },
  { name: 'unjudgeable approval requests nothing', invalid: true, code: 2, requests: [] },
]) {
  test(`factory approval: ${scenario.name} (#374)`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-approval-step-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      const base = commit(dir, { 'base.txt': 'base\n' });
      const head = commit(dir, { 'change.txt': 'change\n' });
      write(dir, {
        '.github/CODEOWNERS': '* @reviewer @Writer @org/team\ndocs/ @second @reviewer\n',
        'kit/.gate/bin/request-owners': readFileSync(join(factory, 'kit/.gate/bin/request-owners'), 'utf8'),
        'kit/.gate/bin/lib/approval.mjs': readFileSync(join(factory, 'kit/.gate/bin/lib/approval.mjs'), 'utf8'),
        'reviews.json': scenario.invalid ? 'invalid json' : JSON.stringify(scenario.state ? [{
          user: { login: 'reviewer' }, state: scenario.state, commit_id: head, submitted_at: '2026-11-06T00:00:00Z',
        }] : []),
        requests: '',
      });
      chmodSync(join(dir, 'kit/.gate/bin/request-owners'), 0o755);
      const result = run(dir, 'bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', fakeGithub + approvalStep], {
        BASE: base, HEAD: head, PR: '7', AUTHOR: 'writer', GITHUB_REPOSITORY: 'o/factory',
        DRAFT: scenario.draft ?? 'false', REFUSED: scenario.refused ?? 'nobody',
      });
      assert.equal(result.code, scenario.code, result.out);
      assert.equal(readFileSync(join(dir, 'requests'), 'utf8'), scenario.requests.map((owner) =>
        `api -X POST repos/o/factory/pulls/7/requested_reviewers -f reviewers[]=${owner}\n`).join(''));
      if (scenario.requests.length) assert.match(result.out, /the code owner @org\/team is a team, which is not requested/);
      if (scenario.refused) {
        assert.equal(result.out.split('\n').filter((line) => line.includes('could not request')).length, 1);
        assert.match(result.out, /requested the review of second/);
        assert.doesNotMatch(result.out, /boom/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
