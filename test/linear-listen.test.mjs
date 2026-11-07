import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HOST_ENV } from './helpers.mjs';
import { startLinearSource, SOURCE_CONDITION, SOURCE_SCOPE } from '../bin/lib/linear-listen.mjs';
import { openStore } from '../bin/lib/store.mjs';
import { CONDITION, createLinear } from '../bin/lib/linear.mjs';
import { writeAppFile } from '../bin/lib/token.mjs';
import { readActive, readLines, record } from '../bin/lib/events.mjs';

const time = (n) => new Date(n * 1000).toISOString();
const comment = (id, n, key = 'FAC') => ({ id, createdAt: time(n), user: { id: 'actor-id' },
  issue: { identifier: `${key}-1`, team: { key } } });
const issue = (id, n) => ({ id, updatedAt: time(n), identifier: 'INN-1', team: { key: 'INN' } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const page = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } });
// This process is the factory host for one test (HOST_ENV), with the settings put back after it.
const asHost = (t) => {
  const before = Object.fromEntries(Object.keys(HOST_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, HOST_ENV);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
};

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), 'linear-listen-'));
  mkdirSync(join(state, 'linear'));
  writeFileSync(join(state, 'linear', 'repos.json'), JSON.stringify({ repo: { key: 'FAC', teamId: 'team-fac' } }));
  const f = { state, store: openStore(join(state, 'factory.db')), sockets: [], timers: [], logs: [], queries: [], sources: [],
    comments: [], issues: [], holderComments: [], posts: [], tokens: 0, fetch: null, now: 600_000 };
  class FakeWebSocket {
    constructor(url, options) {
      assert.equal(url, 'wss://api.linear.app/graphql');
      assert.deepEqual(options.protocols, ['graphql-transport-ws']);
      this.options = options;
      this.handlers = new Map();
      this.sent = [];
      f.sockets.push(this);
    }
    addEventListener(kind, handler) { this.handlers.set(kind, handler); }
    send(text) { this.sent.push(JSON.parse(text)); }
    emit(kind, event = {}) { this.handlers.get(kind)?.(event); }
    message(message) { this.emit('message', { data: JSON.stringify(message) }); }
    next(kind, node) { this.message({ type: 'next', payload: { data: { [kind]: node } } }); }
    close() { this.emit('close', { code: 1000 }); }
    open() {
      this.emit('open');
      this.message({ type: 'connection_ack' });
    }
  }
  f.start = (options = {}) => {
    const source = startLinearSource({ state, store: f.store, WebSocket: FakeWebSocket,
      now: () => f.now, runs: join(state, 'runs'),
      linear: { request: async () => ({ issue: { comments: page(f.holderComments) } }) },
      post: async (file, line) => { f.posts.push({ file, line }); return { posted: true }; },
      mintToken: async () => ({ token: `private-token-${++f.tokens}` }),
      getToken: async () => `private-token-${++f.tokens}`,
      fetchCatchUp: async (query, variables) => {
        const collection = query.includes('comments(') ? 'comments' : 'issues';
        f.queries.push({ collection, ...variables });
        if (f.fetch) return f.fetch(collection, variables);
        return { [collection]: page(f[collection].filter((n) => (variables.filter.issue?.team ?? variables.filter.team).key.in.includes((n.issue ?? n).team.key) && Date.parse(n.updatedAt ?? n.createdAt) >= Date.parse(variables.filter.updatedAt.gte))) };
      },
      schedule: (fn, delay) => { const timer = { fn, delay }; f.timers.push(timer); return timer; },
      cancel: (timer) => { if (timer) timer.cancelled = true; },
      log: (line) => f.logs.push(line), ...options });
    f.sources.push(source);
    return source;
  };
  f.reconnect = async (delay) => {
    const timer = f.timers.find((timer) => !timer.cancelled && !timer.fired);
    assert.ok(timer);
    timer.fired = true;
    assert.equal(timer.delay, delay);
    timer.fn();
    await tick();
    return f.sockets.at(-1);
  };
  t.after(() => {
    for (const source of f.sources) source.stop();
    f.store.close();
    rmSync(state, { recursive: true, force: true });
  });
  return f;
}

