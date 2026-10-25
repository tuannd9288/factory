// The factory's ledger: one row per task, from GitHub and the repository's Claude Code profile, with no model; and the
// weekly digest built from those rows, every rate with its count and its 95% Wilson interval. A task is an
// issue labelled task, from its assignment (the label) to its close, with every pull request that closes it; a pull
// request that closes no task is a task of its own, from its opening. Cost is API-equivalent usage, never cash.
// See bin/factory-ledger for the arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredChecks } from '../../kit/scripts/lib/policy.mjs';
import { coverage } from '../../kit/scripts/lib/verdict.mjs';

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

/** Cost per git branch of one repository: every entry of its own profile (today's one profile per repository), plus the
 * entries of the extra profile folders whose working directory is the repository's folder <root>/<name> or under it
 * (a worktree). An entry in two places counts once; null when there is no profile folder to read at all. */
export function repoCosts({ own, extra = [], root, name }) {
  const dir = real(join(root, name));
  const byBranch = new Map();
  const seen = new Set();
  let any = false;
  if (own && existsSync(own)) {
    any = true;
    for (const entry of assistantEntries(own)) charge(byBranch, seen, entry);
  }
  for (const folder of extra) {
    if (!existsSync(folder)) continue;
    any = true;
    for (const entry of assistantEntries(folder)) if (within(entry.cwd, dir)) charge(byBranch, seen, entry);
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
    for (const e of events) {
      if (e.__typename === 'AutoMergeEnabledEvent') byRule = true;
      if (e.__typename === 'AutoMergeDisabledEvent') byRule = false;
      if (e.__typename === 'MergedEvent') break;
    }
    if (!byRule) reasons.push('manual merge');
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

/** The title of the digest issue for a period. */
export const digestTitle = (since, until) => `Weekly digest ${since} → ${until}`;
/** The title of the digests posted before #98 (#1), which were Vietnamese. A period posted under it is updated, not
 * posted again. */
export const oldDigestTitle = (since, until) => `Bản tin xưởng ${since} → ${until}`;

/** The weekly digest, in markdown. */
export function digest(rows, { since, until, secrets = new Map(), canary = null, unplaced: lost = null, queue = null }) {
  const n = rows.length;
  const landed = rows.filter((r) => r.state === 'landed');
  const judged = rows.filter((r) => r.firstPass !== null);
  const costed = rows.filter((r) => r.cost !== null);
  const rounds = rows.filter((r) => r.rounds > 0);
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
    `- Green at the first commit the gate judged: ${rate(judged.filter((r) => r.firstPass).length, judged.length)}`,
    `- Used No-red: ${rate(rows.filter((r) => r.noRed).length, n)}`,
    `- Reviewer raised to tier 3 (label raised), by repository: ${[...new Set(rows.map((r) => r.repo))].sort().map((repo) => `${repo} ${rows.filter((r) => r.repo === repo && r.raised).length}`).join(', ') || 'no tasks'}`,
    `- Cost measured: ${rate(costed.length, n)}`,
    ...(lost?.entries ? [`- ${lost.entries} entries ($${lost.dollars.toFixed(2)} at API prices) in extra profile folders record no cwd, so they count for no repository, and "no session on the branch" may hide them`] : []),
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
    'API cost: the tokens in the repository\'s Claude Code profile, by the PR\'s branch, at API prices (bin/lib/prices.json). That is usage, not money paid; it does not include the reviewer that runs on GitHub.',
    'Cash: the Claude subscription, paid monthly, not split by task; the verifier\'s Codex subscription is the same. The ledger sees no other cash.',
    'Human touched: the Human reviewed it, the label needs-human, or a merge not made by auto-merge.',
  );
  return `${lines.join('\n')}\n`;
}

const QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
number title url body author{login} createdAt mergedAt state headRefName headRefOid mergeCommit{oid}
comments(first:100){nodes{author{login} body}}
closingIssuesReferences(first:10){nodes{number labels(first:20){nodes{name}}}}
labels(first:30){nodes{name}}
reviews(first:50){nodes{author{login} state}}
timelineItems(first:100,itemTypes:[LABELED_EVENT,AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT,MERGED_EVENT]){nodes{__typename ... on LabeledEvent{label{name}} ... on MergedEvent{createdAt}}}
commits(first:100){nodes{commit{oid parents{totalCount} checkSuites(first:20){nodes{app{slug} checkRuns(first:40){nodes{name conclusion}}}}}}}}}}`;

const ISSUE = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){
number title url createdAt closedAt state stateReason
timelineItems(first:50,itemTypes:[LABELED_EVENT]){nodes{__typename ... on LabeledEvent{createdAt label{name}}}}
closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number}}}}}`;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The factory's clones under root, by owner/name. */
function clonesUnder(root) {
  const out = new Map();
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, name);
    if (!existsSync(join(dir, '.gate/config.sh')) || !existsSync(join(dir, '.git'))) continue;
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = /github\.com[:/](.+?)(\.git)?$/.exec(url);
    if (m) out.set(m[1], dir);
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

