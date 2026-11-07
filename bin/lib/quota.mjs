// The quota windows (#63, K2 option B): what Claude Code itself reports, and nothing else. Source 1 is the rate_limit_event of
// a stream-json log, source 3 the status line's rate_limits (#62); Codex refusals use its JSON errors (#474). Nothing here reads a credential, a
// profile or the network; a window that was not reported is null, never a guess. Claude Code's two formats are read by claude-code.mjs
// (INN-39 item 3), which gives the windows here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { RATE_SOURCE, statusLineWindows } from './claude-code.mjs';
import { accountEvent, resetPassed, runFiles } from './seat.mjs';
import { teamAccounts } from './teams.mjs';
import { seatAccounts } from './token.mjs';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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

/** Codex has no factory seat launcher. Read a supplied JSON log path, with the same .account and .seat
 * sidecars as bin/seat: run.jsonl needs run.account and run.seat, written by the Lead for that run.
 * Missing identity is reported as "not recorded". Never infer an account from a directory or read a profile. */
export function codexRow(file) {
  let records;
  try {
    records = readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return null; }
  if (!records.some((r) => ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(r.type))) return null;
  const metadata = (ext) => {
    try { return readFileSync(file.replace(/\.jsonl$/, ext), 'utf8').trim() || 'not recorded'; }
    catch { return 'not recorded'; }
  };
  const account = metadata('.account');
  const seat = metadata('.seat');
  const last = records.findLast((r) => ['turn.completed', 'turn.failed', 'error'].includes(r.type));
  const message = last?.type === 'turn.completed' ? '' : String(last?.error?.message ?? last?.message ?? last?.error ?? '');
  const rejected = /usage limit/i.test(message);
  const capacity = /model.*at capacity/i.test(message) && !rejected;
  return { file, account, seat, profile: `account ${account}, seat ${seat}`, source: 'Codex',
    windows: { five_hour: null, seven_day: null, rejected, status: capacity ? 'capacity' : null, type: null },
    resetsAt: num(last?.error?.resets_at ?? last?.resets_at), message,
    asOf: statSync(file).mtimeMs };
}

/** The rows of the table (#311): one for each account (`account <name>`) from the runs under runs (source 1), then one for each
 * status-line file (source 3). The accounts are given, else those of the teams the accounts file in state names (root is where the
 * onboarded repositories are). A run with no .account file is read through its seat's old row. A row's windows are null when nothing
 * was reported: an account shows its windows only after a session ran on it. A status-line record names no profile, so its row is
 * named by its file. */
export function quotaRows({ runs, state = null, root, accounts = null, statusFiles = [] }) {
  const seatRows = state ? seatAccounts(state) : {};
  const rows = (accounts ?? (state ? teamAccounts(state, root) : [])).map((account) => {
    const e = accountEvent(runs, account, seatRows);
    return { profile: `account ${account}`, source: RATE_SOURCE, account, windows: e?.windows ?? null, resetsAt: e?.resetsAt ?? null, asOf: e?.asOf ?? null, missing: 'no session has run on it' };
  });
  // Both the factory's run folders and hand-run <repo>/<seat>/run.jsonl folders. No profile traversal.
  let folders = [];
  try { folders = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(runs, d.name)); } catch {}
  const files = new Set([...runFiles(runs, '.jsonl'), ...folders.flatMap((dir) => runFiles(dir, '.jsonl'))]);
  for (const file of files) {
    const row = codexRow(file);
    if (row) rows.push(row);
  }
  for (const file of statusFiles) {
    const s = lastStatusLine(file);
    rows.push({ profile: `status line ${basename(file)}`, source: 'status line', account: null, windows: s?.windows ?? null, asOf: s?.asOf ?? null, missing: 'no record with rate_limits' });
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
    'An account shows its windows only after a session ran on it through bin/seat; the figures are those of its newest log, as of the log\'s time. A window marked "reset since" ended after that report, so its use is not current.',
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
    if (r.source === 'Codex') {
      if (w.status === 'capacity') out.push(`factory: capacity: ${r.profile}: Model at capacity; retry later`);
      else if (w.rejected && !over(r, now)) {
        const reset = r.resetsAt != null ? ` (resets ${fmt(r.resetsAt * 1000)} UTC)` : `: ${r.message}`;
        out.push(`factory: quota: ${r.profile}: usage limit rejected${reset}`);
      }
      continue;
    }
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

/** The table of role, model and seat for the sessions (the kept records of ledger.keptSessions). The account is the record's own
 * (#311); an older record has none, and takes its seat's old row from accounts ({ seat: account }), else "not recorded". */
export function roleMapLines(kept, accounts = {}) {
  const groups = new Map();
  for (const r of kept) {
    const key = [r.role, r.model, r.seat, r.account ?? accounts[r.seat] ?? 'not recorded'].join('\t');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  if (!groups.size) return ['- None.'];
  return [
    '| Role | Model | Seat | Sessions | Account |',
    '|---|---|---|---|---|',
    ...[...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, n]) => {
      const [role, model, seat, account] = key.split('\t');
      return `| ${role} | ${model} | ${seat} | ${n} | ${account} |`;
    }),
  ];
}

/** The account of each seat as { 1: 'name', 2: 'name' }, from the accounts file in the state folder (#178), the one source of a
 * row's account. */
export function accountsOf(state) {
  return seatAccounts(state);
}
