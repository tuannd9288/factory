import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLinearSource } from '../bin/lib/linear-listen.mjs';
import { openStore } from '../bin/lib/store.mjs';
import { CONDITION } from '../bin/lib/linear.mjs';

const time = (n) => new Date(n * 1000).toISOString();
const comment = (id, n, key = 'FAC') => ({ id, createdAt: time(n), user: { id: 'actor-id' },
  issue: { identifier: `${key}-1`, team: { key } } });
const issue = (id, n) => ({ id, updatedAt: time(n), identifier: 'INN-1', team: { key: 'INN' } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const page = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } });

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), 'linear-listen-'));
  mkdirSync(join(state, 'linear'));
  writeFileSync(join(state, 'linear', 'repos.json'), JSON.stringify({ repo: { key: 'FAC' } }));
  const f = { state, store: openStore(join(state, 'factory.db')), sockets: [], timers: [], logs: [], queries: [], sources: [],
    comments: [], issues: [], tokens: 0, fetch: null };
  class FakeWebSocket {
    constructor(url, protocol) {
      assert.equal(url, 'wss://api.linear.app/graphql');
      assert.equal(protocol, 'graphql-transport-ws');
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
      getToken: async () => `private-token-${++f.tokens}`,
      fetchCatchUp: async (query, variables) => {
        const collection = query.includes('comments(') ? 'comments' : 'issues';
        f.queries.push({ collection, ...variables });
        if (f.fetch) return f.fetch(collection, variables);
        return { [collection]: page(f[collection].filter((n) => Date.parse(n.updatedAt ?? n.createdAt) >= Date.parse(variables.filter.updatedAt.gte))) };
      },
      schedule: (fn, delay) => { const timer = { fn, delay }; f.timers.push(timer); return timer; },
      cancel: (timer) => { if (timer) timer.cancelled = true; },
      log: (line) => f.logs.push(line), ...options });
    f.sources.push(source);
    return source;
  };
  f.reconnect = async (delay) => {
    const timer = f.timers.shift();
    assert.ok(timer && !timer.cancelled);
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
    assert.deepEqual(collection === 'comments' ? filter.issue.team.key.in : filter.team.key.in, ['INN', 'FAC']);
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
  assert.deepEqual(f.store.linearEvents().map((r) => [r.kind, r.id, r.time]), [
    ['commentCreated', 'older', 1000], ['issueUpdated', 'issue-1', 2000],
    ['commentCreated', 'comment-1', 3000], ['issueUpdated', 'issue-1', 4000],
  ]);
  assert.equal(f.store.linearEvents()[2].actor_id, 'actor-id');
  assert.equal(f.store.linearEvents()[2].issue_identifier, 'FAC-1');
  assert.equal(f.store.offset('linear'), 4000);
  ws.next('commentCreated', comment('live-only', 5));
  ws.next('commentCreated', comment('live-only', 5));
  assert.equal(f.store.linearEvents().filter((r) => r.id === 'live-only').length, 1);
  assert.equal(f.store.offset('linear'), 5000);
});

test('1001 reconnect catches an event posted while down once', async (t) => {
  const f = fixture(t);
  await f.start().ready;
  f.sockets[0].open();
  await tick();
  f.sockets[0].next('commentCreated', comment('before', 1));
  f.sockets[0].emit('close', { code: 1001 });
  f.comments.push(comment('before', 1), comment('during', 2));
  const ws = await f.reconnect(0);
  ws.open();
  ws.next('commentCreated', comment('during', 2));
  await tick();
  assert.deepEqual(f.store.linearEvents().map((r) => r.id), ['before', 'during']);
  assert.equal(f.store.offset('linear'), 2000);
});

test('restart catches up from the persisted cursor without duplicates', async (t) => {
  const f = fixture(t);
  const first = f.start();
  await first.ready;
  f.sockets[0].open();
  await tick();
  f.sockets[0].next('commentCreated', comment('before', 5));
  first.stop();
  f.store.close();
  f.store = openStore(join(f.state, 'factory.db'));
  f.comments.push(comment('before', 5), comment('after', 6));
  f.queries.length = 0;
  await f.start().ready;
  assert.equal(f.queries[0].filter.updatedAt.gte, time(5));
  f.sockets.at(-1).open();
  await tick();
  assert.deepEqual(f.store.linearEvents().map((r) => r.id), ['before', 'after']);
  assert.equal(f.store.offset('linear'), 6000);
});

test('three authentication closes stop and write one condition without leaking tokens', async (t) => {
  const f = fixture(t);
  const source = f.start();
  await source.ready;
  f.sockets[0].open();
  await tick();
  f.sockets[0].emit('close', { code: 4002, reason: 'private-token-1' });
  const second = await f.reconnect(1000);
  second.open();
  await tick();
  second.emit('close', { code: 4401, reason: 'private-token-2' });
  const third = await f.reconnect(2000);
  third.open();
  await tick();
  third.message({ type: 'error', payload: [{ message: 'private-token-3', extensions: { code: 'AUTHENTICATION_ERROR' } }] });
  third.emit('close', { code: 4403 });
  assert.equal(source.stopped, true);
  assert.equal(f.sockets.length, 3);
  assert.equal(f.timers.length, 0);
  const output = readFileSync(join(f.state, 'events.jsonl'), 'utf8');
  const lines = output.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, CONDITION);
  assert.equal(lines[0].type, 'start');
  assert.doesNotMatch(output + f.logs.join('\n') + readFileSync(join(f.state, 'events-active.json'), 'utf8'), /private-token/);
});

test('every connect fetches a fresh token; 4003 is normal and backoff caps at 60 seconds', async (t) => {
  const f = fixture(t);
  const source = f.start();
  await source.ready;
  let ws = f.sockets[0];
  ws.open();
  await tick();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    ws.emit('close', { code: 4003 });
    ws = await f.reconnect(delay);
    ws.open();
    await tick();
  }
  assert.equal(source.stopped, false);
  assert.equal(f.tokens, 9);
  assert.deepEqual(f.sockets.map((s) => s.sent[0].payload.token), Array.from({ length: 9 }, (_, i) => `private-token-${i + 1}`));
});

test('no token starts no socket or catch-up and logs only one safe line', async (t) => {
  const f = fixture(t);
  const source = f.start({ getToken: async () => null });
  await source.ready;
  assert.equal(source.stopped, true);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.queries.length, 0);
  assert.equal(f.timers.length, 0);
  assert.deepEqual(f.logs, ['daemon: Linear source not started: no token']);
});
