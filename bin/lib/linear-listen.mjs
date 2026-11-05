// #414 part A: the daemon's read-only Linear source. Catch-up and the buffered stream share
// one recording function; the store commits the deduplication row and cursor together.
import { readRegistry, TEAM_KEY } from './linear-repos.mjs';
import { CONDITION, createLinear, isAuthFailure } from './linear.mjs';
import { record } from './events.mjs';

const COMMENT = 'id createdAt user { id } issue { identifier team { key } }';
// Issue has no update actor in the schema. Do not mistake its creator for its editor.
const ISSUE = 'id identifier updatedAt team { key }';
const fields = { commentCreated: COMMENT, issueUpdated: ISSUE };
const authClose = (code) => [4002, 4401, 4403].includes(code);

export const SOURCE_SCOPE = 'linear-source';
// A distinct key prevents a request failure from taking over the source's condition.
export const SOURCE_CONDITION = `${CONDITION} source`;
const RECHECK_MS = 5 * 60_000;

export function linearTeams(state) {
  const repos = readRegistry(state);
  return [...new Set(['INN', ...Object.values(repos)
    .filter((r) => r && typeof r.key === 'string' && TEAM_KEY.test(r.key) && typeof r.teamId === 'string')
    .map((r) => r.key)])];
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
async function catchUp(fetchCatchUp, teams, store) {
  const events = [];
  for (const key of teams) for (const [collection, kind, filterType] of [
    ['comments', 'commentCreated', 'CommentFilter'], ['issues', 'issueUpdated', 'IssueFilter'],
  ]) {
    const team = { key: { in: [key] } };
    const since = store.offset(`linear:${key}`) - 60_000;
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
        if (event && event.teamKey === key) events.push(event);
      }
      if (!page.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) throw new Error('invalid catch-up cursor');
      after = page.pageInfo.endCursor;
    } while (true);
  }
  return events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

/** Starts asynchronously after the daemon listens. The API object and both network seams
 * are injectable. Authentication retries use mint({ failed }) from the shared token source.
 * Waiting for credentials is resumable; stop() permanently cancels all work and timers. */
export function startLinearSource({ state, store, WebSocket = globalThis.WebSocket,
  linear, getToken, mintToken, fetchCatchUp, log = console.log, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  const api = () => (linear ??= createLinear({ state }));
  getToken ??= () => api().token();
  mintToken ??= (failed) => api().mint({ failed });
  fetchCatchUp ??= (query, variables) => api().request(query, variables);
  let stopped = false;
  let waiting = false;
  let socket = null;
  let timer = null;
  let heartbeat = null;
  let pongTimer = null;
  let generation = 0;
  let failures = 0;
  let shutdowns = 0;
  let backoff = 1000;
  let started = false;
  let needsMint = false;
  let missingLogged = false;
  let registryLogged = false;
  let teams = [];
  const failedTokens = new Set();
  const readTeams = () => {
    try {
      teams = linearTeams(state);
      registryLogged = false;
    } catch {
      teams = ['INN'];
      if (!registryLogged) log('daemon: Linear team registry could not be read; watching INN only');
      registryLogged = true;
    }
    for (const key of teams) store.initOffset(`linear:${key}`, now() - 10 * 60_000);
    return teams;
  };
  const catchUpNow = () => catchUp(fetchCatchUp, readTeams(), store);
  const clearHeartbeat = () => {
    cancel(heartbeat);
    cancel(pongTimer);
    heartbeat = pongTimer = null;
  };
  const stop = () => {
    stopped = true;
    generation += 1;
    cancel(timer);
    clearHeartbeat();
    socket?.close();
  };
  const condition = (raised) => {
    try {
      record({ state, found: raised ? [{ key: SOURCE_CONDITION, scope: SOURCE_SCOPE, top: true,
        text: 'Linear source stopped after three authentication failures' }] : [],
      read: new Set([SOURCE_SCOPE]), now: now() });
    } catch {
      log('daemon: Linear source could not write its authentication condition');
    }
  };
  const recheck = () => {
    waiting = true;
    timer = schedule(() => { void connect(); }, RECHECK_MS);
  };
  const retry = (code) => {
    if (stopped) return;
    failures = authClose(code) ? failures + 1 : 0;
    shutdowns = code === 1001 ? shutdowns + 1 : 0;
    if (failures >= 3) {
      condition(true);
      recheck();
      return;
    }
    const delay = code === 1001 && shutdowns === 1 ? 0 : backoff;
    if (delay) backoff = Math.min(60_000, backoff * 2);
    timer = schedule(() => { void connect(); }, delay);
  };
  async function connect() {
    if (stopped) return;
    const mine = ++generation;
    const current = () => !stopped && mine === generation;
    readTeams();
    let token;
    try {
      token = needsMint && !waiting ? (await mintToken([...failedTokens])).token : await getToken();
    } catch {
      // Never print exceptions from a token provider: they may contain credentials.
    }
    if (!current()) return;
    if (!token || failedTokens.has(token)) {
      if (!missingLogged && failures < 3) log('daemon: Linear source not started: no usable token');
      missingLogged = true;
      recheck();
      return;
    }
    if (waiting) failures = 0;
    waiting = false;
    missingLogged = false;
    needsMint = false;
    try {
      if (!started) {
        const events = await catchUpNow();
        if (!current()) return;
        for (const event of events) handleLinearEvent(store, event);
        started = true;
      }
      // Node's built-in WebSocket accepts WebSocketInit as its second argument.
      const Authorization = `Bearer ${token}`;
      const ws = new WebSocket('wss://api.linear.app/graphql', {
        protocols: ['graphql-transport-ws'], headers: { Authorization },
      });
      socket = ws;
      let catching = true;
      let acknowledged = false;
      const pending = [];
      const send = (message) => ws.send(JSON.stringify(message));
      const disconnect = (code) => {
        if (!current()) return;
        generation += 1;
        clearHeartbeat();
        if (authClose(code)) {
          failedTokens.add(token);
          needsMint = true;
        }
        ws.close();
        socket = null;
        retry(code);
      };
      const ping = () => {
        if (!current()) return;
        try {
          pongTimer = schedule(() => disconnect(1006), 10_000);
          send({ type: 'ping' });
          heartbeat = schedule(ping, 30_000);
        } catch {
          disconnect(1006);
        }
      };
      ws.addEventListener('open', () => {
        if (current()) send({ type: 'connection_init', payload: { Authorization } });
      });
      ws.addEventListener('close', (event) => disconnect(event.code));
      ws.addEventListener('error', () => disconnect(1006));
      ws.addEventListener('message', (event) => {
        if (!current()) return;
        let message;
        try { message = JSON.parse(event.data); } catch { disconnect(1002); return; }
        try {
          if (message.type === 'ping') return send({ type: 'pong', ...(message.payload ? { payload: message.payload } : {}) });
          if (message.type === 'pong') {
            cancel(pongTimer);
            pongTimer = null;
            return;
          }
          if (message.type === 'connection_ack' && !acknowledged) {
            acknowledged = true;
            backoff = 1000;
            shutdowns = 0;
            failures = 0;
            failedTokens.clear();
            condition(false);
            heartbeat = schedule(ping, 30_000);
            for (const [kind, selection] of Object.entries(fields)) {
              send({ id: kind, type: 'subscribe', payload: { query: `subscription { ${kind} { ${selection} } }` } });
            }
            void catchUpNow().then((events) => {
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
  return { stop, ready, get stopped() { return stopped; }, get waiting() { return waiting; } };
}
