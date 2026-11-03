// The sweep's wake on comments (#351), with no gh call of its own: the queue's one GraphQL query (QUERY in bin/lib/queue.mjs) also returns the
// claim refs and the open issues updated since the repository's cursor, each with its last comments. A new comment on an issue whose claim is
// held, by someone other than the sweep's own login, writes one `comment` start line to the events (#309) and posts the wake line to the
// holder's Lead (bin/lib/wake.mjs), whose socket the Lead's hook recorded in <runs>/<folder>-<team>/socket.
// The cursor is $state/queue-<owner>-<name>.comments, { at, id } of the newest comment seen. The first sweep of a repository writes it and
// wakes nothing. Every later one asks for the issues updated at or after `at`, wakes for the comments after (at, id), and writes the cursor
// before it wakes, so a comment is never woken twice; a wake that fails is told in its line and not tried again, and the comment waits on GitHub.
// A comment makes its issue the most recently updated, so it is among the first issues the query returns. Limits: ISSUES issues of
// COMMENTS comments each in one sweep, and CLAIMS claim refs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendStart } from './events.mjs';
import { wakeLine, postSync } from './wake.mjs';

export const ISSUES = 30;
export const COMMENTS = 10;
export const CLAIMS = 100;

/** The GraphQL fields the sweep adds to its query: the claim refs, and the open issues updated since $since (all, with none) with their
 * last comments. Aliases, since `issues` is asked once already, for needs-human. */
export const FIELDS = `claims: refs(refPrefix:"refs/heads/claim/",first:${CLAIMS}){pageInfo{hasNextPage} nodes{name target{... on Commit{messageHeadline}}}}
recent: issues(states:OPEN,first:${ISSUES},orderBy:{field:UPDATED_AT,direction:DESC},filterBy:{since:$since}){nodes{number comments(last:${COMMENTS}){nodes{databaseId createdAt author{login}}}}}`;

const fileOf = (state, repo) => join(state, `queue-${repo.replace('/', '-')}.comments`);

/** The cursor of a repository, { at, id }, or null when there is none or the file is not one. */
export function readCursor(state, repo) {
  try {
    const c = JSON.parse(readFileSync(fileOf(state, repo), 'utf8'));
    return typeof c?.at === 'string' && Number.isInteger(c.id) ? { at: c.at, id: c.id } : null;
  } catch {
    return null;
  }
}

function writeCursor(state, repo, cursor) {
  mkdirSync(state, { recursive: true });
  const file = fileOf(state, repo);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(cursor)}\n`);
  renameSync(tmp, file);
}

const after = (a, b) => a.at > b.at || (a.at === b.at && a.id > b.id);

/** The teams that hold issues, by number, from the claim refs: the tip's subject `claim <n> <team>` or `handoff <n> <team>` holds issue <n> for
 * <team>; `release <n>` holds none. */
export function holders(claims) {
  const held = new Map();
  for (const ref of claims ?? []) {
    const m = /^(?:claim|handoff) (\d+) ([a-z][a-z0-9]*)$/.exec(ref?.target?.messageHeadline ?? '');
    if (m && m[1] === ref.name) held.set(Number(m[1]), m[2]);
  }
  return held;
}

/** The step after a successful read of a repository. `asked` is the time just before the query (the cursor of a repository whose issues hold
 * no comment yet), `folder` the clone's folder under the factory root, `self` the sweep's own login. `lookup(numbers)` reads the claim refs of
 * those issues by name (nodes as QUERY's `claims`); `post` and `lookup` are passed in for tests. Returns the lines it wrote to the events.
 * It throws for a lookup that fails, with the cursor where it was, and for a cursor it cannot write; an event or a post that fails is told
 * on the console. */
export function wakeOnComments({ repo, folder, state, runs, data, self, asked = new Date().toISOString(), post = postSync, lookup = null }) {
  if (!data?.recent?.nodes) return [];
  const comments = data.recent.nodes.flatMap((i) => (i.comments?.nodes ?? []).map((c) => ({ issue: i.number, at: c.createdAt, id: c.databaseId, author: c.author?.login ?? '' })));
  const cursor = readCursor(state, repo);
  if (!cursor) {
    const newest = comments.reduce((a, c) => (!a || after(c, a) ? c : a), null);
    writeCursor(state, repo, newest ? { at: newest.at, id: newest.id } : { at: asked, id: 0 });
    return [];
  }
  const fresh = comments.filter((c) => after(c, cursor)).sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1));
  if (!fresh.length) return [];
  const others = fresh.filter((c) => c.author.toLowerCase() !== String(self).toLowerCase());
  const held = holders(data.claims?.nodes);
  // Claim refs are never deleted and QUERY lists the first CLAIMS by name: when more exist, the issues of fresh comments with no holder
  // among them are asked for by name, in one more query. Its failure throws before the cursor moves, so the next sweep asks again.
  const unseen = [...new Set(others.filter((c) => !held.has(c.issue)).map((c) => c.issue))];
  if (unseen.length && data.claims?.pageInfo?.hasNextPage && lookup) for (const [n, team] of holders(lookup(unseen))) held.set(n, team);
  writeCursor(state, repo, { at: fresh.at(-1).at, id: fresh.at(-1).id });
  const lines = [];
  for (const c of others) {
    const team = held.get(c.issue);
    if (!team) continue;
    try {
      const where = `${folder}-${team}`;
      const r = post(join(runs, where, 'socket'), wakeLine(repo, c.issue));
      const seq = appendStart({
        state,
        kind: 'comment',
        key: `comment ${repo}#${c.issue} ${c.id}`,
        text: `new comment on ${repo}#${c.issue}; Lead ~/factory-runs/${where}: ${r.posted ? 'woken' : `not woken (${r.why}); the comment waits on GitHub`}`,
      });
      lines.push(seq);
    } catch (error) {
      console.log(`queue: the wake for ${repo}#${c.issue} failed: ${String(error.message).split('\n')[0]}`);
    }
  }
  return lines;
}
