// Claude Code's formats (INN-39 item 3): the one file of the factory that reads what Claude Code writes. The rest of the factory reads
// the factory's own shapes, which this file gives it:
//   - the stream-json log of `claude -p` (bin/seat's run-<tag>.jsonl): its `system`/`init` and `result` events (resultOf, for a seat's
//     record), and its `rate_limit_event` lines (rateReadingOf, RATE_LIMIT_LINE);
//   - a log or a Lead's transcript copy, summed (parseLog), and a session's transcripts under a profile's projects/ (assistantEntries),
//     priced at API rates from prices.json (costOf), with the canary that the fields read are still there (READS, inspect);
//   - the status line's rate_limits, as bin/lib/statusline-hook.mjs keeps them (statusLineWindows);
//   - the hook events a Lead's hooks record in state.json, named by Claude Code (leadStateOf);
//   - a stream line reduced for the reader (reduce), and whether it ends a turn of the session's own (turnEnded);
//   - `claude auth status`'s JSON (readClaude).
// Its fixtures come from Claude Code 2.1.308 (test/fixtures/ledger-entry-2.1.308.json, the reader's and the seats' stream fixtures).
// The pinned contract it produces into: a seat's record in sessions.jsonl (bin/lib/seat.mjs recordOf composes it from resultOf), the lines
// of events.jsonl (bin/lib/events.mjs) and the reviewer's result JSON (kit/.gate/bin/lib/result.mjs).
// Left out, on purpose: the three hook scripts (packs/pstack/bin/transcript-copy.mjs, bin/lib/socket-hook.mjs, bin/lib/statusline-hook.mjs)
// run as hash-named copies in a Lead's pane for days and import only node: modules, so each reads its own hook input; the kit's
// claude-reviewer.mjs is copied into every repository and cannot import bin/lib, and is already the kit's one Claude file, behind
// result.mjs. Codex's formats are not here (no second harness now): quota.mjs's codexRow and the reader's `turn.completed` keep them.
// It imports nothing from bin/lib but prices.json and redact.mjs, so it stays out of the import ring of factory.mjs, colly-status.mjs,
// ledger.mjs and queue.mjs (bin/lib/node.mjs).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, redactDeep } from './redact.mjs';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prices.json'), 'utf8')).models;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---- the stream of `claude -p` ---------------------------------------------------------------------------------------------

/** Whether a stream event is one resultOf reads: the `system`/`init` event and each `result`. bin/seat keeps only these while it runs. */
export const keptEvent = (e) => e?.type === 'result' || (e?.type === 'system' && e.subtype === 'init');

/** What a session's events say, for its record (seat.mjs recordOf): { session, model, turns, duration_ms, total_cost_usd, structured, ended,
 * error }, null where they say nothing. A run can hold several results (a background task that ends starts another query): turns and duration
 * add up; the cost is cumulative, so the last result's is the whole; the report is the last one that has it. `error` is the failed result's
 * reason ('' when it gives none), or null when the last result did not fail. */
export function resultOf(events) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const results = events.filter((e) => e.type === 'result');
  const result = results.at(-1) ?? null;
  const sum = (key) => (results.some((r) => typeof r[key] === 'number') ? results.reduce((s, r) => s + (typeof r[key] === 'number' ? r[key] : 0), 0) : null);
  const models = result?.modelUsage ? Object.keys(result.modelUsage) : [];
  return {
    session: result?.session_id ?? init?.session_id ?? null,
    model: models.length ? models.join(',') : (init?.model ?? null),
    turns: sum('num_turns'),
    duration_ms: sum('duration_ms'),
    total_cost_usd: result?.total_cost_usd ?? null,
    structured: results.findLast((r) => r.structured_output !== undefined && r.structured_output !== null)?.structured_output ?? null,
    ended: result?.is_error ? 'error' : result ? (result.subtype ?? 'result') : 'no-result',
    error: result?.is_error ? result.result || result.errors?.join('; ') || result.terminal_reason || '' : null,
  };
}

// ---- rate limits -----------------------------------------------------------------------------------------------------------

/** The text that marks a rate-limit line of a stream-json log: accountEvent (seat.mjs) and shared-records.mjs select those lines by it. */
export const RATE_LIMIT_LINE = '"type":"rate_limit_event"';

/** The name of that source, as a quota row and the digest's table show it. */
export const RATE_SOURCE = 'rate_limit_event';

