// #133 G2, at the real boundary: `bin/factory-ledger --rows` sends GitHub a GraphQL query and counts the merge it gets back.
// A fake gh answers the merge's actor only when the query asks for it (`MergedEvent{… actor{login}}`), as GitHub does, so a
// query that stops asking turns every merge by the agents' login into a touch by the Human again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const GH = `#!/bin/sh
case "$*" in
  *"api --paginate --slurp repos/o/app/issues"*) echo '[[]]' ;;
  *"api --paginate --slurp repos/o/app/pulls"*) echo '[[{"number":5,"created_at":"2026-10-20T10:00:00Z","closed_at":"2026-10-20T11:00:00Z"}]]' ;;
  *"api graphql"*)
    if echo "$*" | grep -Eq 'MergedEvent[{][^}]*actor[{]login[}]'; then cat "$FAKE/asked.json"; else cat "$FAKE/unasked.json"; fi ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

const pr = (actor) => ({
  data: {
    repository: {
      pullRequest: {
        number: 5,
        title: 'Add a line',
        url: 'https://github.com/o/app/pull/5',
        body: '',
        author: { login: 'tuan9288-agent' },
        createdAt: '2026-10-20T10:00:00Z',
        mergedAt: '2026-10-20T11:00:00Z',
        state: 'MERGED',
        headRefName: 'team-x/1-line',
        headRefOid: 'a'.repeat(40),
        mergeCommit: { oid: 'b'.repeat(40) },
        comments: { nodes: [] },
        closingIssuesReferences: { nodes: [] },
        labels: { nodes: [] },
        reviews: { nodes: [] },
        // No auto-merge event: the coordinator merged it by hand, under the agents' login.
        timelineItems: { nodes: [{ __typename: 'MergedEvent', createdAt: '2026-10-20T11:00:00Z', ...(actor ? { actor: { login: actor } } : {}) }] },
        commits: { nodes: [] },
      },
    },
  },
});

function rows(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-actor-'));
  try {
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'root'));
    mkdirSync(join(dir, 'profiles'));
    writeFileSync(join(dir, 'bin/gh'), GH);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    writeFileSync(join(dir, 'asked.json'), JSON.stringify(pr('tuan9288-agent')));
    writeFileSync(join(dir, 'unasked.json'), JSON.stringify(pr(null)));
    const r = run(dir, join(factory, 'bin/factory-ledger'), ['--rows', '--repo', 'o/app', '--since', '2026-10-01', '--until', '2026-10-31'], {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      FAKE: dir,
      FACTORY_ROOT: join(dir, 'root'),
      AGENT_PROFILES: join(dir, 'profiles'),
      FACTORY_STATE: join(dir, 'state'),
      ...extraEnv,
    });
    assert.equal(r.code, 0, r.out);
    const [head, row] = r.out.trim().split('\n').map((l) => l.split('\t'));
    return Object.fromEntries(head.map((name, i) => [name, row[i]]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a merge by the agents\' login without auto-merge is a team merge in the rows, because the query asks who merged', () => {
  const row = rows();
  assert.equal(row.state, 'landed');
  assert.equal(row.human_touched, 'false');
  assert.equal(row.why, '');
});

test('the same merge by the Human\'s login is a touch', () => {
  const row = rows({ FACTORY_HUMAN: 'tuan9288-agent' });
  assert.equal(row.human_touched, 'true');
  assert.equal(row.why, 'manual merge');
});
