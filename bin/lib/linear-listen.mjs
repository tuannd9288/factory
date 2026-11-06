// #414: the daemon's read-only Linear source. Catch-up and the buffered stream share
// one recording function; the store commits the deduplication row and cursor together.
import { readRegistry, TEAM_KEY } from './linear-repos.mjs';
import { CONDITION, createLinear, isAuthFailure } from './linear.mjs';
import { join } from 'node:path';
import { commentsOfIssue, holderOf } from './linear-cli.mjs';
import { post as postAsync, wakeLine } from './wake.mjs';
import { placeOf } from './factory.mjs';
import { record, appendStart, innAnswer } from './events.mjs';

const COMMENT = 'id createdAt user { id } botActor { type } issue { identifier team { key } }';
// Issue has no update actor in the schema. Do not mistake its creator for its editor.
const ISSUE = 'id identifier updatedAt description team { key }';
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
    ...(kind === 'issueUpdated' ? { description: node.description ?? null } : {}),
    actorId: kind === 'commentCreated' ? node.user?.id ?? null : null,
    self: kind === 'commentCreated' && !node.user && node.botActor?.type === 'oauthClient', time };
}

const picks = (description) => [...String(description ?? '').matchAll(/^\s*- \[x\]\s+\*\*([A-Z])\b/gim)].map((m) => m[1].toUpperCase());

async function handleInn(store, event, { state, linear, now }) {
  if (placeOf() !== 'factory' || event.self || store.linearSeen(event)) return store.linearEvent(event);
  const previous = event.kind === 'issueUpdated' ? store.linearPrevious(event.id) : null;
  const gained = picks(event.description).filter((p) => !picks(previous?.description).includes(p));
  if (event.kind === 'issueUpdated' && (!gained.length || previous?.time >= event.time)) return store.linearEvent(event);
  const owners = (await linear.request('query { users(filter: { owner: { eq: true }, app: { eq: false } }, first: 10) { nodes { id } } }'))?.users?.nodes ?? [];
  const human = owners.length === 1 ? owners[0].id : null;
  if (event.kind === 'commentCreated') {
    if (human && event.actorId === human) innAnswer({ state, event, now: now() });
    return store.linearEvent(event);
  }
  // Only editors in the interval that gained the tick can back this answer. A history
  // entry's actor is not its description editor (the INN-17 finding).
  const inUpdate = (at) => previous
    ? Date.parse(at) > previous.time && Date.parse(at) <= event.time
    : Date.parse(at) === event.time;
  let source = null;
  let after = null;
  let document;
  do {
    const data = await linear.request(`query($id: String!, $after: String) { issue(id: $id) {
      documentContent { id }
      history(first: 100, after: $after) { nodes { updatedDescription createdAt descriptionUpdatedBy { id } }
        pageInfo { hasNextPage endCursor } }
    } }`, { id: event.id, after });
    document = data?.issue?.documentContent;
    const history = data?.issue?.history;
    if (human && history?.nodes?.some((h) => h.updatedDescription && inUpdate(h.createdAt) && h.descriptionUpdatedBy?.some((u) => u.id === human))) {
      source = 'IssueHistory.descriptionUpdatedBy';
      break;
    }
    if (!history?.pageInfo?.hasNextPage) break;
    if (!history.pageInfo.endCursor || history.pageInfo.endCursor === after) throw new Error('invalid history cursor');
    after = history.pageInfo.endCursor;
  } while (true);
  if (!source && document?.id) {
    const data = await linear.request(`query($id: String!) {
      documentContentHistory(id: $id) { actorIds contentDataSnapshotAt }
    }`, { id: document.id });
    if (human && data?.documentContentHistory?.some((h) => inUpdate(h.contentDataSnapshotAt) && h.actorIds?.includes(human))) source = 'documentContentHistory.actorIds';
  }
  // Write the durable condition first: a retry after an interrupted store commit
  // sees the same condition key and cannot append a second start.
  innAnswer({ state, event, pick: gained.join(', '), source, now: now() });
  return store.linearEvent(event);
}

/** Port of comment-wake.mjs:73-95: skip self, find the holder, commit the cursor before
 * waking, then append the event. No store transaction is held across the async post or the events file's lock. */
export async function handleLinearEvent(store, event, { state, runs, linear, post = postAsync, now = Date.now,
  log = console.log } = {}) {
  if (event.teamKey === 'INN') return handleInn(store, event, { state, linear, now });
  if (event.kind !== 'commentCreated' || event.self) return store.linearEvent(event);
  const repo = Object.entries(readRegistry(state)).find(([, r]) => r?.key === event.teamKey && typeof r.teamId === 'string')?.[0];
  if (!repo) return store.linearEvent(event);
  // As with the GitHub holder lookup, a failed read must leave the cursor unchanged.
  const team = holderOf(await commentsOfIssue(linear, event.issueIdentifier));
  if (!store.linearEvent(event)) return false;
  if (!team) return true;
  try {
    const where = `${repo}-${team}`;
    const r = await post(join(runs, where, 'socket'), wakeLine(repo, event.issueIdentifier));
    if (r.posted) store.linearWake(event.id, now() - event.time);
    appendStart({ state, kind: 'comment',
      key: `comment ${repo}#${event.issueIdentifier} ${event.id}`,
      text: `new comment on ${repo}#${event.issueIdentifier}; Lead ~/factory-runs/${where}: ${r.posted ? 'woken' : `not woken (${r.why}); the comment waits on Linear`}`,
    });
  } catch {
    log(`daemon: the wake for ${repo}#${event.issueIdentifier} failed`);
  }
  return true;
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
export function startLinearSource({ state, store, runs = process.env.FACTORY_RUNS ?? join(process.env.HOME, 'factory-runs'), post = postAsync, WebSocket = globalThis.WebSocket,
  linear, getToken, mintToken, fetchCatchUp, log = console.log, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  const api = () => (linear ??= createLinear({ state }));
  // Description comparisons must see the preceding committed update, including live bursts.
  let handling = Promise.resolve();
  const handle = (event) => {
    const next = handling.then(() => handleLinearEvent(store, event, { state, runs, linear: { request: (...args) => api().request(...args) }, post, now, log }));
    handling = next.catch(() => {});
    return next;
  };
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
        for (const event of events) await handle(event);
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
            void catchUpNow().then(async (events) => {
              if (!current()) return;
              for (const e of events) await handle(e);
              pending.sort((a, b) => a.time - b.time);
              for (const e of pending) await handle(e);
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
              else void handle(e).catch(() => disconnect(1006));
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
