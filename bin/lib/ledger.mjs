// The factory's ledger: one row per task, from GitHub and the records of bin/seat, with no model; and the
// weekly digest built from those rows, every rate with its count and its 95% Wilson interval. A task is an
// issue labelled task, from its assignment (the label) to its close, with every pull request that closes it; a pull
// request that closes no task is a task of its own, from its opening. Cost is API-equivalent usage, never cash.
// See bin/factory-ledger for the arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredChecks } from '../../kit/.gate/bin/lib/policy.mjs';
import { coverage } from '../../packs/pstack/scripts/lib/verdict.mjs';
import { accountsOf, quotaRows, quotaSection, roleMapLines } from './quota.mjs';
import { job, plist } from './queue.mjs';
import { readSessions } from './records.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PRICES = JSON.parse(readFileSync(join(here, 'prices.json'), 'utf8')).models;
export const REQUIRED = requiredChecks(join(here, '../../kit'));

/** The 95% Wilson interval of k successes in n, as fractions; null when n is 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** "k/n (p%; 95%: a–b%)", or "none yet (n=0)". */
export function rate(k, n) {
  if (!n) return 'none yet (n=0)';
  const [a, b] = wilson(k, n);
  return `${k}/${n} (${pct(k / n)}; 95% CI: ${pct(a)}–${pct(b)})`;
}

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

/** Every assistant entry with usage in a profile folder's session files, in file order, parsed. */
function* assistantEntries(profileDir) {
  for (const file of jsonlFiles(join(profileDir, 'projects'))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'assistant' && entry.message?.usage) yield entry;
    }
  }
}

/** Adds an assistant entry's cost to its git branch's row; an entry without a branch, or seen before, adds nothing. */
export function charge(byBranch, seen, entry) {
  const message = entry.message;
  if (!entry.gitBranch) return;
  const key = message.id ?? entry.requestId ?? entry.uuid;
  if (seen.has(key)) return;
  seen.add(key);
  const row = byBranch.get(entry.gitBranch) ?? { dollars: 0, models: new Set(), unpriced: new Set() };
  const dollars = costOf(message.model, message.usage);
  if (dollars === null) row.unpriced.add(message.model);
  else row.dollars += dollars;
  row.models.add(message.model);
  byBranch.set(entry.gitBranch, row);
}

