// #414 part A: the daemon's read-only Linear source. Catch-up and the buffered stream share
// one recording function; the store commits the deduplication row and cursor together.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONDITION, createLinear, isAuthFailure } from './linear.mjs';
import { record } from './events.mjs';

const COMMENT = 'id createdAt user { id } issue { identifier team { key } }';
// Issue has no update actor in the schema. Do not mistake its creator for its editor.
const ISSUE = 'id identifier updatedAt team { key }';
const fields = { commentCreated: COMMENT, issueUpdated: ISSUE };
const authClose = (code) => [4002, 4401, 4403].includes(code);

export function linearTeams(state) {
  let repos = {};
  try {
    repos = JSON.parse(readFileSync(join(state, 'linear', 'repos.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [...new Set(['INN', ...Object.values(repos).map((r) => r?.key).filter((k) => typeof k === 'string' && k.length)])];
}

function eventOf(kind, node) {
  const issue = kind === 'commentCreated' ? node?.issue : node;
  const time = Date.parse(kind === 'commentCreated' ? node?.createdAt : node?.updatedAt);
  if (!node?.id || !issue?.identifier || !issue?.team?.key || !Number.isFinite(time)) return null;
  return { kind, id: node.id, issueIdentifier: issue.identifier, teamKey: issue.team.key,
    actorId: kind === 'commentCreated' ? node.user?.id ?? null : null, time };
}

/** The seam for subsequent parts. Part A only records; false means it was already handled. */
export function handleLinearEvent(store, event) {
  return store.linearEvent(event);
}

/** Read every page before moving the cursor; sort across both connections, not per page. */
async function catchUp(fetchCatchUp, teams, since) {
  const events = [];
  for (const [collection, kind, filterType] of [
    ['comments', 'commentCreated', 'CommentFilter'], ['issues', 'issueUpdated', 'IssueFilter'],
  ]) {
    const team = { key: { in: teams } };
    const filter = { updatedAt: { gte: new Date(since).toISOString() },
      ...(collection === 'comments' ? { issue: { team } } : { team }) };
    const query = `query($filter: ${filterType}!, $after: String) {
      ${collection}(filter: $filter, after: $after, first: 100, includeArchived: true, orderBy: updatedAt) {
        nodes { ${fields[kind]} } pageInfo { hasNextPage endCursor }
      }
    }`;
    let after = null;
    do {
      const data = await fetchCatchUp(query, { filter, after });
      const page = data?.[collection];
      if (!Array.isArray(page?.nodes) || !page.pageInfo) throw new Error('invalid catch-up page');
      for (const node of page.nodes) {
        const event = eventOf(kind, node);
        if (event && teams.includes(event.teamKey)) events.push(event);
      }
      if (!page.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) throw new Error('invalid catch-up cursor');
      after = page.pageInfo.endCursor;
    } while (true);
  }
  return events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

/** Starts asynchronously, after the daemon listens. All network seams are injectable.
 * fetchCatchUp has createLinear.request's signature: (query, variables) -> GraphQL data.
 * stop invalidates pending work before the daemon closes its store. */
export function startLinearSource({ state, store, WebSocket = globalThis.WebSocket,
  getToken, fetchCatchUp, teams, log = console.log,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let client;
  const api = () => (client ??= createLinear({ state }));
  getToken ??= () => api().token();
  fetchCatchUp ??= (query, variables) => api().request(query, variables);
  let stopped = false;
  let socket = null;
  let timer = null;
  let generation = 0;
  let failures = 0;
  let backoff = 1000;
  let started = false;
  const stop = () => {
    stopped = true;
    generation += 1;
    cancel(timer);
    socket?.close();
  };
  const retry = (code) => {
    if (stopped) return;
    if (authClose(code)) failures += 1;
    else failures = 0;
    if (failures >= 3) {
      stop();
      try {
        record({ state, found: [{ key: CONDITION, scope: 'linear', top: true,
          text: 'Linear source stopped after three authentication failures' }], read: new Set() });
      } catch {
        log('daemon: Linear source could not write its authentication condition');
      }
      return;
    }
    const delay = code === 1001 ? 0 : backoff;
    if (code !== 1001) backoff = Math.min(60_000, backoff * 2);
    timer = schedule(() => { void connect(); }, delay);
  };
  async function connect() {
    if (stopped) return;
    const mine = ++generation;
    const current = () => !stopped && mine === generation;
    let token;
    try {
      teams ??= linearTeams(state);
    } catch {
      log('daemon: Linear source not started: team registry could not be read');
      stop();
      return;
    }
    try {
      if (!teams.length) {
        log('daemon: Linear source not started: no team');
        stop();
        return;
      }
      token = await getToken();
    } catch {
      // Never print an exception from a token provider (it might contain credentials).
    }
    if (!current()) return;
    if (!token) {
      log('daemon: Linear source not started: no token');
      stop();
      return;
    }
    try {
      if (!started) {
        const events = await catchUp(fetchCatchUp, teams, store.offset('linear'));
        if (!current()) return;
        for (const event of events) handleLinearEvent(store, event);
        started = true;
      }
      const ws = new WebSocket('wss://api.linear.app/graphql', 'graphql-transport-ws');
      socket = ws;
      let catching = true;
      let acknowledged = false;
      const pending = [];
      const send = (message) => ws.send(JSON.stringify(message));
      const disconnect = (code) => {
        if (!current()) return;
        generation += 1;
        ws.close();
        retry(code);
      };
      ws.addEventListener('open', () => {
        if (current()) send({ type: 'connection_init', payload: { token } });
        token = null;
      });
      ws.addEventListener('close', (event) => disconnect(event.code));
      ws.addEventListener('error', () => disconnect(1006));
      ws.addEventListener('message', (event) => {
        if (!current()) return;
        let message;
        try { message = JSON.parse(event.data); } catch { disconnect(1002); return; }
        try {
          if (message.type === 'ping') return send({ type: 'pong', ...(message.payload ? { payload: message.payload } : {}) });
          if (message.type === 'connection_ack' && !acknowledged) {
            acknowledged = true;
            send({ type: 'ping' });
            for (const [kind, selection] of Object.entries(fields)) {
              send({ id: kind, type: 'subscribe', payload: { query: `subscription { ${kind} { ${selection} } }` } });
            }
            void catchUp(fetchCatchUp, teams, store.offset('linear')).then((events) => {
              if (!current()) return;
              for (const e of events) handleLinearEvent(store, e);
              pending.sort((a, b) => a.time - b.time);
              for (const e of pending) handleLinearEvent(store, e);
              catching = false;
            }).catch(() => { disconnect(1006); });
          }
          if (message.type === 'error' || message.payload?.errors?.length) {
            const errors = Array.isArray(message.payload) ? message.payload : message.payload?.errors ?? [];
            disconnect(isAuthFailure(200, { errors }) ? 4401 : 1006);
          } else if (message.type === 'complete') {
            disconnect(1000);
          } else if (message.type === 'next') {
            for (const kind of Object.keys(fields)) {
              const e = eventOf(kind, message.payload?.data?.[kind]);
              if (!e || !teams.includes(e.teamKey)) continue;
              failures = 0;
              backoff = 1000;
              if (catching) pending.push(e);
              else handleLinearEvent(store, e);
            }
          }
        } catch {
          disconnect(1006);
        }
      });
    } catch {
      if (current()) retry(1006);
    }
  }
  const ready = connect();
  return { stop, ready, get stopped() { return stopped; } };
}
