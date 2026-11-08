// The factory's ledger: one row per task, from GitHub and the records of bin/seat, with no model; and the
// weekly digest built from those rows, every rate with its count and its 95% Wilson interval. A task is an
// issue labelled task, from its assignment (the label) to its close, with every pull request that closes it; a pull
// request that closes no task is a task of its own, from its opening. Cost is API-equivalent usage, never cash.
// Posted digests read records/* in better-factory; local rows and quota commands keep their local sources.
// See bin/factory-ledger for the arguments.
import { revertedTitle } from '../../kit/.gate/bin/lib/subject.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredChecks } from '../../kit/.gate/bin/lib/policy.mjs';
import { STALE_RUN, assistantEntryOf, canaryOf } from './claude-code.mjs';
import { accountsOf, quotaRows, quotaSection, roleMapLines } from './quota.mjs';
import { createLinear } from './linear.mjs';
import { onLinear } from './linear-repos.mjs';
import { job, plist } from './queue.mjs';
import { switchSince } from './switch-watch.mjs';
import { claimJob } from './job-claim.mjs';
import { lastRecords, readSessions } from './records.mjs';

// Moved to claude-code.mjs (INN-39 item 3) and exported here too while callers still import them from here.
export { READS, costOf } from './claude-code.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REQUIRED = requiredChecks(join(here, '../../kit'));

/** The session files under a folder, at any depth. */
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

/** Every assistant entry with usage in a profile folder's session files, in file order, as claude-code.mjs's entryOf gives it. */
function* assistantEntries(profileDir) {
  for (const file of jsonlFiles(join(profileDir, 'projects'))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const entry = assistantEntryOf(line);
      if (entry) yield entry;
    }
  }
}

/** The canary (claude-code.mjs's canaryOf) over the session files of the profile folders, oldest first by modification time. */
export function inspect(profileDirs, { latest = 50 } = {}) {
  const dated = [];
  for (const dir of profileDirs)
    for (const file of jsonlFiles(join(dir, 'projects'))) dated.push({ file, time: statSync(file).mtimeMs });
  dated.sort((a, b) => a.time - b.time);
  return canaryOf(dated.map(({ file }) => ({ file, text: readFileSync(file, 'utf8') })), { latest });
}

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

/** Adds an assistant entry's cost to its git branch's row; an entry without a branch, or seen before, adds nothing. The entry is in the
 * factory's shape (entryOf in claude-code.mjs): { key, session, branch, cwd, model, dollars }. */
export function charge(byBranch, seen, entry) {
  if (!entry.branch) return;
  if (seen.has(entry.key)) return;
  seen.add(entry.key);
  const row = byBranch.get(entry.branch) ?? { dollars: 0, models: new Set(), unpriced: new Set() };
  if (entry.dollars === null) row.unpriced.add(entry.model);
  else row.dollars += entry.dollars;
  row.models.add(entry.model);
  byBranch.set(entry.branch, row);
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
    for (const entry of assistantEntries(folder)) if (!recorded.has(entry.session) && within(entry.cwd, dir)) charge(byBranch, seen, entry);
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
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      total.entries += 1;
      total.dollars += entry.dollars ?? 0;
    }
  }
  return total;
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