test('a stream event is recorded once, after every catch-up page and only for selected teams', async (t) => {
  const f = fixture(t);
  const source = f.start();
  await source.ready;
  let release;
  f.fetch = async (collection, { after, filter }) => {
    const [key] = (filter.issue?.team ?? filter.team).key.in;
    if (key === 'INN') return { [collection]: page(collection === 'issues' ? [issue('issue-1', 2)] : []) };
    if (collection === 'issues') return { issues: page([issue('issue-1', 2)]) };
    if (!after) {
      await new Promise((resolve) => { release = resolve; });
      return { comments: page([comment('comment-1', 3)], 'page-two') };
    }
    assert.equal(after, 'page-two');
    return { comments: page([comment('older', 1), comment('ignored', 8, 'OTHER')]) };
  };
  const ws = f.sockets[0];
  ws.open();
  assert.deepEqual(ws.options, { protocols: ['graphql-transport-ws'], headers: { Authorization: 'Bearer private-token-1' } });
  assert.deepEqual(ws.sent[0], { type: 'connection_init', payload: { Authorization: 'Bearer private-token-1' } });
  await tick();
  ws.message({ type: 'ping', payload: { check: 1 } });
  assert.deepEqual(ws.sent.at(-1), { type: 'pong', payload: { check: 1 } });
  assert.deepEqual(ws.sent.filter((m) => m.type === 'subscribe').map((m) => m.id), ['commentCreated', 'issueUpdated']);
  ws.next('commentCreated', comment('comment-1', 3));
  ws.next('commentCreated', comment('comment-1', 3));
  ws.next('commentCreated', comment('ignored', 8, 'OTHER'));
  assert.equal(f.store.linearEvents().length, 0, 'live events wait for catch-up');
  release();
  await tick();
  ws.next('issueUpdated', issue('issue-1', 2));
  ws.next('issueUpdated', issue('issue-1', 4));
  await tick();
  assert.deepEqual(f.store.linearEvents().map((r) => [r.kind, r.id, r.time]), [
    ['commentCreated', 'older', 1000], ['issueUpdated', 'issue-1', 2000],
    ['commentCreated', 'comment-1', 3000], ['issueUpdated', 'issue-1', 4000],
  ]);
  assert.equal(f.store.linearEvents()[2].actor_id, 'actor-id');
  assert.equal(f.store.linearEvents()[2].issue_identifier, 'FAC-1');
  assert.equal(f.store.offset('linear:INN'), 4000);
  assert.equal(f.store.offset('linear:FAC'), 3000);
  ws.next('commentCreated', comment('live-only', 5));
  ws.next('commentCreated', comment('live-only', 5));
  await tick();
  assert.equal(f.store.linearEvents().filter((r) => r.id === 'live-only').length, 1);
  assert.equal(f.store.offset('linear:FAC'), 5000);
});