/** Cost per git branch from a Claude Code profile's session files: dollars, models, and unpriced models. */
export function branchCosts(profileDir) {
  const byBranch = new Map();
  const seen = new Set();
  for (const entry of assistantEntries(profileDir)) charge(byBranch, seen, entry);
  return byBranch;
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Whether a working directory is the folder or under it, by path containment on resolved paths: `..` and `//` are
 * normalised, a symlink on either side is followed when the path exists. Case is exact: APFS is case-insensitive, but
 * the ledger does not guess which spelling a session used. */
function within(cwd, folder) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  const rel = relative(folder, real(cwd));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Cost per git branch of one repository: the entries of the extra profile folders whose working directory is the
 * repository's folder <root>/<name> or under it (a worktree), each once, plus `seat`, the branch rows of its seat sessions
 * (seatCosts). A session in `recorded` (the ids of the seat records) is charged from its record only: its entries in the
 * folders are skipped, whether or not the record names a repository. No repository profile is read (#205). Null when there is no folder to read and no seat session. */
export function repoCosts({ extra = [], root, name, seat = null, recorded = new Set() }) {
  const dir = real(join(root, name));
  const byBranch = new Map();
  const seen = new Set();
  let any = false;
  for (const folder of extra) {
    if (!existsSync(folder)) continue;
    any = true;
    for (const entry of assistantEntries(folder)) if (!recorded.has(entry.sessionId) && within(entry.cwd, dir)) charge(byBranch, seen, entry);
  }
  for (const [branch, s] of seat ?? []) {
    any = true;
    const row = byBranch.get(branch) ?? { dollars: 0, models: new Set(), unpriced: new Set() };
    row.dollars += s.dollars;
    for (const m of s.models) row.models.add(m);
    byBranch.set(branch, row);
  }
  return any ? byBranch : null;
}

/** The entries of the extra profile folders that record no working directory: charged to no repository by folder.
 * Their number and API-equivalent dollars, each message once. */
export function unplaced(folders) {
  const seen = new Set();
  const total = { entries: 0, dollars: 0 };
  for (const folder of folders) {
    for (const entry of existsSync(folder) ? assistantEntries(folder) : []) {
      if (typeof entry.cwd === 'string' && entry.cwd) continue;
      const key = entry.message.id ?? entry.requestId ?? entry.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      total.entries += 1;
      total.dollars += costOf(entry.message.model, entry.message.usage) ?? 0;
    }
  }
  return total;
}

/** The fields of an assistant entry the ledger reads: a path, or paths of which one is enough. */
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
const STALE_RUN = 10;

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

/** One line for the digest when the canary could not read what the ledger needs; null when it can, or has nothing. */
export function canaryLine(report) {
  const names = [...report.missing, ...report.stale];
  if (!report.entries || !names.length) return null;
  return `Warning: the ledger could not read the field(s) ${[...new Set(names)].join(', ')} in the latest Claude Code sessions, so cost may be missing (run bin/factory-ledger --check).`;
}

/** Whether a task that started at start and ended at end (null while open) was alive in the window [from, to]: it
 * started in it, was open at its end, or ended inside it. */
export function inWindow(start, end, from, to) {
  return Date.parse(start) <= to && (!end || Date.parse(end) >= from);
}

/** One pull request's row, as the GraphQL query below returns it; a task of its own when it closes no task. patchOf
 * gives the merged head's patch-id from a local clone, or null; a merged pull request's live is whether a live
 * verdict covered that head (scripts/live-verify), null when that cannot be told. */
export function rowOf(repo, pr, { human, costs, profile, patchOf = () => null }) {
  const labels = pr.labels.nodes.map((l) => l.name);
  const tiers = labels.map((l) => /^tier-([123])$/.exec(l)?.[1]).filter(Boolean).map(Number);
  const events = pr.timelineItems.nodes;
  const reasons = [];
  if (pr.reviews.nodes.some((r) => r.author?.login === human && ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state))) reasons.push('reviewed');
  if (events.some((e) => e.__typename === 'LabeledEvent' && e.label?.name === 'needs-human') || labels.includes('needs-human')) reasons.push('needs-human');
  const raised = events.some((e) => e.__typename === 'LabeledEvent' && e.label?.name === 'raised') || labels.includes('raised');
  let byRule = false;
  if (pr.mergedAt) {
    let mergedBy = null;
    for (const e of events) {
      if (e.__typename === 'AutoMergeEnabledEvent') byRule = true;
      if (e.__typename === 'AutoMergeDisabledEvent') byRule = false;
      if (e.__typename === 'MergedEvent') {
        mergedBy = e.actor?.login ?? null;
        break;
      }
    }
    // A merge by a team's coordinator, under the agents' login, is a team merge; only the Human's own merge, or one whose
    // actor GitHub does not name, is his touch.
    if (!byRule && (mergedBy === null || mergedBy.toLowerCase() === String(human).toLowerCase())) reasons.push('manual merge');
  }
  // A round is a commit the gate judged that someone wrote; the queue's merges of main into the branch are not rounds.
  const judged = pr.commits.nodes
    .filter((c) => (c.commit.parents?.totalCount ?? 1) < 2)
    .map((c) => ({
      oid: c.commit.oid,
      runs: c.commit.checkSuites.nodes.filter((s) => s.app?.slug === 'github-actions').flatMap((s) => s.checkRuns.nodes),
    }))
    .filter((c) => c.runs.some((r) => r.name === 'verify'));
  const first = judged[0];
  const firstPass = first ? REQUIRED.every((name) => first.runs.some((r) => r.name === name && r.conclusion === 'SUCCESS')) : null;
  const branch = costs?.get(pr.headRefName);
  let cost = null;
  let costNote;
  if (!profile) costNote = 'no profile';
  else if (!branch) costNote = 'no session on the branch';
  else {
    cost = branch.dollars;
    costNote = branch.unpriced.size ? `unpriced: ${[...branch.unpriced].join(', ')}` : '';
  }
  const comments = pr.comments?.nodes ?? [];
  const lv = coverage(comments, { author: pr.author?.login, head: pr.headRefOid, patch: pr.mergedAt ? patchOf(pr.mergeCommit?.oid, pr.headRefOid) : null });
  const live = pr.mergedAt ? lv.covered : undefined;
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    prs: [pr.number],
    live,
    livePRs: pr.mergedAt ? [{ number: pr.number, title: pr.title, covered: live }] : [],
    merges: pr.mergedAt ? [{ number: pr.number, title: pr.title, body: pr.body ?? '', merged: pr.mergedAt }] : [],
    codexRuns: lv.runs,
    who: [pr.author?.login ?? '?', ...(branch ? [...branch.models].map((m) => m.replace(/^claude-/, '')) : [])].join(' · '),
    tier: tiers.length ? Math.max(...tiers) : null,
    state: pr.mergedAt ? 'landed' : pr.state === 'OPEN' ? 'open' : 'abandoned',
    rounds: judged.length,
    firstPass,
    noRed: /^No-red: .{20,}/m.test(pr.body ?? ''),
    raised,
    touched: reasons.length > 0,
    touchedWhy: reasons.join(', '),
    cost,
    costNote,
    created: pr.createdAt,
    merged: pr.mergedAt,
    hours: pr.mergedAt ? (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 36e5 : null,
  };
}

/** One task's row: an issue labelled task, from its assignment to its close, with the rows of every pull request that
 * closes it. Its cost stays unknown while any of its pull requests' is, and before it has one. */
export function taskRow(repo, issue, prRows) {
  const prs = [...prRows].sort((a, b) => a.created.localeCompare(b.created) || a.number - b.number);
  const assigned = issue.timelineItems.nodes.filter((e) => e.label?.name === 'task').map((e) => e.createdAt).sort()[0] ?? issue.createdAt;
  const landed = prs.find((r) => r.state === 'landed');
  const tiers = prs.map((r) => r.tier).filter((t) => t !== null);
  const unknown = prs.find((r) => r.cost === null);
  const why = [...new Set(prs.flatMap((r) => (r.touchedWhy ? r.touchedWhy.split(', ') : [])))];
  return {
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    prs: prs.map((r) => r.number),
    livePRs: prs.flatMap((r) => r.livePRs ?? []),
    merges: prs.flatMap((r) => r.merges ?? []),
    codexRuns: prs.reduce((sum, r) => sum + (r.codexRuns ?? 0), 0),
    who: prs[0]?.who ?? '?',
    tier: tiers.length ? Math.max(...tiers) : null,
    state: landed ? 'landed' : issue.state === 'OPEN' || prs.some((r) => r.state === 'open') ? 'open' : 'abandoned',
    rounds: prs.reduce((sum, r) => sum + r.rounds, 0),
    firstPass: prs.find((r) => r.firstPass !== null)?.firstPass ?? null,
    noRed: prs.some((r) => r.noRed),
    raised: prs.some((r) => r.raised),
    touched: why.length > 0,
    touchedWhy: why.join(', '),
    cost: !prs.length || unknown ? null : prs.reduce((sum, r) => sum + r.cost, 0),
    costNote: !prs.length ? 'no PR yet' : unknown ? `#${unknown.number}: ${unknown.costNote}` : [...new Set(prs.map((r) => r.costNote).filter(Boolean))].join('; '),
    created: assigned,
    merged: landed?.merged ?? null,
    hours: landed ? (Date.parse(landed.merged) - Date.parse(assigned)) / 36e5 : null,
  };
}

/** What the queue left in its state folder: every `queue-*.failed` file's first line, and the time of the last clean
 * sweep in every `queue-*.ok` file, with a null for each of the ledger's repositories that has no such record (an
 * empty file is none). `missing` is true when the folder itself is not there, so nothing could be checked. */
export function queueState(dir, repos) {
  const missing = !existsSync(dir);
  const names = missing ? [] : readdirSync(dir).sort();
  const first = (file) => readFileSync(join(dir, file), 'utf8').split('\n')[0].trim();
  const ok = names.filter((f) => /^queue-.*\.ok$/.test(f)).map((f) => ({ label: f, at: first(f) })).filter((x) => x.at);
  const known = new Set(ok.map((x) => x.label));
  return {
    dir,
    missing,
    failed: names.filter((f) => /^queue-.*\.failed$/.test(f)).map((f) => ({ file: f, text: first(f) })),
    ok: [...ok, ...repos.filter((repo) => !known.has(`queue-${repo.replace('/', '-')}.ok`)).map((repo) => ({ label: repo, at: null }))],
  };
}

const STATE = { landed: 'merged', open: 'open', abandoned: 'abandoned' };

/** The pull requests of this repository that a merged pull request reverts: the `Reverts #N` and `Reverts <repo>#N`
 * lines of its body, which win when there is any (a line for another repository leaves none); else the one merged
 * pull request, before it, whose title is the revert's `Revert "<title>"`, the latest if several. */
function revertsOf(repo, pr, merged) {
  const lines = [...(pr.body ?? '').matchAll(/^[ \t]*Reverts[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)[ \t]*\.?[ \t]*$/gm)];
  if (lines.length) return lines.filter((m) => !m[1] || m[1].toLowerCase() === repo.toLowerCase()).map((m) => Number(m[2]));
  const title = /^Revert "(.*)"$/s.exec(pr.title)?.[1];
  if (title === undefined) return [];
  const hit = merged.filter((o) => o.title === title && o.number !== pr.number && Date.parse(o.merged) <= Date.parse(pr.merged)).sort((a, b) => b.merged.localeCompare(a.merged))[0];
  return hit ? [hit.number] : [];
}

/** Reverted pull requests in the period [since 00:00, until 23:59:59] (UTC), from the merged pull requests the rows
 * hold. n: those merged in it that are not reverts; k: of them, the ones a revert merged by its end reverts; m: every
 * revert merged in it; reverted: the k, as { repo, number }. */
export function revertCount(rows, { since, until }) {
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T23:59:59Z`);
  const all = new Map();
  for (const r of rows) for (const p of r.merges ?? []) all.set(`${r.repo}#${p.number}`, { ...p, repo: r.repo });
  const byRepo = (repo) => [...all.values()].filter((p) => p.repo === repo);
  const reverts = new Map([...all].map(([key, p]) => [key, revertsOf(p.repo, p, byRepo(p.repo))]).filter(([, t]) => t.length));
  const during = [...all].filter(([, p]) => Date.parse(p.merged) >= from && Date.parse(p.merged) <= to);
  const plain = during.filter(([key]) => !reverts.has(key));
  const undone = new Set();
  for (const [key, targets] of reverts) if (Date.parse(all.get(key).merged) <= to) for (const t of targets) undone.add(`${all.get(key).repo}#${t}`);
  const reverted = plain.filter(([key]) => undone.has(key)).map(([, p]) => ({ repo: p.repo, number: p.number })).sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  return { n: plain.length, k: reverted.length, m: during.filter(([key]) => reverts.has(key)).length, reverted };
}

/** The title of the digest issue for a period. */
export const digestTitle = (since, until) => `Weekly digest ${since} → ${until}`;

export { readSessions };

/** The sessions that ran in the period, one record each: a resumed session's total_cost_usd covers the whole session, so a
 * session counts once, by its last record; the records of one session are never added (#89). */
export function keptSessions(records, since, until) {
  const [from, to] = [Date.parse(`${since}T00:00:00Z`), Date.parse(`${until}T23:59:59Z`)];
  return lastRecords(records.filter((x) => inWindow(x.start, x.end, from, to)));
}

/** One record for each session, its last, in the order the sessions started. */
export function lastRecords(records) {
  const last = new Map();
  for (const r of [...records].sort((a, b) => Date.parse(a.end) - Date.parse(b.end))) last.set(r.session ?? `${r.run}#${r.tag}`, r);
  return [...last.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** The cost of the seat sessions that name a repository and a branch, from every record there is: owner/name, then branch,
 * to { dollars, models } as repoCosts takes it. A session counts once, by its last record (#89); a record with no repository
 * or no branch, or no cost, is charged to nothing (#205). */
export function seatCosts(records) {
  const byRepo = new Map();
  for (const r of lastRecords(records)) {
    if (!r.repo || !r.branch || typeof r.total_cost_usd !== 'number') continue;
    const branches = byRepo.get(r.repo) ?? new Map();
    const row = branches.get(r.branch) ?? { dollars: 0, models: new Set() };
    row.dollars += r.total_cost_usd;
    for (const m of String(r.model ?? '').split(',').filter(Boolean)) row.models.add(m);
    branches.set(r.branch, row);
    byRepo.set(r.repo, branches);
  }
  return byRepo;
}

/** The sessions of the period that no task is charged for, because the record names no repository or no branch. */
export function unchargedSessions(records, since, until) {
  const kept = keptSessions(records, since, until).filter((r) => !r.repo || !r.branch);
  return { count: kept.length, dollars: kept.reduce((sum, r) => sum + (typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0), 0) };
}

/** One line for each session that ran in the period, and the total cost. */
export function sessionLines(records, since, until) {
  const kept = keptSessions(records, since, until);
  const cost = (r) => (typeof r.total_cost_usd === 'number' ? `$${r.total_cost_usd.toFixed(2)}` : '$?');
  return {
    lines: kept.map((r) => `- ${r.role} ${r.tag}, ${r.model}, ${cost(r)}, ${Number(r.minutes).toFixed(1)} min`),
    total: kept.reduce((sum, r) => sum + (typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0), 0),
  };
}

/** The weekly digest, in markdown. */
export function digest(rows, { since, until, secrets = new Map(), canary = null, unplaced: lost = null, queue = null, sessions = null, quota = null, accounts = {} }) {
  const n = rows.length;
  const landed = rows.filter((r) => r.state === 'landed');
  const judged = rows.filter((r) => r.firstPass !== null);
  const costed = rows.filter((r) => r.cost !== null);
  const rounds = rows.filter((r) => r.rounds > 0);
  const reverts = revertCount(rows, { since, until });
  const lines = [
    `# ${digestTitle(since, until)}`,
    '',
    `${n} ${n === 1 ? 'task' : 'tasks'}: ${landed.length} merged, ${rows.filter((r) => r.state === 'open').length} open, ${rows.filter((r) => r.state === 'abandoned').length} abandoned (${rows.filter((r) => r.state === 'abandoned' && !r.prs.length).length} abandoned before a PR).`,
    ...(canary ? ['', canary] : []),
    '',
    '## Waiting for the Human',
    '',
  ];
  const waiting = rows.filter((r) => r.state === 'open' && (r.tier === 3 || r.touchedWhy.includes('needs-human')));
  if (waiting.length) for (const r of waiting) lines.push(`- ${r.repo}#${r.number} ${r.title} — ${r.tier === 3 ? "tier 3, awaiting the Human's approval" : 'needs-human'}`);
  else lines.push('- None.');
  lines.push(
    '',
    '## Rates (counts, rates, 95% Wilson confidence intervals)',
    '',
    `- Tasks merged: ${rate(landed.length, n)}`,
    `- Merged tasks the Human had to touch: ${rate(landed.filter((r) => r.touched).length, landed.length)}`,
    `- PRs reverted: ${rate(reverts.k, reverts.n)}; reverts merged in the period: ${reverts.m}`,
    ...(reverts.n ? [`- Reverted PRs: ${reverts.k ? reverts.reverted.map((p) => `${p.repo}#${p.number}`).join(', ') : 'none'}`] : []),
    `- Green at the first commit the gate judged: ${rate(judged.filter((r) => r.firstPass).length, judged.length)}`,
    `- Used No-red: ${rate(rows.filter((r) => r.noRed).length, n)}`,
    `- Reviewer raised to tier 3 (label raised), by repository: ${[...new Set(rows.map((r) => r.repo))].sort().map((repo) => `${repo} ${rows.filter((r) => r.repo === repo && r.raised).length}`).join(', ') || 'no tasks'}`,
    `- Cost measured: ${rate(costed.length, n)}`,
    ...(lost?.entries ? [`- ${lost.entries} ${lost.entries === 1 ? 'entry' : 'entries'} ($${lost.dollars.toFixed(2)} at API prices) in extra profile folders record no cwd, so they count for no repository, and "no session on the branch" may hide them`] : []),
    `- Average rounds (commits the gate judged): ${rounds.length ? (rounds.reduce((s, r) => s + r.rounds, 0) / rounds.length).toFixed(2) : '–'} (n=${rounds.length})`,
    `- API-equivalent cost per merged task (every attempt added up; not cash): ${costed.length && landed.length ? `$${(costed.reduce((s, r) => s + r.cost, 0) / landed.length).toFixed(2)} (cost measured on ${costed.length}/${n} tasks)` : 'not measurable yet'}`,
    '',
    '## Live verifier (Codex, scripts/live-verify; not a gate input)',
    '',
  );
  const livePRs = rows.flatMap((r) => (r.livePRs ?? []).map((p) => ({ ...p, repo: r.repo })));
  const known = livePRs.filter((p) => p.covered !== null);
  const named = (list) => (list.length ? list.map((p) => `${p.repo}#${p.number}`).join(', ') : 'none');
  const missed = known.filter((p) => !p.covered);
  lines.push(
    `- Merged PRs whose head a live verdict covers: ${rate(known.filter((p) => p.covered).length, known.length)}`,
    `- No covering verdict: ${missed.length ? missed.map((p) => `${p.repo}#${p.number} ${p.title}`).join('; ') : 'none'}`,
    `- Undetermined (patch-id not computable in the clone): ${named(livePRs.filter((p) => p.covered === null))}`,
    `- Codex runs: ${rows.reduce((sum, r) => sum + (r.codexRuns ?? 0), 0)} (the verifier's Codex subscription, paid monthly; no API price, not split by task)`,
    '',
    '## Per task',
    '',
    '| Repo | Task | PR | Who | Tier | Rounds | API cost | Human touched | Outcome |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const cost = r.cost === null ? `? (${r.costNote})` : `$${r.cost.toFixed(2)}${r.costNote ? ` (${r.costNote})` : ''}`;
    lines.push(
      `| ${r.repo.split('/')[1]} | [#${r.number}](${r.url}) ${r.title.replace(/\|/g, '/').slice(0, 60)} | ${r.prs.map((n) => `#${n}`).join(' ') || '–'} | ${r.who} | ${r.tier ?? '?'} | ${r.rounds} | ${cost} | ${r.touched ? `yes (${r.touchedWhy})` : 'no'} | ${STATE[r.state]} |`,
    );
  }
  if (sessions) {
    const { lines: ran, total } = sessionLines(sessions, since, until);
    const uncharged = unchargedSessions(sessions, since, until);
    lines.push('', '## Sessions (bin/seat)', '', ...(ran.length ? [...ran, `- Total: $${total.toFixed(2)} over ${ran.length} ${ran.length === 1 ? 'session' : 'sessions'} (the last record of each; a resumed session's cost is cumulative, so its records are not added)`] : ['- None.']));
    if (uncharged.count) lines.push(`- ${uncharged.count} ${uncharged.count === 1 ? 'session' : 'sessions'} ($${uncharged.dollars.toFixed(2)} at API prices) charged to no task, because the record names no repository and branch`);
  }
  if (quota) lines.push('', ...(quota.error ? ['## Quota windows (what Claude Code itself reports)', '', `- ${quota.error}`] : quotaSection(quota.rows, { now: quota.now })), '', '## Role, model and seat (bin/seat)', '', ...roleMapLines(keptSessions(sessions ?? [], since, until), accounts));
  if (queue) {
    lines.push('', '## Merge queue (bin/factory-queue)', '');
    if (queue.missing) lines.push(`- Cannot check the queue: the state folder ${queue.dir} does not exist (the queue has not run, or FACTORY_STATE is wrong).`);
    else if (queue.failed.length) for (const f of queue.failed) lines.push(`- ${f.file}: ${f.text}`);
    else lines.push('- No .failed files.');
    if (!queue.missing) for (const { label, at } of queue.ok) lines.push(`- Last clean sweep, ${label}: ${at ?? 'no clean sweep recorded'}`);
  }
  if (secrets.size) {
    lines.push('', '## Repository-level secrets (must be 0: the jobs of every branch can read them)', '');
    for (const [repo, names] of secrets) lines.push(`- ${repo}: ${names === null ? 'could not be checked' : names.length ? names.join(', ') : '0'}`);
  }
  lines.push(
    '',
    'Task: an issue labelled task, from the label to the close, with every PR that closes it; a PR that closes no task is a task of its own, from its opening.',
    'API cost: the cost of the bin/seat sessions that ran on the PR\'s branch, as their records name the repository and branch, plus the tokens of the --profile-dir folders by the same branch, at API prices (bin/lib/prices.json). That is usage, not money paid; it does not include the reviewer that runs on GitHub.',
    'Cash: the Claude subscription, paid monthly, not split by task; the verifier\'s Codex subscription is the same. The ledger sees no other cash.',
    'Revert: a merged PR whose body has a line "Reverts #N" or "Reverts <this repository>#N"; only when its body has no "Reverts" line at all, for any repository, is its title Revert "<title of a merged PR>" read; PRs reverted counts the PRs merged in the period, reverts not included, that a revert merged by its end undoes.',
    'Human touched: the Human reviewed it, the label needs-human, or a merge by the Human\'s own login that was not made by auto-merge (a merge by the agents\' login is a team merge).',
  );
  return `${lines.join('\n')}\n`;
}

const QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
number title url body author{login} createdAt mergedAt state headRefName headRefOid mergeCommit{oid}
comments(first:100){nodes{author{login} body}}
closingIssuesReferences(first:10){nodes{number labels(first:20){nodes{name}}}}
labels(first:30){nodes{name}}
reviews(first:50){nodes{author{login} state}}
timelineItems(first:100,itemTypes:[LABELED_EVENT,AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT,MERGED_EVENT]){nodes{__typename ... on LabeledEvent{label{name}} ... on MergedEvent{createdAt actor{login}}}}
commits(first:100){nodes{commit{oid parents{totalCount} checkSuites(first:20){nodes{app{slug} checkRuns(first:40){nodes{name conclusion}}}}}}}}}}`;

const ISSUE = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){
number title url createdAt closedAt state stateReason
timelineItems(first:50,itemTypes:[LABELED_EVENT]){nodes{__typename ... on LabeledEvent{createdAt label{name}}}}
closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number}}}}}`;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The factory's clones under root, by owner/name: a folder with a `.git` and the kit's `.gate/config.sh`, whose
 * `origin` is on github.com. The merge queue (bin/lib/queue.mjs) finds the repositories taken in by the same rule.
 * The name is the origin less one trailing `/` and a trailing `.git`, as bin/onboard takes it. A kit clone whose origin
 * cannot be read, or whose name is not owner/name, is left out and `skip(folder, why)` is called for it. */
export function clonesUnder(root, skip = () => {}) {
  const out = new Map();
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, name);
    if (!existsSync(join(dir, '.gate/config.sh')) || !existsSync(join(dir, '.git'))) continue;
    let url;
    try {
      url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      skip(dir, `origin cannot be read: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
      continue;
    }
    const m = /github\.com[:/](.+)$/.exec(url.replace(/\/$/, '').replace(/\.git$/, ''));
    if (!m) continue;
    if (/^[\w.-]+\/[\w.-]+$/.test(m[1])) out.set(m[1], dir);
    else skip(dir, `origin ${url} does not name owner/name`);
  }
  return out;
}

/** A merged head's patch-id in a clone, as scripts/live-verify computes it: its diff from its merge-base with the
 * main it merged into; null when the clone lacks either commit. */
function patchIn(dir) {
  const git = (args, input) => execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['pipe', 'pipe', 'ignore'] });
  return (merge, head) => {
    if (!dir || !merge || !head) return null;
    try {
      const fork = git(['merge-base', `${merge}^1`, head]).trim();
      return git(['patch-id', '--verbatim'], git(['diff', '--binary', '--no-renames', fork, head])).split(' ')[0].trim() || null;
    } catch {
      return null;
    }
  };
}

/** `--check`: the canary, printed. Exit 1 when a field the ledger reads is missing or stale, or there is nothing to read. */
function check(dirs, latest, extra) {
  const r = inspect(dirs, { latest });
  if (!r.entries) {
    console.log(`ledger check: no assistant entries with usage in ${dirs.length} profile folder(s): ${dirs.join(', ') || 'none named'}`);
    return 1;
  }
  console.log(`ledger check: ${r.entries} assistant entries (the latest) from ${dirs.length} profile folder(s)`);
  const width = Math.max(...r.paths.map((p) => p.path.length));
  for (const p of r.paths) console.log(`  ${p.path.padEnd(width)}  ${p.types.join('|').padEnd(14)}  ${p.count}/${r.entries}`);
  console.log(`missing: ${r.missing.length ? r.missing.join(', ') : 'none'}`);
  if (r.stale.length) console.log(`stale: ${r.stale.join(', ')} (absent from every entry of the newest session file, or from the newest ${STALE_RUN} entries)`);
  if (r.partly.length) console.log(`partly: ${r.partly.join(', ')}`);
  const u = unplaced(extra);
  if (u.entries) console.log(`no cwd: ${u.entries} entries, $${u.dollars.toFixed(2)} in the extra folders, charged to no repository by folder`);
  return r.missing.length || r.stale.length ? 1 : 0;
}

/** The digest's window for a run at `now` (#209): the seven days that end the day before, as local dates, since the
 * job runs on the Mac mini's own Monday morning and launchd cannot compute a date. */
export function lastWeek(now = new Date()) {
  const day = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  return { since: day(7), until: day(1) };
}

/** The digest's own launchd job (#209), `plist [--daemon] --repo owner/name...`: Monday 09:00 in the machine's local
 * time, posting last week's digest to the private repository where the Human reads it. */
function digestJob(argv) {
  const repos = [];
  let daemon = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--daemon') daemon = true;
    else if (argv[i] === '--repo' && /^[\w.-]+\/[\w.-]+$/.test(argv[i + 1] ?? '')) repos.push(argv[++i]);
    else throw new Error(`plist takes --daemon and --repo owner/name, not ${JSON.stringify(argv[i] === '--repo' ? argv[i + 1] ?? '' : argv[i])}`);
  }
  const as = {
    label: 'io.github.tuannd9288.factory.digest',
    tool: 'bin/factory-ledger',
    verb: null,
    args: ['--post', DIGEST_REPO, '--last-week'],
    log: 'digest.log',
    calendar: { Weekday: 1, Hour: 9, Minute: 0 },
    keep: ['FACTORY_ROOT', 'AGENT_PROFILES', 'FACTORY_RUNS', 'FACTORY_PROFILE_DIRS', 'FACTORY_STATUSLINE'],
  };
  process.stdout.write(plist(job(repos, process.env, daemon, as)));
}

const DIGEST_REPO = 'tuannd9288/better-factory';

function main(argv) {
  if (argv[0] === 'plist') return digestJob(argv.slice(1));
  const opts = { repos: [], since: null, until: null, mode: 'digest', post: null, check: false, latest: 50, profileDirs: (process.env.FACTORY_PROFILE_DIRS ?? '').split(':').filter(Boolean), quota: false, statusFiles: (process.env.FACTORY_STATUSLINE ?? '').split(':').filter(Boolean) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') opts.repos.push(argv[++i]);
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--until') opts.until = argv[++i];
    else if (a === '--last-week') opts.lastWeek = true;
    else if (a === '--rows') opts.mode = 'rows';
    else if (a === '--digest') opts.mode = 'digest';
    else if (a === '--post') opts.post = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--quota') opts.quota = true;
    else if (a === '--statusline') opts.statusFiles.push(argv[++i]);
    else if (a === '--latest') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--latest needs a whole number of at least 1');
      opts.latest = n;
    }
    else if (a === '--profile-dir') opts.profileDirs.push(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  const folders = [...new Set(opts.profileDirs)];
  if (opts.check) {
    process.exitCode = check(folders, opts.latest, opts.profileDirs);
    return;
  }
  // The quota is read only by --quota and the digest; a run log that cannot be read gives one line, not a failed ledger.
  const quotaNow = () => {
    const runs = resolve(process.env.FACTORY_RUNS ?? join(process.env.HOME, 'factory-runs'));
    try {
      return { rows: quotaRows({ runs, statusFiles: opts.statusFiles }), now: Date.now() };
    } catch (error) {
      return { error: `The runs folder or a log in it could not be read (${error.code ?? 'error'}), so there is no quota table.` };
    }
  };
  if (opts.quota) {
    const q = quotaNow();
    console.log(q.error ?? quotaSection(q.rows, { now: q.now }).join('\n'));
    return;
  }
  // Nothing of the digest reaches a public repository (#209): the target is read before anything is built or posted.
  if (opts.post) {
    const visibility = JSON.parse(gh(['repo', 'view', opts.post, '--json', 'visibility'])).visibility;
    if (visibility !== 'PRIVATE') throw new Error(`${opts.post} is ${visibility ?? 'of unknown visibility'}, not PRIVATE; the digest lists private tasks, so nothing posted`);
  }
  if (opts.lastWeek) {
    if (opts.since || opts.until) throw new Error('--last-week takes no --since or --until');
    Object.assign(opts, lastWeek());
  }
  const day = (d) => d.toISOString().slice(0, 10);
  opts.until ??= day(new Date());
  opts.since ??= day(new Date(Date.parse(opts.until) - 7 * 864e5));
  const root = process.env.FACTORY_ROOT ?? join(here, '..', '..');
  const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
  const sessions = readSessions(state);
  const seat = seatCosts(sessions);
  const recorded = new Set(sessions.map((r) => r.session).filter(Boolean));
  const human = process.env.FACTORY_HUMAN ?? 'tuannd9288';
  const clones = clonesUnder(root, (folder, why) => console.error(`ledger: skipped ${folder}: ${why}`));
  if (!opts.repos.length) opts.repos = [...clones.keys()];
  if (!opts.repos.length) throw new Error(`no repository under ${root}; pass --repo owner/name`);

  const rows = [];
  const from = Date.parse(`${opts.since}T00:00:00Z`);
  const to = Date.parse(`${opts.until}T23:59:59Z`);
  for (const repo of opts.repos) {
    const [owner, name] = repo.split('/');
    const costs = repoCosts({ extra: opts.profileDirs, root, name, seat: seat.get(repo), recorded });
    const graphql = (query, n) => JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${n}`])).data.repository;
    const list = (path) => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/${path}`])).flat().filter((x) => inWindow(x.created_at, x.closed_at, from, to));
    const pulls = new Map();
    const pull = (n) => {
      if (!pulls.has(n)) {
        const node = graphql(QUERY, n).pullRequest;
        pulls.set(n, { node, row: rowOf(repo, node, { human, costs, profile: true, patchOf: patchIn(clones.get(repo)) }) });
      }
      return pulls.get(n);
    };
    for (const i of list('issues?labels=task&state=all&per_page=100')) {
      if (i.pull_request) continue;
      const node = graphql(ISSUE, i.number).issue;
      const row = taskRow(repo, node, node.closedByPullRequestsReferences.nodes.map((p) => pull(p.number).row));
      if (inWindow(row.created, node.closedAt, from, to)) rows.push(row);
    }
    for (const p of list('pulls?state=all&per_page=100&sort=created&direction=desc')) {
      const { node, row } = pull(p.number);
      if (!node.closingIssuesReferences.nodes.some((i) => i.labels.nodes.some((l) => l.name === 'task'))) rows.push(row);
    }
  }
  rows.sort((a, b) => a.created.localeCompare(b.created));
  if (opts.mode === 'rows') {
    const head = ['repo', 'task', 'prs', 'who', 'tier', 'state', 'rounds', 'first_pass', 'no_red', 'human_touched', 'why', 'cost_usd', 'cost_note', 'hours_to_merge', 'live_verdict', 'codex_runs', 'title'];
    console.log(head.join('\t'));
    for (const r of rows)
      console.log([r.repo, r.number, r.prs.join(' '), r.who, r.tier ?? '', r.state, r.rounds, r.firstPass ?? '', r.noRed, r.touched, r.touchedWhy, r.cost?.toFixed(4) ?? '', r.costNote, r.hours?.toFixed(2) ?? '', (r.livePRs ?? []).map((p) => `#${p.number}:${p.covered === null ? '?' : p.covered ? 'yes' : 'no'}`).join(' '), r.codexRuns ?? 0, r.title].join('\t'));
    return;
  }
  const secrets = new Map();
  for (const repo of opts.repos) {
    try {
      secrets.set(repo, JSON.parse(gh(['api', `repos/${repo}/actions/secrets`])).secrets.map((x) => x.name));
    } catch {
      secrets.set(repo, null);
    }
  }
  const report = inspect(folders, { latest: opts.latest });
  const text = digest(rows, { ...opts, secrets, canary: canaryLine(report), queue: queueState(state, opts.repos), unplaced: unplaced(opts.profileDirs), sessions, quota: quotaNow(), accounts: accountsOf(state) });
  if (!opts.post) {
    process.stdout.write(text);
    return;
  }
  const file = join(mkdtempSync(join(tmpdir(), 'digest-')), 'digest.md');
  writeFileSync(file, text);
  gh(['label', 'create', 'digest', '--repo', opts.post, '--force']);
  const title = digestTitle(opts.since, opts.until);
  // Neither --search nor --label: both go through GitHub's search index, which lags behind a new issue. A plain list
  // reads the repository, and the titles are compared here.
  const all = JSON.parse(gh(['issue', 'list', '--repo', opts.post, '--state', 'all', '--limit', '1000', '--json', 'number,title']));
  if (all.length >= 1000) throw new Error(`${opts.post} has 1000 issues or more, so the list may be cut short and a digest could be posted twice; nothing posted`);
  const found = all.filter((i) => i.title === title);
  if (found.length > 1) throw new Error(`${found.length} issues in ${opts.post} are titled "${title}": ${found.map((i) => `#${i.number}`).join(', ')}; none updated`);
  if (found.length) console.log(gh(['issue', 'edit', String(found[0].number), '--repo', opts.post, '--add-label', 'digest', '--body-file', file]).trim());
  else console.log(gh(['issue', 'create', '--repo', opts.post, '--title', title, '--label', 'digest', '--body-file', file]).trim());
  rmSync(join(state, 'digest.failed'), { force: true });
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const why = String(error.stderr || error.message).trim();
    console.error(`factory-ledger: ${why}`);
    // A failed weekly post leaves digest.failed for bin/factory-alerts, as the queue leaves queue-run.failed (#209);
    // a run that prints to stdout, and plist, keep no state.
    const args = process.argv.slice(2);
    if (args[0] !== 'plist' && args.includes('--post')) {
      try {
        const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
        mkdirSync(state, { recursive: true });
        writeFileSync(join(state, 'digest.failed'), `${new Date().toISOString()} ${why.split('\n')[0]}\n`);
      } catch {}
    }
    process.exit(1);
  }
}
