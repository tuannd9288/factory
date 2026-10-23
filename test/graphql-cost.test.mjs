// The GraphQL queries of the kit's scripts stay inside GitHub's limits: at most 500,000 nodes a call, and for the
// GITHUB_TOKEN 1,000 points an hour a repository, so a query must cost few (docs.github.com, "Rate limits and query
// limits for the GraphQL API": nodes are the product of the nested first/last values, summed over the connections; a
// point is 100 requests, and one request is made for the root and for every node that has a connection below it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Nodes and points of one query text. */
export function cost(query) {
  const stack = []; // { limit, cumulative, children } for each open brace that is a connection, or null
  const connections = [];
  const open = /([A-Za-z]+)\((?:[^)]*?)\b(?:first|last):(\d+)[^)]*\)\s*\{|\{|\}/g;
  let m;
  while ((m = open.exec(query))) {
    if (m[0] === '}') {
      stack.pop();
    } else if (m[0] === '{') {
      stack.push(null);
    } else {
      const parent = [...stack].reverse().find(Boolean);
      const c = { limit: Number(m[2]), cumulative: Number(m[2]) * (parent ? parent.cumulative : 1), children: 0 };
      if (parent) parent.children += 1;
      connections.push(c);
      stack.push(c);
    }
  }
  const nodes = connections.reduce((sum, c) => sum + c.cumulative, 0);
  const requests = 1 + connections.filter((c) => c.children > 0).reduce((sum, c) => sum + c.cumulative, 0);
  return { nodes, points: Math.round(requests / 100) };
}

test('the cost of the rounds query on base is what the review computed: 102,100 nodes, 21 points', () => {
  const q = 'query{repository{pullRequest{commits(last:100){nodes{commit{checkSuites(first:20){nodes{checkRuns(first:50){nodes{name}}}}}}}}}}';
  assert.deepEqual(cost(q), { nodes: 102_100, points: 21 });
  const withAnnotations = 'query{repository{pullRequest{commits(last:100){nodes{commit{checkSuites(first:20){nodes{checkRuns(first:50){nodes{name annotations(first:10){nodes{title}}}}}}}}}}}}';
  assert.equal(cost(withAnnotations).nodes, 1_102_100);
});

test('every GraphQL query in the kit costs at most 500,000 nodes and 100 points', () => {
  const found = [];
  for (const file of ['kit/scripts/lib/history.mjs', 'kit/scripts/lib/tier.mjs', 'kit/scripts/lib/approval.mjs']) {
    let text = '';
    try {
      text = readFileSync(join(factory, file), 'utf8');
    } catch {}
    for (const m of text.matchAll(/`(query\([^`]*?)`/g)) found.push({ file, query: m[1] });
  }
  assert.ok(found.length >= 2, `found only ${found.length} queries`);
  for (const { file, query } of found) {
    const { nodes, points } = cost(query);
    assert.ok(nodes <= 500_000, `${file}: ${query.slice(0, 60)}… asks for ${nodes} nodes`);
    assert.ok(points <= 100, `${file}: ${query.slice(0, 60)}… costs ${points} points`);
  }
});