test('1001 reconnect catches an event posted while down once', async (t) => {
  const f = fixture(t);
  await f.start().ready;
  f.sockets[0].open();
  await tick();
  f.sockets[0].next('commentCreated', comment('before', 1));
  f.sockets[0].next('issueUpdated', issue('newer-inn', 1190));
  f.now = 1_200_000;
  f.sockets[0].emit('close', { code: 1001 });
  const registry = join(f.state, 'linear', 'repos.json');
  const repos = { repo: { key: 'FAC', teamId: 'team-fac' }, newRepo: { key: 'NEW', teamId: 'team-new' } };
  writeFileSync(registry, JSON.stringify(repos));
  f.comments.push(comment('before', 1), comment('during', 2), comment('new-team', 800, 'NEW'));
  const ws = await f.reconnect(0);
  assert.equal(f.store.offset('linear:NEW'), f.now - 600_000, 'connect sees the newly onboarded team');
  repos.lateRepo = { key: 'LATE', teamId: 'team-late' };
  writeFileSync(registry, JSON.stringify(repos));
  f.comments.push(comment('late-team', 801, 'LATE'));
  ws.open();
  ws.next('commentCreated', comment('during', 2));
  await tick();
  assert.deepEqual(f.store.linearEvents().map((r) => r.id), ['before', 'during', 'new-team', 'late-team', 'newer-inn']);
  assert.equal(f.store.offset('linear:FAC'), 2000);
  assert.equal(f.store.offset('linear:INN'), 1190000);
  assert.equal(f.store.offset('linear:NEW'), 800000);
  assert.equal(f.store.offset('linear:LATE'), 801000, 'catch-up rereads the registry after connect');
  const query = f.queries.find((q) => q.filter.issue?.team.key.in[0] === 'NEW');
  assert.equal(Date.parse(query.filter.updatedAt.gte), f.now - 600_000 - 60_000);
  writeFileSync(registry, '{');
  ws.emit('close', { code: 1001 });
  const innOnly = await f.reconnect(0);
  innOnly.open();
  await tick();
  innOnly.next('commentCreated', comment('excluded', 1201));
  innOnly.next('commentCreated', comment('inn-only', 1202, 'INN'));
  await tick();
  assert.equal(f.logs.filter((line) => line.includes('watching INN only')).length, 1);
  assert.equal(f.store.linearEvents().some((r) => r.id === 'excluded'), false);
  assert.equal(f.store.linearEvents().some((r) => r.id === 'inn-only'), true);
});

test('restart catches up from the persisted cursor without duplicates', async (t) => {
  const f = fixture(t);
  const first = f.start();
  await first.ready;
  f.sockets[0].open();
  await tick();
  f.sockets[0].next('commentCreated', comment('before', 5));
  await tick();
  first.stop();
  f.store.close();
  f.store = openStore(join(f.state, 'factory.db'));
  f.comments.push(comment('before', 5), comment('after', 6));
  f.queries.length = 0;
  await f.start().ready;
  assert.equal(f.queries.find((q) => q.filter.issue?.team.key.in[0] === 'FAC').filter.updatedAt.gte, time(5 - 60));
  f.sockets.at(-1).open();
  await tick();
  assert.deepEqual(f.store.linearEvents().map((r) => r.id), ['before', 'after']);
  assert.equal(f.store.offset('linear:FAC'), 6000);
});