/** The profile folders the ledger reads: every `<profiles>/<owner>/<repo>/claude`, plus the extra folders named. */
function profileFolders(profiles, extra) {
  const own = [];
  if (existsSync(profiles))
    for (const owner of readdirSync(profiles))
      for (const name of existsSync(join(profiles, owner)) ? readdirSync(join(profiles, owner)) : [])
        if (existsSync(join(profiles, owner, name, 'claude'))) own.push(join(profiles, owner, name, 'claude'));
  return [...new Set([...own, ...extra])];
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

function main(argv) {
  const opts = { repos: [], since: null, until: null, mode: 'digest', post: null, check: false, latest: 50, profileDirs: (process.env.FACTORY_PROFILE_DIRS ?? '').split(':').filter(Boolean) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') opts.repos.push(argv[++i]);
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--until') opts.until = argv[++i];
    else if (a === '--rows') opts.mode = 'rows';
    else if (a === '--digest') opts.mode = 'digest';
    else if (a === '--post') opts.post = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--latest') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--latest needs a whole number of at least 1');
      opts.latest = n;
    }
    else if (a === '--profile-dir') opts.profileDirs.push(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  const profilesDir = process.env.AGENT_PROFILES ?? join(process.env.HOME, '.agent-profiles');
  if (opts.check) {
    process.exitCode = check(profileFolders(profilesDir, opts.profileDirs), opts.latest, opts.profileDirs);
    return;
  }
  const day = (d) => d.toISOString().slice(0, 10);
  opts.until ??= day(new Date());
  opts.since ??= day(new Date(Date.parse(opts.until) - 7 * 864e5));
  const root = process.env.FACTORY_ROOT ?? join(here, '..', '..');
  const profiles = profilesDir;
  const human = process.env.FACTORY_HUMAN ?? 'tuannd9288';
  const clones = clonesUnder(root);
  if (!opts.repos.length) opts.repos = [...clones.keys()];
  if (!opts.repos.length) throw new Error(`no repository under ${root}; pass --repo owner/name`);

  const rows = [];
  const from = Date.parse(`${opts.since}T00:00:00Z`);
  const to = Date.parse(`${opts.until}T23:59:59Z`);
  for (const repo of opts.repos) {
    const [owner, name] = repo.split('/');
    const profile = join(profiles, owner, name, 'claude');
    const costs = repoCosts({ own: profile, extra: opts.profileDirs, root, name });
    const graphql = (query, n) => JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${n}`])).data.repository;
    const list = (path) => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/${path}`])).flat().filter((x) => inWindow(x.created_at, x.closed_at, from, to));
    const pulls = new Map();
    const pull = (n) => {
      if (!pulls.has(n)) {
        const node = graphql(QUERY, n).pullRequest;
        pulls.set(n, { node, row: rowOf(repo, node, { human, costs, profile: costs !== null, patchOf: patchIn(clones.get(repo)) }) });
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
  const report = inspect(profileFolders(profilesDir, opts.profileDirs), { latest: opts.latest });
  const text = digest(rows, { ...opts, secrets, canary: canaryLine(report), queue: queueState(process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory'), opts.repos), unplaced: unplaced(opts.profileDirs) });
  if (!opts.post) {
    process.stdout.write(text);
    return;
  }
  const file = join(mkdtempSync(join(tmpdir(), 'digest-')), 'digest.md');
  writeFileSync(file, text);
  gh(['label', 'create', 'digest', '--repo', opts.post, '--force']);
  const title = digestTitle(opts.since, opts.until);
  const titles = [title, oldDigestTitle(opts.since, opts.until)];
  // Neither --search nor --label: both go through GitHub's search index, which lags behind a new issue. A plain list
  // reads the repository, and the titles are compared here.
  const all = JSON.parse(gh(['issue', 'list', '--repo', opts.post, '--state', 'all', '--limit', '1000', '--json', 'number,title']));
  if (all.length >= 1000) throw new Error(`${opts.post} has 1000 issues or more, so the list may be cut short and a digest could be posted twice; nothing posted`);
  const found = all.filter((i) => titles.includes(i.title));
  if (found.length > 1) throw new Error(`${found.length} issues in ${opts.post} are titled "${title}" or the older title of that period: ${found.map((i) => `#${i.number}`).join(', ')}; none updated`);
  if (found.length) console.log(gh(['issue', 'edit', String(found[0].number), '--repo', opts.post, '--add-label', 'digest', '--body-file', file]).trim());
  else console.log(gh(['issue', 'create', '--repo', opts.post, '--title', title, '--label', 'digest', '--body-file', file]).trim());
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`factory-ledger: ${String(error.stderr || error.message).trim()}`);
    process.exit(1);
  }
}