/** One window as { use, resetsAt }, use a fraction 0 to 1; null when the report holds no number for it. */
const windowOf = (use, resetsAt) => (num(use) === null ? null : { use, resetsAt: num(resetsAt) });

/** The windows of a rate_limit_info (source 1: utilization is a fraction). A window is rejected only by `status`: the
 * recorded events carry overageStatus "rejected" while status is "allowed", and that is the extra usage, not the window. */
export function windowsOf(info) {
  const w = info?.unifiedWindows ?? {};
  return {
    five_hour: windowOf(w.five_hour?.utilization, w.five_hour?.resetsAt),
    seven_day: windowOf(w.seven_day?.utilization, w.seven_day?.resetsAt),
    status: info?.status ?? null,
    type: info?.rateLimitType ?? null,
    rejected: info?.status === 'rejected',
  };
}

/** One rate-limit line as { windows, resetsAt } (windowsOf's windows; the reset of the window the event is about, in seconds), or null for a
 * line that does not parse or reports no seven-day use: accountEvent takes the newest log whose last such line reports one. */
export function rateReadingOf(line) {
  let info;
  try {
    info = JSON.parse(line).rate_limit_info;
  } catch {
    return null;
  }
  const u = info?.unifiedWindows?.seven_day?.utilization;
  if (u === undefined || u === null || u === '') return null;
  return { windows: windowsOf(info), resetsAt: num(info.resetsAt) };
}

/** The windows of one status-line record (source 3): used_percentage is a percentage by its name, so it is divided by 100.
 * Only 0 has been seen (#62), so that scale is not yet measured above 0. null for a record that has no rate_limits, as the
 * ones before the first API response do. */
export function statusLineWindows(record) {
  const r = record?.rate_limits;
  if (!r || typeof r !== 'object') return null;
  const pct = (w) => (num(w?.used_percentage) === null ? null : windowOf(w.used_percentage / 100, w.resets_at));
  return { five_hour: pct(r.five_hour), seven_day: pct(r.seven_day), status: null, type: null, rejected: false };
}

// ---- prices and logs -------------------------------------------------------------------------------------------------------

/** Dollars of one assistant message's usage at API prices; null for a model the table does not price. */
export function costOf(model, usage) {
  const price = PRICES[model];
  if (!price || !usage) return null;
  const w1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens ?? 0) - w1h);
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      w5m * price.write5m +
      w1h * price.write1h +
      (usage.cache_read_input_tokens ?? 0) * price.read) /
    1e6
  );
}

/** What one stream-json log (or a Lead's transcript copy) says, from its events alone; null where it says nothing. Tokens
 * add each assistant message once (by id): `tokensIn` is input, cache-creation and cache-read tokens, `tokensOut` output;
 * `ctx` is the last message's input side. A resumed log holds several results: turns add up, the cost is the last total. */
export function parseLog(text) {
  const messages = new Map();
  const results = [];
  let init = null;
  let rate = null;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e?.type === 'system' && e.subtype === 'init') init = e;
    else if (e?.type === 'assistant' && e.message?.usage) messages.set(e.message.id ?? e.uuid ?? messages.size, e.message);
    else if (e?.type === 'result') results.push(e);
    else if (e?.type === 'rate_limit_event' && e.rate_limit_info) rate = e.rate_limit_info;
  }
  const usages = [...messages.values()];
  const side = (u) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const last = results.at(-1) ?? null;
  // A <synthetic> message (Claude Code's own, with no usage) says nothing of the model, the context or the price.
  const real = usages.filter((m) => m.model !== '<synthetic>');
  const priced = real.map((m) => costOf(m.model, m.usage));
  const turnSum = results.some((r) => num(r.num_turns) !== null) ? results.reduce((s, r) => s + (num(r.num_turns) ?? 0), 0) : null;
  return {
    model: init?.model ?? real.at(-1)?.model ?? null,
    cwd: init?.cwd ?? null,
    turns: turnSum ?? (usages.length ? usages.length : null),
    ctx: real.length ? side(real.at(-1).usage) : null,
    tokensIn: usages.length ? usages.reduce((s, m) => s + side(m.usage), 0) : null,
    tokensOut: usages.length ? usages.reduce((s, m) => s + (m.usage.output_tokens ?? 0), 0) : null,
    cost: num(last?.total_cost_usd),
    estCost: real.length && priced.every((c) => c !== null) ? priced.reduce((s, c) => s + c, 0) : null,
    isError: typeof last?.is_error === 'boolean' ? last.is_error : null,
    apiStatus: last?.api_error_status ?? null,
    rate: rate ? { ...windowsOf(rate), resetsAt: num(rate.resetsAt) } : null,
  };
}