test('authentication failures mint, pause, preserve the condition across other callers and recover on a stored token', async (t) => {
  const f = fixture(t);
  const agentProfiles = join(f.state, 'profiles');
  const put = (name, value) => writeAppFile(agentProfiles, 'linear-app', name, value);
  const access = (token) => put('access.json', JSON.stringify({ token, expiresAt: f.now + 30 * 86400_000 }));
  put('client-id', 'test-client');
  put('client-secret', 'test-secret');
  access('private-token-1');
  let mints = 0;
  const linear = createLinear({ state: f.state, agentProfiles, now: () => f.now,
    fetchFn: async (url) => {
      const body = url.endsWith('/oauth/token')
        ? { access_token: `private-token-${++mints + 1}`, expires_in: 30 * 86400 }
        : { data: { viewer: { id: 'app' }, issue: { comments: page([]) } } };
      return { status: 200, text: async () => JSON.stringify(body) };
    } });
  const source = f.start({ linear, getToken: undefined, mintToken: undefined });
  await source.ready;
  f.sockets[0].emit('open');
  f.sockets[0].emit('close', { code: 4002, reason: 'private-token-1' });
  const second = await f.reconnect(1000);
  second.emit('open');
  assert.equal(second.sent[0].payload.Authorization, 'Bearer private-token-2');
  second.emit('close', { code: 4401, reason: 'private-token-2' });
  const third = await f.reconnect(2000);
  third.emit('open');
  assert.equal(third.sent[0].payload.Authorization, 'Bearer private-token-3');
  assert.equal(mints, 2, 'each rejected socket token was replaced through the real mint path');
  third.message({ type: 'error', payload: [{ message: 'private-token-3', extensions: { code: 'AUTHENTICATION_ERROR' } }] });
  third.emit('close', { code: 4403 });
  assert.equal(source.waiting, true);
  assert.equal(f.sockets.length, 3);
  const lines = () => readFileSync(join(f.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((line) => line.key === SOURCE_CONDITION);
  assert.equal(lines().length, 1);
  assert.equal(lines()[0].kind, CONDITION);
  assert.equal(lines()[0].type, 'start');
  assert.equal(readActive(f.state).conditions[SOURCE_CONDITION].scope, SOURCE_SCOPE);
  record({ state: f.state, found: [{ key: CONDITION, scope: 'linear', text: 'request failed' }], read: new Set() });
  await linear.request('query { viewer { id } }');
  assert.ok(readActive(f.state).conditions[SOURCE_CONDITION], 'HTTP success must not clear the source condition');
  assert.equal(readActive(f.state).conditions[CONDITION], undefined, 'HTTP success did clear its own condition');
  await f.reconnect(300_000);
  assert.equal(f.sockets.length, 3, 'the rejected stored token must not re-arm the source');
  assert.equal(mints, 2, 'polling must not keep minting a rejected, unexpired token');
  access('private-token-recovered');
  f.comments.push(comment('during-auth-stop', 20));
  const recovered = await f.reconnect(300_000);
  assert.equal(source.waiting, false);
  recovered.emit('open');
  assert.equal(lines().length, 1, 'opening the socket is not acknowledgment');
  recovered.message({ type: 'connection_ack' });
  await tick();
  assert.deepEqual(lines().map((line) => line.type), ['start', 'clear']);
  assert.deepEqual(f.store.linearEvents().map((r) => r.id), ['during-auth-stop']);
  assert.doesNotMatch(readFileSync(join(f.state, 'events.jsonl'), 'utf8') + f.logs.join('\n') + readFileSync(join(f.state, 'events-active.json'), 'utf8'), /private-token|test-secret/);
});

test('connect refreshes tokens, repeated closes back off, ack resets and heartbeat requires pong', async (t) => {
  const f = fixture(t);
  const source = f.start();
  await source.ready;
  let ws = f.sockets[0];
  ws.emit('open');
  ws.emit('close', { code: 1001 });
  ws = await f.reconnect(0);
  ws.emit('open');
  ws.emit('close', { code: 1001 });
  ws = await f.reconnect(1000);
  ws.emit('open');
  for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    ws.emit('close', { code: 4003 });
    ws = await f.reconnect(delay);
    ws.emit('open');
  }
  assert.equal(source.waiting, false);
  assert.equal(f.tokens, f.sockets.length);
  assert.deepEqual(f.sockets.map((s) => s.sent[0].payload.Authorization), Array.from({ length: f.tokens }, (_, i) => `Bearer private-token-${i + 1}`));
  ws.message({ type: 'connection_ack' });
  await tick();
  ws.emit('close', { code: 4003 });
  ws = await f.reconnect(1000);
  ws.open();
  await tick();
  await f.reconnect(30_000); // fire the ping timer
  assert.equal(ws.sent.at(-1).type, 'ping');
  ws.message({ type: 'pong' });
  await f.reconnect(30_000);
  assert.equal(ws.sent.at(-1).type, 'ping');
  const count = f.sockets.length;
  await f.reconnect(10_000); // missing pong closes the socket
  assert.equal(f.sockets.length, count);
  ws = await f.reconnect(1000);
  ws.open();
  await tick();
  source.stop();
  assert.equal(f.timers.filter((timer) => !timer.cancelled && !timer.fired).length, 0);
});

test('an empty real token store starts nothing, polls quietly and resumes when a token appears', async (t) => {
  const f = fixture(t);
  asHost(t);
  const agentProfiles = join(f.state, 'empty-profiles');
  let networkCalls = 0;
  const linear = createLinear({ state: f.state, agentProfiles, now: () => f.now,
    fetchFn: async () => { networkCalls += 1; return { status: 200, text: async () => JSON.stringify({ data: { users: { nodes: [] } } }) }; } });
  const source = f.start({ linear, getToken: undefined, mintToken: undefined });
  await source.ready;
  assert.equal(source.waiting, true);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.queries.length, 0);
  await f.reconnect(300_000);
  assert.equal(f.sockets.length, 0);
  assert.equal(networkCalls, 0);
  assert.deepEqual(f.logs, ['daemon: Linear source not started: no usable token']);
  writeAppFile(agentProfiles, 'linear-app', 'access.json', JSON.stringify({ token: 'private-token-added', expiresAt: f.now + 86400_000 }));
  f.comments.push(comment('before-token', 30, 'INN'));
  const ws = await f.reconnect(300_000);
  ws.open();
  await tick();
  assert.equal(source.waiting, false);
  assert.deepEqual(f.store.linearEvents().map((r) => r.id), ['before-token']);
  assert.equal(networkCalls, 1);
});


