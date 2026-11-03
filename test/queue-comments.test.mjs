// #351: the sweep wakes the Lead that holds an issue when a new comment is on it. A fake gh serves the queue's one query (with the claim refs and
// the recently updated issues in it); the Leads' sockets are real unix sockets in a temporary folder. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const T = (n) => `2026-11-03T10:0${n}:00Z`;

/** One repository o/app swept as agent-bot; the query's answer is $Q/graphql.json, and a file $Q/fail makes it fail. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'comments-'));
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$(printf \'%s\' "$*" | tr \'\\n\' \' \')" >>"$Q/calls"',
      'case "$*" in',
      '  "api user"*) echo agent-bot ;;',
      '  *rules/branches*) echo "[]" ;;',
      '  *graphql*) if [ -e "$Q/fail" ]; then echo "HTTP 502" >&2; exit 1; fi; cat "$Q/graphql.json" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  for (const d of ['runs', 'home', 'root']) mkdirSync(join(dir, d));
  const state = join(dir, 'state');
  const sockets = [];
  const w = {
    dir,
    state,
    sockets,
    /** The query's answer: claims as [issue, subject], issues as [number, [[comment id, time, author]...]]. */
    answer: ({ claims = [], issues = [] }) =>
      writeFileSync(
        join(dir, 'graphql.json'),
        JSON.stringify({
          data: {
            repository: {
              issues: { nodes: [] },
              claims: { pageInfo: { hasNextPage: false }, nodes: claims.map(([n, subject]) => ({ name: String(n), target: { messageHeadline: subject } })) },
              recent: { nodes: issues.map(([number, list]) => ({ number, comments: { nodes: list.map(([id, at, author]) => ({ databaseId: id, createdAt: at, author: author === null ? null : { login: author } })) } })) },
              pullRequests: { nodes: [] },
            },
          },
        }),
      ),
    /** A Lead of team `team` listening, its socket recorded in its run folder; what it received is in .got. */
    lead: async (team, { recorded = true } = {}) => {
      const path = join(dir, `${team}.sock`);
      const got = [];
      const server = createServer((c) => {
        let text = '';
        c.on('data', (d) => (text += d));
        c.on('end', () => got.push(text));
      });
      await new Promise((done) => server.listen(path, done));
      sockets.push(server);
      if (recorded) {
        mkdirSync(join(dir, `runs/app-${team}`), { recursive: true });
        writeFileSync(join(dir, `runs/app-${team}/socket`), `${path}\n`);
      }
      return { got, path };
    },
    sweep: () => {
      writeFileSync(join(dir, 'calls'), '');
      const out = spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, HOME: join(dir, 'home'), FACTORY_ROOT: join(dir, 'root'), FACTORY_STATE: state, FACTORY_RUNS: join(dir, 'runs'), AGENT_PROFILES: join(dir, 'profiles'), XDG_DATA_HOME: join(dir, 'data') },
      });
      const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean);
      return { code: out.status, out: out.stdout + out.stderr, calls };
    },
    events: () => (existsSync(join(state, 'events.jsonl')) ? readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cursor: () => (existsSync(join(state, 'queue-o-app.comments')) ? JSON.parse(readFileSync(join(state, 'queue-o-app.comments'), 'utf8')) : null),
    done: () => {
      for (const s of sockets) s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return w;
}

const arrived = async (got, n) => {
  for (const start = Date.now(); got.length < n && Date.now() - start < 3000; ) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
};
const comments = (w) => w.events().filter((e) => e.kind === 'comment');
const HELD = [[7, 'claim 7 alpha']];

test('the first sweep of a repository writes the cursor and wakes nothing; a later comment wakes the holder once, and not again', async () => {
  const w = world();
  try {
    const alpha = await w.lead('alpha');
    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288']]]] });
    let r = w.sweep();
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(w.cursor(), { at: T(1), id: 100 });
    assert.ok(!r.calls.some((c) => c.includes('since=')), 'the first query asks for no date');
    assert.deepEqual(comments(w), []);
    await arrived(alpha.got, 0);
    assert.deepEqual(alpha.got, []);

    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288'], [101, T(2), 'tuannd9288']]]] });
    r = w.sweep();
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.some((c) => c.includes(`since=${T(1)}`)), r.calls.join('\n'));
    assert.equal(r.calls.filter((c) => c.includes('graphql')).length, 1, 'the wake adds no gh call');
    assert.deepEqual(r.calls.filter((c) => !/^api (user|--paginate|graphql)/.test(c)), [], 'the calls are the login, the rules and the one query');
    const lines = comments(w);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].type, lines[0].kind, lines[0].key], ['start', 'comment', 'comment o/app#7 101']);
    assert.match(lines[0].text, /o\/app#7/);
    assert.match(lines[0].text, /factory-runs\/app-alpha/);
    assert.match(lines[0].text, /woken/);
    assert.doesNotMatch(lines[0].text, /tuannd9288|agent-bot|@/);
    await arrived(alpha.got, 1);
    assert.equal(alpha.got.length, 1);
    assert.match(JSON.parse(alpha.got[0]).message.content, /^\[factory\] wake #\d+-\d+: new comment on o\/app#7; re-read the issue\.$/);
    assert.deepEqual(w.cursor(), { at: T(2), id: 101 });

    // The same answer again: nothing new, so no second line and no second post.
    r = w.sweep();
    assert.equal(r.code, 0, r.out);
    assert.equal(comments(w).length, 1);
    await arrived(alpha.got, 1);
    assert.equal(alpha.got.length, 1);
  } finally {
    w.done();
  }
});