// ---- a session's transcripts under a profile -------------------------------------------------------------------------------

function jsonlFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name.endsWith('.jsonl')) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** One assistant entry of a transcript in the factory's shape: { key, session, branch, cwd, model, dollars }, `key` its message's id (else
 * its request's, else its own), `dollars` its price at API rates (costOf), null when the model is not priced. */
export const entryOf = (e) => ({
  key: e.message.id ?? e.requestId ?? e.uuid,
  session: e.sessionId,
  branch: e.gitBranch,
  cwd: e.cwd,
  model: e.message.model,
  dollars: costOf(e.message.model, e.message.usage),
});

/** Every assistant entry with usage in a profile folder's session files, in file order, as entryOf gives it. */
export function* assistantEntries(profileDir) {
  for (const file of jsonlFiles(join(profileDir, 'projects'))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'assistant' && entry.message?.usage) yield entryOf(entry);
    }
  }
}

/** The fields of an assistant entry the canary checks, those entryOf and costOf read for a cost: a path, or paths of which one is enough.
 * entryOf also reads `sessionId`, which only the ledger's repoCosts uses and the canary has never checked. */
export const READS = [
  'type',
  'gitBranch',
  'cwd',
  'message.model',
  'message.usage.input_tokens',
  'message.usage.output_tokens',
  'message.usage.cache_read_input_tokens',
  'message.usage.cache_creation_input_tokens',
  'message.usage.cache_creation.ephemeral_1h_input_tokens',
  'message.usage.cache_creation.ephemeral_5m_input_tokens',
  'message.id|requestId|uuid',
];
// The canary opens only these objects: message, message.usage and the objects inside usage. Any other object is
// printed as `object` and never opened, so a key it holds (a map keyed by an id, a tool name) cannot reach the output.
const OPENED = (path) => path === 'message' || path === 'message.usage' || path.startsWith('message.usage.');

const valueAt = (entry, path) => path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), entry);
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const has = (e, r) => r.split('|').some((p) => valueAt(e, p) !== undefined && valueAt(e, p) !== null);
/** How many of the newest entries the canary calls `stale` when a field is absent from all of them; `bin/factory-ledger --check` says so. */
export const STALE_RUN = 10;

/** The canary: over the latest `latest` distinct assistant entries of the profile folders (newest files first by
 * modification time), which fields the ledger reads are present in none of them (`missing`), absent from every entry of
 * the newest session file or from the newest 10 entries (`stale`: the format changed lately), absent from some
 * (`partly`), and every key path with its types and counts. It reads values only to learn their type and reports none. */