test('a held Linear comment wakes once across stream, catch-up and restart and stores its delay', async (t) => {
  const f = fixture(t);
  f.holderComments = [{ body: 'Taken by team alpha.', createdAt: time(1) }];
  const source = f.start();
  await source.ready;
  const ws = f.sockets[0];
  ws.open();
  await tick();
  const node = comment('held-comment', 599);
  ws.next('commentCreated', node);
  await tick();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].file, join(f.state, 'runs', 'repo-alpha', 'socket'));
  assert.match(JSON.parse(f.posts[0].line).message.content, /new comment on repo#FAC-1; re-read the issue\./);
  assert.equal(f.store.linearEvents()[0].wake_delay_ms, 1000);
  f.comments.push(node);
  ws.emit('close', { code: 1001 });
  const next = await f.reconnect(0);
  next.open();
  await tick();
  source.stop();
  f.store.close();
  f.store = openStore(join(f.state, 'factory.db'));
  await f.start().ready;
  assert.equal(f.store.linearEvents()[0].wake_delay_ms, 1000);
  assert.equal(f.posts.length, 1);
  const lines = readFileSync(join(f.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'comment');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].key, 'comment repo#FAC-1 held-comment');
  assert.match(lines[0].text, /Lead ~\/factory-runs\/repo-alpha: woken$/);
});

test('own app comments, unheld issues and INN do not wake', async (t) => {
  const f = fixture(t);
  f.holderComments = [{ body: 'Taken by team alpha.', createdAt: time(1) }];
  f.comments = [{ ...comment('self', 2), user: null, botActor: { type: 'oauthClient' } }, comment('inn', 2, 'INN')];
  await f.start().ready;
  assert.equal(f.posts.length, 0);
  f.holderComments.push({ body: 'Released by team alpha.', createdAt: time(3) });
  const ws = f.sockets[0];
  ws.open();
  await tick();
  ws.next('commentCreated', comment('unheld', 4));
  await tick();
  assert.equal(f.posts.length, 0);
  assert.ok(f.store.linearEvents().every((e) => e.wake_delay_ms === null));
});