/** One pull request's row, as the GraphQL query below returns it; a task of its own when it closes no task. */
export function rowOf(repo, pr, { human, costs, profile }) {
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
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    prs: [pr.number],
    merges: pr.mergedAt ? [{ number: pr.number, title: pr.title, body: pr.body ?? '', merged: pr.mergedAt }] : [],
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
    merges: prs.flatMap((r) => r.merges ?? []),
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

/** The pstack steps that waited for Codex from since to until, whole days in UTC (#182): the lines `factory codex` appends to
 * <state>/codex-waits.jsonl (packs/pstack/bin/codex-step.mjs), as [cause, count] pairs, most first. A line that cannot be read
 * counts for nothing; no file is no wait. */
export function codexWaits(dir, since, until) {
  const file = join(dir, 'codex-waits.jsonl');
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T23:59:59Z`);
  const counts = new Map();
  for (const text of existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []) {
    let wait;
    try {
      wait = JSON.parse(text);
    } catch {
      continue;
    }
    const at = Date.parse(wait?.at);
    if (typeof wait?.cause === 'string' && at >= from && at <= to) counts.set(wait.cause, (counts.get(wait.cause) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const STATE = { landed: 'merged', open: 'open', abandoned: 'abandoned' };

/** The pull requests of this repository that a merged pull request reverts: the `Reverts #N` and `Reverts <repo>#N`
 * lines of its body, which win when there is any (a line for another repository leaves none); else the one merged
 * pull request, before it, whose title is named by GitHub's `Revert "<title>"` or Conventional Commits' `revert: <title>`, the latest if several. */
function revertsOf(repo, pr, merged) {
  const lines = [...(pr.body ?? '').matchAll(/^[ \t]*Reverts[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)[ \t]*\.?[ \t]*$/gm)];
  if (lines.length) return lines.filter((m) => !m[1] || m[1].toLowerCase() === repo.toLowerCase()).map((m) => Number(m[2]));
  const title = revertedTitle(pr.title);
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

/** The commits a merged pull request's body says it repairs (INN-40): each line `Fixes: <12 to 40 hex> ("<title>")`, the Linux
 * kernel's tag, the hex lowercased. `Fixes FAC-12` and `Fixes #12`, which close an issue, are none. */
export const fixLines = (body) => [...String(body ?? '').matchAll(/^[ \t]*Fixes:[ \t]+([0-9a-fA-F]{12,40})(?![0-9a-fA-F])/gm)].map((m) => m[1].toLowerCase());

/** The pull request a commit of a clone came from, by git alone, never gh: its subject `Merge pull request #N from …` (a merge commit)
 * or `… (#N)` (a squash commit) gives N; null when the clone has no such commit or its subject names none. A commit the clone lacks
 * makes one `git fetch origin main`, the first time only. */
export function commitPullRequest(dir) {
  let fetched = false;
  const subject = (sha) => {
    try {
      return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s', sha, '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  return (sha) => {
    let s = subject(sha);
    if (s === null && !fetched) {
      fetched = true;
      spawnSync('git', ['-C', dir, 'fetch', '--quiet', '--no-tags', 'origin', 'main'], { stdio: 'ignore', timeout: 60_000 });
      s = subject(sha);
    }
    const m = s && (/^Merge pull request #(\d+) /.exec(s) ?? /\(#(\d+)\)$/.exec(s));
    return m ? Number(m[1]) : null;
  };
}

/** Gives every merged entry of the rows its `fixes`: [{ sha, number }] for each `Fixes:` line of its body, the number from
 * `resolverOf(repo)` (a function of a sha, or null when the repository has no clone), null when it names no pull request. */
export function resolveFixes(rows, resolverOf) {
  const resolvers = new Map();
  for (const r of rows) {
    if (!resolvers.has(r.repo)) resolvers.set(r.repo, resolverOf(r.repo));
    const resolve = resolvers.get(r.repo);
    for (const p of r.merges ?? []) p.fixes ??= fixLines(p.body).map((sha) => ({ sha, number: resolve ? resolve(sha) : null }));
  }
  return rows;
}

const FIX_TITLE = /^fix(\([^)]*\))?!?:/;

/** The change fail rate in [from, to] (ms), DORA's: of the merged pull requests in it that are not reverts (n), the ones a revert
 * or a fix merged by its end repairs (k); failed names them with what repaired them. earlier: the pull requests merged before it
 * that a fix merged in it repairs; unresolved: the `Fixes:` lines of fixes merged in it that name no other pull request; unmarked:
 * the pull requests of n titled fix(…) with no `Fixes:` line. A fix's lines are its entry's `fixes` (resolveFixes), else unresolved. */
export function failIn(rows, from, to) {
  const all = new Map();
  for (const r of rows) for (const p of r.merges ?? []) all.set(`${r.repo}#${p.number}`, { ...p, repo: r.repo });
  const byRepo = (repo) => [...all.values()].filter((p) => p.repo === repo);
  const reverts = new Map([...all].map(([key, p]) => [key, revertsOf(p.repo, p, byRepo(p.repo))]).filter(([, t]) => t.length));
  const inside = (p) => Date.parse(p.merged) >= from && Date.parse(p.merged) <= to;
  const during = [...all].filter(([, p]) => inside(p));
  const duringKeys = new Set(during.map(([key]) => key));
  const plain = during.filter(([key]) => !reverts.has(key));
  const by = new Map();
  const add = (key, how) => by.set(key, [...(by.get(key) ?? []), how]);
  for (const [key, targets] of reverts) if (Date.parse(all.get(key).merged) <= to) for (const t of targets) add(`${all.get(key).repo}#${t}`, `reverted by #${all.get(key).number}`);
  const earlier = new Map();
  const unresolved = [];
  for (const p of all.values()) {
    if (Date.parse(p.merged) > to) continue;
    for (const f of p.fixes ?? fixLines(p.body).map((sha) => ({ sha, number: null }))) {
      if (f.number === null || f.number === p.number) {
        if (inside(p)) unresolved.push({ repo: p.repo, number: p.number, sha: f.sha });
        continue;
      }
      const target = `${p.repo}#${f.number}`;
      add(target, `fixed by #${p.number}`);
      if (inside(p) && !duringKeys.has(target)) earlier.set(target, [...(earlier.get(target) ?? []), p.number]);
    }
  }
  const order = (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number;
  const failed = plain.filter(([key]) => by.has(key)).map(([key, p]) => ({ repo: p.repo, number: p.number, by: by.get(key) })).sort(order);
  const unmarked = plain.filter(([, p]) => FIX_TITLE.test(p.title) && !fixLines(p.body).length).map(([, p]) => ({ repo: p.repo, number: p.number })).sort(order);
  return {
    n: plain.length, k: failed.length, failed, unmarked, unresolved: unresolved.sort(order),
    earlier: [...earlier].map(([key, fixes]) => ({ repo: key.slice(0, key.lastIndexOf('#')), number: Number(key.slice(key.lastIndexOf('#') + 1)), by: fixes })).sort(order),
  };
}

/** failIn for the period [since 00:00, until 23:59:59] (UTC). */
export const failCount = (rows, { since, until }) => failIn(rows, Date.parse(`${since}T00:00:00Z`), Date.parse(`${until}T23:59:59Z`));

const SEARCH = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){pageInfo{hasNextPage endCursor}
nodes{... on PullRequest{number title body mergedAt}}}}`;

/** The pull requests of a repository merged in [from, to] (ms), as merged entries ({ number, title, body, merged }), from GitHub's
 * search, 100 a page (INN-40). `run` is gh. */
export function mergedIn(repo, from, to, run = gh) {
  const q = `repo:${repo} is:pr is:merged merged:>=${new Date(from).toISOString().slice(0, 10)}`;
  const out = [];
  for (let after = null; ;) {
    const page = JSON.parse(run(['api', 'graphql', '-f', `query=${SEARCH}`, '-f', `q=${q}`, ...(after ? ['-f', `after=${after}`] : [])])).data.search;
    for (const p of page.nodes) if (p?.mergedAt && Date.parse(p.mergedAt) >= from && Date.parse(p.mergedAt) <= to) out.push({ number: p.number, title: p.title, body: p.body ?? '', merged: p.mergedAt });
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
}

/** For each repository, its merge switch (switchSince) and the change fail rate over the window since the switch last moved, up to
 * `to` (ms): { position, since, n, k }, or null when the sweep's file names no position. `merged(repo, from, to)` gives the merged
 * entries of the window, and `resolverOf` resolves their `Fixes:` lines (resolveFixes). */
export function switchWindows(repos, { state, to, merged, resolverOf }) {
  return new Map(repos.map((repo) => {
    const sw = switchSince(state, repo);
    if (!sw) return [repo, null];
    const from = Date.parse(sw.since);
    try {
      const c = failIn(resolveFixes([{ repo, merges: merged(repo, from, to) }], resolverOf), from, to);
      return [repo, { position: sw.position, since: sw.since, n: c.n, k: c.k }];
    } catch (error) {
      // A search that fails costs this repository's line, not the digest.
      return [repo, { position: sw.position, since: sw.since, error: String(error.stderr || error.message).trim().split('\n')[0].slice(0, 200) }];
    }
  }));
}

/** How a row's number reads after its repository: `#12` for a GitHub issue or pull request, ` FAC-12` for a task on Linear (#406). */
const at = (number) => (typeof number === 'string' ? ` ${number}` : `#${number}`);

/** The title of the digest issue for a period. */
export const digestTitle = (since, until) => `Weekly digest ${since} → ${until}`;

export { lastRecords, readSessions };

/** The sessions that ran in the period, one record each: a resumed session's total_cost_usd covers the whole session, so a
 * session counts once, by its last record; the records of one session are never added (#89). */
export function keptSessions(records, since, until) {
  const [from, to] = [Date.parse(`${since}T00:00:00Z`), Date.parse(`${until}T23:59:59Z`)];
  return lastRecords(records.filter((x) => inWindow(x.start, x.end, from, to)));
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
export function digest(rows, { since, until, secrets = new Map(), canary = null, unplaced: lost = null, queue = null, sessions = null, quota = null, accounts = {}, unread = null, shared = null, codexWaits: waits = null, switches = null }) {
  const n = rows.length;
  const landed = rows.filter((r) => r.state === 'landed');
  const judged = rows.filter((r) => r.firstPass !== null);
  const costed = rows.filter((r) => r.cost !== null);
  const rounds = rows.filter((r) => r.rounds > 0);
  const reverts = revertCount(rows, { since, until });
  const fail = failCount(rows, { since, until });
  const named = (list, how = () => '') => list.map((p) => `${p.repo}#${p.number}${how(p)}`).join(', ');
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
  if (waiting.length) for (const r of waiting) lines.push(`- ${r.repo}${at(r.number)} ${r.title} — ${r.tier === 3 ? "tier 3, awaiting the Human's approval" : 'needs-human'}`);
  else lines.push('- None.');
  lines.push(
    '',
    '## Rates (counts, rates, 95% Wilson confidence intervals)',
    '',
    `- Tasks merged: ${rate(landed.length, n)}`,
    `- Merged tasks the Human had to touch: ${rate(landed.filter((r) => r.touched).length, landed.length)}`,
    `- PRs reverted: ${rate(reverts.k, reverts.n)}; reverts merged in the period: ${reverts.m}`,
    ...(reverts.n ? [`- Reverted PRs: ${reverts.k ? reverts.reverted.map((p) => `${p.repo}#${p.number}`).join(', ') : 'none'}`] : []),
    `- Change fail rate (reverted or fixed): ${rate(fail.k, fail.n)}`,
    ...(fail.n ? [`- Failed PRs: ${fail.k ? named(fail.failed, (p) => ` (${p.by.join(', ')})`) : 'none'}`] : []),
    `- Fixed this period, merged earlier: ${fail.earlier.length ? `${fail.earlier.length} (${named(fail.earlier, (p) => ` fixed by ${p.by.map((x) => `#${x}`).join(', ')}`)})` : 'none'}`,
    ...(fail.n ? [`- PRs titled fix(…) with no Fixes: line: ${fail.unmarked.length ? `${fail.unmarked.length} (${named(fail.unmarked)})` : 'none'}`] : []),
    ...(fail.unresolved.length ? [`- Fixes: lines not resolved: ${named(fail.unresolved, (p) => ` (${p.sha})`)}`] : []),
    ...(switches?.size ? ['- By repository, since its merge switch last moved:', ...[...switches].map(([repo, w]) => (w
      ? `  - ${repo}: merge switch ${w.position} since ${w.since.slice(0, 10)}; change fail rate since then ${w.error ? `not read (${w.error})` : rate(w.k, w.n)}`
      : `  - ${repo}: merge switch not read`))] : []),
    `- Green at the first commit the gate judged: ${rate(judged.filter((r) => r.firstPass).length, judged.length)}`,
    `- Used No-red: ${rate(rows.filter((r) => r.noRed).length, n)}`,
    `- Reviewer raised to tier 3 (label raised), by repository: ${[...new Set(rows.map((r) => r.repo))].sort().map((repo) => `${repo} ${rows.filter((r) => r.repo === repo && r.raised).length}`).join(', ') || 'no tasks'}`,
    ...(waits ? [`- pstack steps that waited for Codex: ${waits.length ? `${waits.reduce((sum, [, k]) => sum + k, 0)} (${waits.map(([cause, k]) => `${cause} ${k}`).join(', ')})` : 'none'}`] : []),
    `- Cost measured: ${rate(costed.length, n)}`,
    ...(lost?.entries ? [`- ${lost.entries} ${lost.entries === 1 ? 'entry' : 'entries'} ($${lost.dollars.toFixed(2)} at API prices) in extra profile folders record no cwd, so they count for no repository, and "no session on the branch" may hide them`] : []),
    `- Average rounds (commits the gate judged): ${rounds.length ? (rounds.reduce((s, r) => s + r.rounds, 0) / rounds.length).toFixed(2) : '–'} (n=${rounds.length})`,
    `- API-equivalent cost per merged task (every attempt added up; not cash): ${costed.length && landed.length ? `$${(costed.reduce((s, r) => s + r.cost, 0) / landed.length).toFixed(2)} (cost measured on ${costed.length}/${n} tasks)` : 'not measurable yet'}`,
    '',
    '## Per task',
    '',
    '| Repo | Task | PR | Who | Tier | Rounds | API cost | Human touched | Outcome |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const cost = r.cost === null ? `? (${r.costNote})` : `$${r.cost.toFixed(2)}${r.costNote ? ` (${r.costNote})` : ''}`;
    lines.push(
      `| ${r.repo.split('/')[1]} | [${at(r.number).trim()}](${r.url}) ${r.title.replace(/\|/g, '/').slice(0, 60)} | ${r.prs.map((n) => `#${n}`).join(' ') || '–'} | ${r.who} | ${r.tier ?? '?'} | ${r.rounds} | ${cost} | ${r.touched ? `yes (${r.touchedWhy})` : 'no'} | ${STATE[r.state]} |`,
    );
  }
  if (unread?.size) lines.push('', ...[...unread].map(([repo, why]) => `- ${repo}: could not read its Linear issues (${why}); its task list above is missing.`));
  if (sessions) {
    const { lines: ran, total } = sessionLines(sessions, since, until);
    const uncharged = unchargedSessions(sessions, since, until);
    lines.push('', '## Sessions (bin/seat)', '', ...(ran.length ? [...ran, `- Total: $${total.toFixed(2)} over ${ran.length} ${ran.length === 1 ? 'session' : 'sessions'} (the last record of each; a resumed session's cost is cumulative, so its records are not added)`] : ['- None.']));
    if (uncharged.count) lines.push(`- ${uncharged.count} ${uncharged.count === 1 ? 'session' : 'sessions'} ($${uncharged.dollars.toFixed(2)} at API prices) charged to no task, because the record names no repository and branch`);
  }
  if (shared) {
    lines.push('', '## Reporting nodes', '', ...shared.nodes.map((n) => `- ${n.node}: last reported ${n.reported}${n.silent ? '; silent since the week started — this week may be incomplete' : ''}`));
    if (shared.late.length) {
      lines.push('', '## Late', '', ...shared.late.map((r) => `- Late: ${r.node}, ${r.role} ${r.tag}, ended ${r.end}, ${typeof r.total_cost_usd === 'number' ? `$${r.total_cost_usd.toFixed(2)}` : '$?'}`),
        `- Late total: $${shared.late.reduce((sum, r) => sum + (r.total_cost_usd ?? 0), 0).toFixed(2)}`);
    }
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
    'Cash: the Claude subscription, paid monthly, not split by task. The ledger sees no other cash.',
    'Revert: a merged PR whose body has a line "Reverts #N" or "Reverts <this repository>#N"; only when its body has no "Reverts" line at all, for any repository, is its title Revert "<title of a merged PR>" or revert(scope): <title of a merged PR> (scope optional) read; PRs reverted counts the PRs merged in the period, reverts not included, that a revert merged by its end undoes.',
    'Fixed: a merged PR named by a line "Fixes: <the first 12 or more characters of a commit> ("<title>")" in the body of a PR merged later, the commit being the merge or squash commit main got when the named PR merged, read in the repository\'s clone; "Fixes <KEY>" and "Fixes #N" close an issue and name no PR. Change fail rate (DORA\'s) counts the PRs merged in the period, reverts not included, that a revert or a fix merged by its end repairs; a fix of a PR merged before the period is counted in the week the fix lands, under "merged earlier". Data only: nothing gates on it.',
    'Merge switch: all, every PR merges by itself, tier 3 included; 1-2, tier 3 waits for the Human; none, every PR waits for an approval. Its window starts at its last move as the sweep saw it, or the sweep\'s first sight of it.',
    'Human touched: the Human reviewed it, the label needs-human, or a merge by the Human\'s own login that was not made by auto-merge (a merge by the agents\' login is a team merge).',
  );
  return `${lines.join('\n')}\n`;
}

const QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
number title url body author{login} createdAt mergedAt state headRefName
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

/** Every issue of a Linear team that matches `filter`, with the fields `pick` names, across pages. */
async function linearIssues(api, teamKey, filter, fields) {
  const out = [];
  let after = null;
  do {
    const page = (await api.request(`query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`,
      { filter: { team: { key: { eq: teamKey } }, ...filter }, after }))?.issues;
    if (!page) throw new Error('Linear did not answer the list of issues');
    out.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out;
}

/** The issue key a pull request body names on its line `Issue: <KEY>` (prbody.mjs reads only `#N`), or null. */
export const linearIssueOf = (body) => /^Issue:[ \t]*([A-Z][A-Z0-9]{1,9}-[1-9]\d*)[ \t]*\r?$/m.exec(String(body ?? ''))?.[1] ?? null;

/** The task rows of a repository on Linear (#406): an issue of the team that has started (FAC-45: one that never did, in Triage, Backlog,
 * Todo or Canceled, is no task), from `startedAt` to `completedAt` or `canceledAt`, with the row of every pull request whose body has
 * `Issue: <KEY>`. `allPulls` are the repository's pull requests as { number, body }; `pullRow(number)` is the row of one. Gives
 * { rows, keys }: the rows alive in [from, to], and every task's key. */
export async function linearTaskRows({ repo, api, teamKey, allPulls, pullRow, from, to }) {
  const tasks = (await linearIssues(api, teamKey, { startedAt: { null: false } }, 'identifier title url startedAt completedAt canceledAt')).filter((t) => t.startedAt);
  const rows = [];
  for (const t of tasks) {
    const start = t.startedAt;
    const end = t.completedAt ?? t.canceledAt ?? null;
    if (!inWindow(start, end, from, to)) continue;
    const prs = allPulls.filter((p) => linearIssueOf(p.body) === t.identifier).map((p) => pullRow(p.number));
    rows.push(taskRow(repo, { number: t.identifier, title: t.title, url: t.url, createdAt: start, state: end ? 'CLOSED' : 'OPEN', timelineItems: { nodes: [] } }, prs));
  }
  return { rows, keys: new Set(tasks.map((t) => t.identifier)) };
}

/** The owner/name of the clone at dir, from its github.com origin, or null: the factory's own repository, whose clone is the root. */
function originRepo(dir) {
  try {
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /github\.com[:/](.+)$/.exec(url.replace(/\/$/, '').replace(/\.git$/, ''));
    return m && /^[\w.-]+\/[\w.-]+$/.test(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
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

/** #366: the issue's shared-records contract (no multi-node reader in the references).
 * Fetch into a disposable bare repository so a failed fetch can never use yesterday's local files.
 * The returned cursor is saved only after posting; keep the period's starting tips for an edit/retry. */
export function sharedRecords(state, since, until, remote = `https://github.com/${DIGEST_REPO}.git`) {
  const cursorFile = join(state, 'digest-records.json');
  const saved = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, 'utf8')) : { tips: null };
  const period = `${since}_${until}`;
  const previous = saved.period === period ? saved.previous : saved.tips;
  const dir = mkdtempSync(join(tmpdir(), 'digest-records-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '--bare', '--quiet');
    git('fetch', '--quiet', '--no-tags', remote, 'refs/heads/records/*:refs/heads/records/*');
    const branches = git('for-each-ref', '--format=%(refname) %(objectname) %(committerdate:iso-strict)', 'refs/heads/records/').trim().split('\n').filter(Boolean);
    if (!branches.length) throw new Error('no records branches');
    const tips = {};
    const sessions = [], late = [], nodes = [], quotas = [];
    for (const branch of branches) {
      const [ref, tip, reported] = branch.split(' ');
      const node = ref.slice('refs/heads/records/'.length);
      tips[node] = tip;
      nodes.push({ node, reported, silent: Date.parse(reported) < Date.parse(`${since}T00:00:00Z`) });
      const all = git('show', `${tip}:rows.jsonl`);
      const old = previous?.[node] ? git('show', `${previous[node]}:rows.jsonl`) : '';
      if (previous?.[node]) git('merge-base', '--is-ancestor', previous[node], tip);
      if (!all.startsWith(old)) throw new Error(`${node}: records are not append-only`);
      const decode = (text) => text.split('\n').filter(Boolean).map((line) => {
        const r = JSON.parse(line);
        if (r.v !== 1 || r.node !== node || !['session', 'log'].includes(r.kind)) throw new Error(`${node}: invalid records row`);
        return r;
      });
      const rows = decode(all);
      const folder = join(dir, 'input');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'sessions.jsonl'), rows.filter((r) => r.kind === 'session').map((r) => JSON.stringify(r.row)).join('\n'));
      const records = readSessions(folder);
      const identify = (r) => ({ ...r, node, session: `${node}:${r.session ?? `${r.run}#${r.tag}`}` });
      sessions.push(...records.map(identify));
      const before = new Map(lastRecords(decode(old).filter((r) => r.kind === 'session').map((r) => r.row)).map((r) => [r.session ?? `${r.run}#${r.tag}`, r]));
      for (const r of lastRecords(decode(all.slice(old.length)).filter((r) => r.kind === 'session').map((r) => r.row))) {
        if (!previous || Date.parse(r.end) >= Date.parse(`${since}T00:00:00Z`)) continue;
        const prior = before.get(r.session ?? `${r.run}#${r.tag}`);
        late.push({ ...identify(r), total_cost_usd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd - (prior?.total_cost_usd ?? 0) : null, late: true });
      }
      // Reconstruct only the shared log lines and record metadata for the existing quota parser.
      const runs = join(folder, 'runs');
      rmSync(runs, { recursive: true, force: true });
      const logs = new Map();
      for (const r of rows.filter((r) => r.kind === 'log')) {
        if (typeof r.run !== 'string' || isAbsolute(r.run) || r.run.split('/').includes('..') || !r.line || typeof r.line !== 'object' || Array.isArray(r.line)) throw new Error(`${node}: invalid log row`);
        const lines = logs.get(r.run) ?? [];
        lines.push(JSON.stringify(r.line));
        logs.set(r.run, lines);
      }
      let n = 0;
      for (const [run, lines] of logs) {
        const record = records.findLast((r) => basename(run) === `run-${r.tag}.jsonl` && (r.run === dirname(run) || r.run?.endsWith(`/${dirname(run)}`)));
        const file = join(runs, String(n++), basename(run));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${lines.join('\n')}\n`);
        if (record?.account) writeFileSync(file.replace(/\.jsonl$/, '.account'), record.account);
        const time = new Date(record?.end ?? reported);
        utimesSync(file, time, time);
      }
      quotas.push(...quotaRows({ runs, accounts: [...new Set(records.map((r) => r.account).filter(Boolean))] }).map((r) => ({ ...r, profile: `${node}: ${r.profile}` })));
    }
    for (const node of Object.keys(saved.tips ?? {})) if (!tips[node]) throw new Error(`${node}: records branch is missing`);
    if (!sessions.length) throw new Error('no session rows');
    return { sessions, late, nodes, quota: { rows: quotas, now: Date.now() }, cursor: { period, previous, tips } };
  } catch (error) {
    throw new Error(`Shared records unavailable or incomplete; nothing posted: ${error.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv) {
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
      const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
      return { rows: quotaRows({ runs, state, root: process.env.FACTORY_ROOT, statusFiles: opts.statusFiles }), now: Date.now() };
    } catch (error) {
      return { error: `The runs folder or a log in it could not be read (${error.code ?? 'error'}), so there is no quota table.` };
    }
  };
  if (opts.quota) {
    const q = quotaNow();
    console.log(q.error ?? quotaSection(q.rows, { now: q.now }).join('\n'));
    return;
  }
  if (opts.lastWeek) {
    if (opts.since || opts.until) throw new Error('--last-week takes no --since or --until');
    Object.assign(opts, lastWeek());
  }
  const day = (d) => d.toISOString().slice(0, 10);
  opts.until ??= day(new Date());
  opts.since ??= day(new Date(Date.parse(opts.until) - 7 * 864e5));
  const root = process.env.FACTORY_ROOT ?? join(here, '..', '..');
  // Nothing of the digest reaches a public repository (#209): the target is read before anything is built or posted.
  if (opts.post) {
    const visibility = JSON.parse(gh(['repo', 'view', opts.post, '--json', 'visibility'])).visibility;
    if (visibility !== 'PRIVATE') throw new Error(`${opts.post} is ${visibility ?? 'of unknown visibility'}, not PRIVATE; the digest lists private tasks, so nothing posted`);
  }
  const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
  if (opts.post && !claimJob(root, state, 'digest', `${opts.since}_${opts.until}`)) return;
  const shared = opts.post || opts.lastWeek ? sharedRecords(state, opts.since, opts.until) : null;
  const sessions = shared?.sessions ?? readSessions(state);
  // The waits for Codex are this host's: `factory codex` runs here, the MacBook's by ssh too (#182). The digest takes them from opts.
  opts.codexWaits = codexWaits(state, opts.since, opts.until);
  const seat = seatCosts(sessions);
  const recorded = new Set(sessions.map((r) => r.session).filter(Boolean));
  const human = process.env.FACTORY_HUMAN ?? 'tuannd9288';
  let linear = null;
  const linearApi = () => (linear ??= createLinear({ state }));
  const unread = new Map();
  const unreadBecause = (repo, error) => {
    const why = String(error?.message ?? error).split('\n')[0].slice(0, 200);
    if (!unread.has(repo)) unread.set(repo, why);
    console.error(`ledger: ${repo}: its Linear issues could not be read: ${why}`);
  };
  const clones = clonesUnder(root, (folder, why) => console.error(`ledger: skipped ${folder}: ${why}`));
  if (!opts.repos.length) opts.repos = [...clones.keys()];
  if (!opts.repos.length) throw new Error(`no repository under ${root}; pass --repo owner/name`);

  const rows = [];
  const from = Date.parse(`${opts.since}T00:00:00Z`);
  const to = Date.parse(`${opts.until}T23:59:59Z`);
  for (const repo of opts.repos) {
    const [owner, name] = repo.split('/');
    const costs = repoCosts({ extra: shared ? [] : opts.profileDirs, root, name, seat: seat.get(repo), recorded });
    const graphql = (query, n) => JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${n}`])).data.repository;
    const list = (path) => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/${path}`])).flat().filter((x) => inWindow(x.created_at, x.closed_at, from, to));
    const pulls = new Map();
    const pull = (n) => {
      if (!pulls.has(n)) {
        const node = graphql(QUERY, n).pullRequest;
        pulls.set(n, { node, row: rowOf(repo, node, { human, costs, profile: true }) });
      }
      return pulls.get(n);
    };
    // A repository on Linear (#406) has its tasks there, joined to pull requests by their `Issue: <KEY>` line.
    // A registry or a Linear read that fails leaves this repository's tasks out and says so; the rest of the digest is written.
    let team = null;
    try {
      team = onLinear(repo, state);
    } catch (error) {
      unreadBecause(repo, error);
    }
    let tasks = null;
    if (team) {
      const allPulls = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=all&per_page=100`])).flat();
      try {
        tasks = await linearTaskRows({ repo, api: linearApi(), teamKey: team.key, allPulls, pullRow: (n) => pull(n).row, from, to });
        rows.push(...tasks.rows);
      } catch (error) {
        unreadBecause(repo, error);
      }
    } else if (!unread.has(repo)) {
      for (const i of list('issues?labels=task&state=all&per_page=100')) {
        if (i.pull_request) continue;
        const node = graphql(ISSUE, i.number).issue;
        const row = taskRow(repo, node, node.closedByPullRequestsReferences.nodes.map((p) => pull(p.number).row));
        if (inWindow(row.created, node.closedAt, from, to)) rows.push(row);
      }
    }
    for (const p of list('pulls?state=all&per_page=100&sort=created&direction=desc')) {
      const { node, row } = pull(p.number);
      const ofTask = tasks ? tasks.keys.has(linearIssueOf(node.body)) : !unread.has(repo) && node.closingIssuesReferences.nodes.some((i) => i.labels.nodes.some((l) => l.name === 'task'));
      if (!ofTask) rows.push(row);
    }
  }
  rows.sort((a, b) => a.created.localeCompare(b.created));
  // A `Fixes:` line names a commit; the repository's own clone says which pull request it came from (INN-40), never gh.
  const own = originRepo(root);
  const resolvers = new Map();
  const resolverOf = (repo) => {
    if (!resolvers.has(repo)) {
      const dir = clones.get(repo) ?? (repo === own ? root : null);
      resolvers.set(repo, dir ? commitPullRequest(dir) : null);
    }
    return resolvers.get(repo);
  };
  resolveFixes(rows, resolverOf);
  if (opts.mode === 'rows') {
    const head = ['repo', 'task', 'prs', 'who', 'tier', 'state', 'rounds', 'first_pass', 'no_red', 'human_touched', 'why', 'cost_usd', 'cost_note', 'hours_to_merge', 'title'];
    console.log(head.join('\t'));
    for (const r of rows)
      console.log([r.repo, r.number, r.prs.join(' '), r.who, r.tier ?? '', r.state, r.rounds, r.firstPass ?? '', r.noRed, r.touched, r.touchedWhy, r.cost?.toFixed(4) ?? '', r.costNote, r.hours?.toFixed(2) ?? '', r.title].join('\t'));
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
  const report = inspect(shared ? [] : folders, { latest: opts.latest });
  // Each repository's change fail rate since its merge switch last moved (INN-40), from GitHub's search for that window.
  const switches = switchWindows(opts.repos, { state, to, merged: (repo, a, b) => mergedIn(repo, a, b), resolverOf });
  const text = digest(rows, { ...opts, secrets, unread, canary: canaryLine(report), queue: queueState(state, opts.repos), unplaced: shared ? null : unplaced(opts.profileDirs), sessions, quota: shared?.quota ?? quotaNow(), accounts: shared ? {} : accountsOf(state), shared, switches });
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
  if (shared) writeFileSync(join(state, 'digest-records.json'), `${JSON.stringify(shared.cursor)}\n`);
  rmSync(join(state, 'digest.failed'), { force: true });
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const why = String(error.stderr || error.message).trim();
    console.error(`factory-ledger: ${why}`);
    // A failed weekly post leaves digest.failed for Colly's status line and brief (queueOf in colly-status.mjs), as the queue
    // leaves queue-run.failed (#209);
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