export function inspect(profileDirs, { latest = 50 } = {}) {
  const dated = [];
  for (const dir of profileDirs)
    for (const file of jsonlFiles(join(dir, 'projects'))) dated.push({ file, time: statSync(file).mtimeMs });
  dated.sort((a, b) => a.time - b.time);
  const entries = [];
  for (const { file } of dated) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'assistant' && e.message?.usage) entries.push({ e, file });
      } catch {}
    }
  }
  const seen = new Set();
  const distinct = entries.filter(({ e }) => {
    const key = e.message.id ?? e.requestId ?? e.uuid;
    return key === undefined || !seen.has(key) ? (seen.add(key), true) : false;
  });
  const sampleItems = distinct.slice(-latest);
  const sample = sampleItems.map((x) => x.e);
  const newestFile = dated.length ? dated[dated.length - 1].file : null;
  const inNewest = distinct.filter((x) => x.file === newestFile).map((x) => x.e);
  const paths = new Map();
  const walk = (value, path, seenHere) => {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      const row = paths.get(p) ?? { types: new Set(), count: 0 };
      row.types.add(kind(v));
      if (!seenHere.has(p)) row.count += 1;
      seenHere.add(p);
      paths.set(p, row);
      if (v && typeof v === 'object' && !Array.isArray(v) && OPENED(p)) walk(v, p, seenHere);
    }
  };
  for (const e of sample) walk(e, '', new Set());
  const missing = READS.filter((r) => !sample.some((e) => has(e, r)));
  const newest = sample.slice(-STALE_RUN);
  const stale = READS.filter(
    (r) => !missing.includes(r) && ((inNewest.length && inNewest.every((e) => !has(e, r))) || (newest.length && newest.every((e) => !has(e, r)))),
  );
  const partly = READS.filter((r) => !missing.includes(r) && !stale.includes(r) && sample.some((e) => !has(e, r))).map((r) => `${r} (${sample.filter((e) => has(e, r)).length}/${sample.length})`);
  return {
    entries: sample.length,
    missing,
    stale,
    partly,
    paths: [...paths].map(([path, r]) => ({ path, types: [...r.types].sort(), count: r.count })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

// ---- a Lead's hook events --------------------------------------------------------------------------------------------------

const LOGIN_MS = 60_000;

// The Lead's state from its newest hook event (packs/pstack/bin/transcript-copy.mjs writes state.json): Claude Code's Notification
// types and the hooks the launcher sets. It is data, to be adjusted from what real Leads send; an event it does not name leaves the
// state the Lead's log gives.
const LEAD_STATES = {
  'Notification:permission_prompt': 'waiting',
  'Notification:elicitation_dialog': 'waiting',
  'Notification:idle_prompt': 'idle',
  Stop: 'idle',
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
};

/** The Lead's state from state.json's event and its process: { state, stateAt, waitNote? }, or null to leave it to the log. An event
 * older than the process belongs to an earlier session. A process that carries the new SessionStart hook, is over a minute old and
 * has run none of its hooks waits at the login or the folder trust. That is an inference: whether SessionStart fires only after the
 * trust dialog has not been seen yet; it is seen at zalo-gateway's first Lead start. A Lead started before the hook existed never
 * gets this line. */
export function leadStateOf({ event, command, ageMs, now }) {
  const at = event ? Date.parse(event.at) : NaN;
  if (Number.isFinite(at) && (ageMs == null || at >= now - ageMs)) {
    const state = LEAD_STATES[event.type ? `${event.event}:${event.type}` : event.event];
    return state ? { state, stateAt: at } : null;
  }
  return /"SessionStart"/.test(command) && ageMs > LOGIN_MS ? { state: 'waiting', waitNote: 'login or folder trust?' } : null;
}

// ---- the reader's input ----------------------------------------------------------------------------------------------------

/** What one stream line says, reduced: the assistant's text (redacted) and the names of the tools it called, as `[tool <name>]`. The one
 * input kept is that of `StructuredOutput`, which follows its line as compact JSON (redacted): every seat reports through that call, so
 * the report, with its refusals, lapses and work found outside the issue, is in no text item. A line of any other type, a subagent's (a
 * sidechain, or a message with a parent tool use), a thinking item and any other tool's input are left out. */
export function reduceLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return '';
  }
  if (o?.type !== 'assistant' || o.isSidechain === true || (o.parent_tool_use_id ?? null) !== null) return '';
  const content = o.message?.content;
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return items
    .flatMap((i) => {
      if (i?.type === 'text' && typeof i.text === 'string') return [redact(i.text)];
      if (i?.type !== 'tool_use' || typeof i.name !== 'string') return [];
      const head = `[tool ${redact(i.name)}]`;
      if (i.name !== 'StructuredOutput' || i.input === undefined) return [head];
      try {
        return [head, redact(typeof i.input === 'string' ? i.input : JSON.stringify(redactDeep(i.input)))];
      } catch {
        // An input nested too deep to walk (a RangeError) gives the tool line alone: one line must never crash the pass, whose cursor
        // would then never move past it.
        return [head];
      }
    })
    .join('\n');
}

/** The reduction of a stream's text (either kind). */
export const reduce = (text) => String(text).split('\n').map(reduceLine).filter(Boolean).join('\n');

/** Whether a stream or transcript line ends a turn of the session's own, not a subagent's (no sidechain, no parent tool use): an assistant
 * message that stopped at `end_turn`, a `result`, or a `system`/`turn_duration` line. The reader's silence watch adds Codex's own end. */
export const turnEnded = (r) =>
  r?.isSidechain !== true && (r?.parent_tool_use_id ?? null) === null &&
  (r?.message?.stop_reason === 'end_turn' || r?.type === 'result' || (r?.type === 'system' && r?.subtype === 'turn_duration'));

// ---- the login -------------------------------------------------------------------------------------------------------------

/** What claude auth status prints, reduced to the logged-in flag, the local part of the address and the plan; the rest is dropped. */
export function readClaude(text) {
  let j;
  try {
    j = JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    return null;
  }
  if (typeof j?.loggedIn !== 'boolean') return null;
  const email = typeof j.email === 'string' ? j.email.split('@')[0] : null;
  return { loggedIn: j.loggedIn, account: email || null, plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : null };
}
