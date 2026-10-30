// The quota windows (#63, K2 option B): what Claude Code itself reports, and nothing else. Source 1 is the rate_limit_event of
// a stream-json log, source 3 the status line's rate_limits (probes/results.md, #62). Nothing here reads a credential, a
// profile or the network; a window that was not reported is null, never a guess.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { SEATS, resetPassed, seatEvent } from './seat.mjs';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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

/** The windows of one status-line record (source 3): used_percentage is a percentage by its name, so it is divided by 100.
 * Only 0 has been seen (#62), so that scale is not yet measured above 0. null for a record that has no rate_limits, as the
 * ones before the first API response do. */
export function statusLineWindows(record) {
  const r = record?.rate_limits;
  if (!r || typeof r !== 'object') return null;
  const pct = (w) => (num(w?.used_percentage) === null ? null : windowOf(w.used_percentage / 100, w.resets_at));
  return { five_hour: pct(r.five_hour), seven_day: pct(r.seven_day), status: null, type: null, rejected: false };
}

/** The last record of a status-line file that holds rate_limits, as { windows, asOf } (the record's `at`, else the file's
 * time), or null when the file is absent, unreadable or holds none. The file is one that a status-line command already
 * writes, one JSON record a line; this reads nothing else. */
export function lastStatusLine(file) {
  let text;
  let mtime;
  try {
    text = readFileSync(file, 'utf8');
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  for (const line of text.split('\n').reverse()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const windows = statusLineWindows(record);
    if (windows) return { windows, asOf: Date.parse(record.at) || mtime };
  }
  return null;
}

/** The rows of the table: seat 1 and seat 2 of bin/seat from their logs under runs (source 1), then one for each
 * status-line file (source 3). A row's windows are null when nothing was reported: the profile shows its windows only
 * after a session ran on it. A status-line record names no profile, so its row is named by its file. */
export function quotaRows({ runs, statusFiles = [] }) {
  const rows = Object.keys(SEATS).map((n) => {
    const e = seatEvent(runs, n);
    return { profile: `seat ${n}`, source: 'rate_limit_event', seat: Number(n), windows: e ? windowsOf(e.info) : null, resetsAt: num(e?.info.resetsAt), asOf: e?.asOf ?? null, missing: 'no session has run on it' };
  });
  for (const file of statusFiles) {
    const s = lastStatusLine(file);
    rows.push({ profile: `status line ${basename(file)}`, source: 'status line', seat: null, windows: s?.windows ?? null, asOf: s?.asOf ?? null, missing: 'no record with rate_limits' });
  }
  return rows;
}

const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const percent = (use) => `${Math.round(use * 1000) / 10}%`;
const over = (w, now) => resetPassed(w?.resetsAt, now);

/** The section of the digest and of `bin/factory-ledger --quota`: the table and what it cannot show. */
export function quotaSection(rows, { now = Date.now() } = {}) {
  const use = (w) => (w ? `${percent(w.use)}${over(w, now) ? ' (reset since)' : ''}` : '–');
  const resets = (w) => (w?.resetsAt != null ? fmt(w.resetsAt * 1000) : '–');
  const lines = [
    '## Quota windows (what Claude Code itself reports)',
    '',
    '| Profile | Source | Five-hour use | Five-hour resets (UTC) | Seven-day use | Seven-day resets (UTC) | Status | As of (UTC) |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const w = r.windows;
    const status = !w ? r.missing : w.rejected ? `rejected (${w.type ?? 'window'})` : (w.status ?? '–');
    lines.push(`| ${r.profile} | ${r.source} | ${use(w?.five_hour)} | ${resets(w?.five_hour)} | ${use(w?.seven_day)} | ${resets(w?.seven_day)} | ${status} | ${r.asOf ? fmt(r.asOf) : '–'} |`);
  }
  lines.push(
    '',
    'A seat shows its windows only after a session ran on it through bin/seat; the figures are those of its newest log, as of the log\'s time. A window marked "reset since" ended after that report, so its use is not current.',
    ...(rows.some((r) => r.source === 'status line') ? [] : ['No status-line file was given (FACTORY_STATUSLINE or --statusline), so source 3 is not shown.']),
  );
  return lines;
}

/** The alert lines for the rows, at most one for each window, while its reset time has not passed: the window Claude Code
 * rejected, else one Claude Code itself warns of (status allowed_warning). A use alone gives none, however high: the factory
 * keeps no threshold of its own (#194). A row with no windows, or one Claude Code neither rejected nor warned of, gives nothing. */
export function alertLines(rows, { now = Date.now() } = {}) {
  const out = [];
  const name = { five_hour: 'five-hour', seven_day: 'seven-day' };
  for (const r of rows) {
    const w = r.windows;
    if (!w) continue;
    const when = (x) => (x?.resetsAt != null ? ` (resets ${fmt(x.resetsAt * 1000)} UTC)` : '');
    // The rejected or warned window is the event's rateLimitType; one of another type has no window of its own, and falls back to the event's resetsAt.
    const flagged = w.rejected || w.status === 'allowed_warning';
    const own = w[w.type] ?? (r.resetsAt != null ? { resetsAt: r.resetsAt } : null);
    if (flagged && !w[w.type] && !over(own, now)) out.push(`factory: quota: ${r.profile}: ${name[w.type] ?? 'a'} window ${w.rejected ? 'rejected' : 'warned of by Claude Code'}${when(own)}`);
    for (const key of ['five_hour', 'seven_day']) {
      const x = w[key];
      if (!x || over(x, now)) continue;
      if (w.rejected && w.type === key) out.push(`factory: quota: ${r.profile}: ${name[key]} window rejected${when(x)}`);
      else if (w.status === 'allowed_warning' && w.type === key) out.push(`factory: quota: ${r.profile}: ${name[key]} window under a warning from Claude Code, at ${percent(x.use)}${when(x)}`);
    }
  }
  return out;
}

/** The table of role, model and seat for the sessions (the kept records of ledger.keptSessions), with an account where one
 * was given by seat: nothing in a log names the account. */
export function roleMapLines(kept, accounts = {}) {
  const groups = new Map();
  for (const r of kept) {
    const key = [r.role, r.model, r.seat].join('\t');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  if (!groups.size) return ['- None.'];
  return [
    '| Role | Model | Seat | Sessions | Account |',
    '|---|---|---|---|---|',
    ...[...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, n]) => {
      const [role, model, seat] = key.split('\t');
      return `| ${role} | ${model} | ${seat} | ${n} | ${accounts[seat] ?? 'not recorded'} |`;
    }),
  ];
}

/** FACTORY_SEAT_ACCOUNTS, "1=name,2=name", as { 1: 'name', 2: 'name' }: the account of a seat, which the Lead or the Human gives. */
export function accountsOf(text) {
  return Object.fromEntries((text ?? '').split(',').map((p) => p.split('=').map((s) => s.trim())).filter(([k, v]) => k && v));
}