test('a handoff moves the wake to the new holder; a released claim, an unclaimed issue and the agents\' own comment wake nothing', async () => {
  const w = world();
  try {
    const alpha = await w.lead('alpha');
    const beta = await w.lead('beta');
    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    // A handoff: the tip's subject names beta.
    w.answer({ claims: [[7, 'handoff 7 beta']], issues: [[7, [[100, T(1), 'tuannd9288'], [101, T(2), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    await arrived(beta.got, 1);
    assert.equal(beta.got.length, 1);
    assert.deepEqual(alpha.got, []);
    assert.match(comments(w)[0].text, /app-beta/);
    // Released: a comment on it wakes no one, and the cursor moves past it.
    w.answer({ claims: [[7, 'release 7']], issues: [[7, [[101, T(2), 'tuannd9288'], [102, T(3), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    // Unclaimed: no claim ref at all for issue 8.
    w.answer({ claims: [[7, 'release 7']], issues: [[8, [[103, T(4), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    // The agents' own comment on a held issue.
    w.answer({ claims: HELD, issues: [[7, [[104, T(5), 'agent-bot']]]] });
    assert.equal(w.sweep().code, 0);
    assert.equal(comments(w).length, 1, JSON.stringify(comments(w)));
    await arrived(beta.got, 1);
    assert.equal(beta.got.length, 1);
    assert.deepEqual(alpha.got, []);
    assert.deepEqual(w.cursor(), { at: T(5), id: 104 });
  } finally {
    w.done();
  }
});

test('a read that fails changes nothing, and the comment is woken once the read works', async () => {
  const w = world();
  try {
    const alpha = await w.lead('alpha');
    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288'], [101, T(2), 'tuannd9288']]]] });
    writeFileSync(join(w.dir, 'fail'), '');
    const failed = w.sweep();
    assert.equal(failed.code, 1, failed.out);
    assert.deepEqual(w.cursor(), { at: T(1), id: 100 });
    assert.deepEqual(comments(w), []);
    await arrived(alpha.got, 0);
    assert.deepEqual(alpha.got, []);
    rmSync(join(w.dir, 'fail'));
    assert.equal(w.sweep().code, 0);
    await arrived(alpha.got, 1);
    assert.equal(alpha.got.length, 1);
    assert.equal(comments(w).length, 1);
  } finally {
    w.done();
  }
});

test('a Lead whose socket cannot be posted to gets no wake, the line says so, and the comment is not tried again', async () => {
  const w = world();
  try {
    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    // No Lead recorded a socket.
    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288'], [101, T(2), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    // A socket file that nothing listens on: a Lead that died without its SessionEnd.
    const stale = join(w.dir, 'stale.sock');
    spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    mkdirSync(join(w.dir, 'runs/app-alpha'), { recursive: true });
    writeFileSync(join(w.dir, 'runs/app-alpha/socket'), `${stale}\n`);
    w.answer({ claims: HELD, issues: [[7, [[101, T(2), 'tuannd9288'], [102, T(3), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    const lines = comments(w);
    assert.equal(lines.length, 2);
    assert.match(lines[0].text, /not woken \(no file\).*waits on GitHub/);
    assert.match(lines[1].text, /not woken \(refused\).*waits on GitHub/);
    assert.equal(w.sweep().code, 0);
    assert.equal(comments(w).length, 2);
    assert.deepEqual(readdirSync(join(w.dir, 'runs/app-alpha')), ['socket']);
  } finally {
    w.done();
  }
});

test('several new comments are woken oldest first, and one that is not newer than the cursor is not', async () => {
  const w = world();
  try {
    const alpha = await w.lead('alpha');
    w.answer({ claims: HELD, issues: [[7, [[100, T(1), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    w.answer({ claims: HELD, issues: [[7, [[99, T(1), 'tuannd9288'], [100, T(1), 'tuannd9288'], [103, T(3), 'tuannd9288'], [102, T(2), 'tuannd9288']]]] });
    assert.equal(w.sweep().code, 0);
    assert.deepEqual(comments(w).map((e) => e.key), ['comment o/app#7 102', 'comment o/app#7 103']);
    await arrived(alpha.got, 2);
    assert.equal(alpha.got.length, 2);
    assert.deepEqual(w.cursor(), { at: T(3), id: 103 });
  } finally {
    w.done();
  }
});