test('the source answers ping while the async wake is pending', async (t) => {
  const f = fixture(t);
  f.holderComments = [{ body: 'Taken by team alpha.', createdAt: time(1) }];
  let finish;
  await f.start({ post: () => new Promise((resolve) => { finish = resolve; }) }).ready;
  const ws = f.sockets[0];
  ws.open();
  await tick();
  ws.next('commentCreated', comment('pending', 599));
  await tick();
  assert.equal(typeof finish, 'function');
  ws.message({ type: 'ping', payload: { duringWake: true } });
  assert.deepEqual(ws.sent.at(-1), { type: 'pong', payload: { duringWake: true } });
  finish({ posted: false, why: 'no file' });
  await tick();
  assert.equal(f.store.linearEvents()[0].wake_delay_ms, null);
  const lines = readFileSync(join(f.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(lines.find((line) => line.kind === 'comment').text, /not woken \(no file\); the comment waits on Linear/);
});


test('INN answers use backed editors and write once across close, catch-up and restart on any node', async (t) => {
  const f = fixture(t);
  asHost(t);
  const calls = [];
  const linear = { request: async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('users(')) return { users: { nodes: [{ id: 'human' }] } };
    if (query.includes('documentContentHistory(')) return { documentContentHistory: [
      { actorIds: ['human'], contentDataSnapshotAt: time(4) },
    ] };
    return { issue: { history: page([
      { updatedDescription: true, createdAt: time(2), descriptionUpdatedBy: [{ id: 'human' }] },
      { updatedDescription: true, createdAt: time(6), actor: { id: 'human' }, descriptionUpdatedBy: [] },
    ]), documentContent: { id: 'document-1' } } };
  } };
  const start = () => f.start({ linear });
  const first = start();
  await first.ready;
  const ws = f.sockets[0];
  ws.open();
  await tick();
  const update = (n, description) => ({ ...issue('pick', n), description });
  const nodes = [update(1, '- [ ] **A**'), update(2, '- [x] **A**'),
    update(3, '- [x] **A** more words'), update(4, '- [X] **B (Đề xuất):** chọn'),
    update(6, '- [x] **C**')];
  for (const n of nodes) { ws.next('issueUpdated', n); await tick(); }
  const answer = { ...comment('answer', 7, 'INN'), user: { id: 'human' } };
  ws.next('commentCreated', answer);
  ws.next('commentCreated', answer);
  ws.next('commentCreated', comment('other', 8, 'INN'));
  await tick();
  const lines = () => readLines(f.state).filter((e) => e.kind === 'inn-answer');
  assert.equal(lines().length, 4);
  assert.ok(lines().every((e) => e.type === 'start'));
  assert.match(lines()[0].text, /A.*IssueHistory.descriptionUpdatedBy/);
  assert.match(lines()[1].text, /B.*documentContentHistory.actorIds/);
  assert.match(lines()[2].text, /C.*ticker is not confirmed.*not his answer/);
  assert.match(lines()[3].text, /his comment/);
  assert.equal(calls.filter((c) => c.query.includes('documentContentHistory(')).length, 2);
  const unseen = { ...update(8, '- [X] **D**'), id: 'unseen' };
  ws.next('issueUpdated', unseen);
  await tick();
  assert.match(lines().at(-1).text, /D.*ticker is not confirmed/, 'older edits do not attribute a first-seen tick');
  f.issues = [...nodes, unseen];
  f.comments = [answer];
  ws.emit('close', { code: 1001 });
  (await f.reconnect(0)).open();
  await tick();
  first.stop();
  f.store.close();
  f.store = openStore(join(f.state, 'factory.db'));
  const second = start();
  await second.ready;
  assert.equal(lines().length, 5);
  second.stop();
  const before = process.env.FACTORY_HOST_USER;
  process.env.FACTORY_HOST_USER = 'not-this-host';
  try {
    f.comments.push({ ...answer, id: 'remote-answer', createdAt: time(9) });
    await start().ready;
    assert.equal(lines().length, 6, 'another node records answers for claimed delivery too');
  } finally {
    if (before === undefined) delete process.env.FACTORY_HOST_USER;
    else process.env.FACTORY_HOST_USER = before;
  }
});
