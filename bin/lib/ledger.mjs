// The factory's ledger: one row per task (one pull request), from GitHub and the repository's Claude Code profile,
// with no model; and the weekly Vietnamese digest built from those rows, every rate with its count and its 95% Wilson
// interval. See bin/factory-ledger for the arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PRICES = JSON.parse(readFileSync(join(here, 'prices.json'), 'utf8')).models;
export const REQUIRED = ['verify', 'rules', 'red-check', 'verify-trusted', 'review', 'verdict'];

/** The 95% Wilson interval of k successes in n, as fractions; null when n is 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const pct = (x) => `${(x * 100).toFixed(1).replace('.', ',')}%`;

/** "k/n (p%; 95%: a–b%)", or "chưa có (n=0)". */
export function rate(k, n) {
  if (!n) return 'chưa có mẫu (n=0)';
  const [a, b] = wilson(k, n);
  return `${k}/${n} (${pct(k / n)}; KTC 95%: ${pct(a)}–${pct(b)})`;
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

/** Cost per git branch from a Claude Code profile's session files: dollars, models, and unpriced models. */
export function branchCosts(profileDir) {
  const byBranch = new Map();
  const seen = new Set();
  for (const file of jsonlFiles(join(profileDir, 'projects'))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry.message;
      if (entry.type !== 'assistant' || !message?.usage || !entry.gitBranch) continue;
      const key = message.id ?? entry.requestId ?? entry.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = byBranch.get(entry.gitBranch) ?? { dollars: 0, models: new Set(), unpriced: new Set() };
      const dollars = costOf(message.model, message.usage);
      if (dollars === null) row.unpriced.add(message.model);
      else row.dollars += dollars;
      row.models.add(message.model);
      byBranch.set(entry.gitBranch, row);
    }
  }
  return byBranch;
}

/** One ledger row from a pull request as the GraphQL query below returns it. */
export function rowOf(repo, pr, { human, costs, profile }) {
  const labels = pr.labels.nodes.map((l) => l.name);
  const tiers = labels.map((l) => /^tier-([123])$/.exec(l)?.[1]).filter(Boolean).map(Number);
  const events = pr.timelineItems.nodes;
  const reasons = [];
  if (pr.reviews.nodes.some((r) => r.author?.login === human && ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state))) reasons.push('duyệt');
  if (events.some((e) => e.__typename === 'LabeledEvent' && e.label?.name === 'needs-human') || labels.includes('needs-human')) reasons.push('needs-human');
  let byRule = false;
  if (pr.mergedAt) {
    for (const e of events) {
      if (e.__typename === 'AutoMergeEnabledEvent') byRule = true;
      if (e.__typename === 'AutoMergeDisabledEvent') byRule = false;
      if (e.__typename === 'MergedEvent') break;
    }
    if (!byRule) reasons.push('merge tay');
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
  if (!profile) costNote = 'không có profile';
  else if (!branch) costNote = 'không có phiên trên nhánh';
  else {
    cost = branch.dollars;
    costNote = branch.unpriced.size ? `thiếu giá: ${[...branch.unpriced].join(', ')}` : '';
  }
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    who: [pr.author?.login ?? '?', ...(branch ? [...branch.models].map((m) => m.replace(/^claude-/, '')) : [])].join(' · '),
    tier: tiers.length ? Math.max(...tiers) : null,
    state: pr.mergedAt ? 'landed' : pr.state === 'OPEN' ? 'open' : 'abandoned',
    rounds: judged.length,
    firstPass,
    noRed: /^No-red: .{20,}/m.test(pr.body ?? ''),
    touched: reasons.length > 0,
    touchedWhy: reasons.join(', '),
    cost,
    costNote,
    created: pr.createdAt,
    merged: pr.mergedAt,
    hours: pr.mergedAt ? (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 36e5 : null,
  };
}

const STATE = { landed: 'đã merge', open: 'đang mở', abandoned: 'bỏ' };

/** The weekly digest, in Vietnamese markdown. */
export function digest(rows, { since, until, secrets = new Map() }) {
  const n = rows.length;
  const landed = rows.filter((r) => r.state === 'landed');
  const judged = rows.filter((r) => r.firstPass !== null);
  const costed = rows.filter((r) => r.cost !== null);
  const rounds = rows.filter((r) => r.rounds > 0);
  const lines = [
    `# Bản tin xưởng ${since} → ${until}`,
    '',
    `${n} việc (mỗi việc một PR): ${landed.length} đã merge, ${rows.filter((r) => r.state === 'open').length} đang mở, ${rows.filter((r) => r.state === 'abandoned').length} bỏ.`,
    '',
    '## Cần anh quyết',
    '',
  ];
  const waiting = rows.filter((r) => r.state === 'open' && (r.tier === 3 || r.touchedWhy.includes('needs-human')));
  if (waiting.length) for (const r of waiting) lines.push(`- ${r.repo}#${r.number} ${r.title} — ${r.tier === 3 ? 'bậc 3, chờ anh duyệt' : 'needs-human'}`);
  else lines.push('- Không có.');
  lines.push(
    '',
    '## Tỉ lệ (số đếm, tỉ lệ, khoảng tin cậy 95% Wilson)',
    '',
    `- Việc đã merge: ${rate(landed.length, n)}`,
    `- Việc đã merge mà anh phải chạm: ${rate(landed.filter((r) => r.touched).length, landed.length)}`,
    `- Xanh ngay ở commit đầu tiên được chấm: ${rate(judged.filter((r) => r.firstPass).length, judged.length)}`,
    `- Dùng No-red: ${rate(rows.filter((r) => r.noRed).length, n)}`,
    `- Có chi phí đo được: ${rate(costed.length, n)}`,
    `- Số vòng trung bình (commit được cổng chấm): ${rounds.length ? (rounds.reduce((s, r) => s + r.rounds, 0) / rounds.length).toFixed(2).replace('.', ',') : '–'} (n=${rounds.length})`,
    `- Chi phí mỗi việc đã merge (giá API, mọi lần thử cộng lại): ${costed.length && landed.length ? `$${(costed.reduce((s, r) => s + r.cost, 0) / landed.length).toFixed(2)} (chi phí đo được trên ${costed.length}/${n} việc)` : 'chưa đo được'}`,
    '',
    '## Từng việc',
    '',
    '| Repo | PR | Việc | Ai | Bậc | Vòng | Chi phí | Anh chạm | Kết quả |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const cost = r.cost === null ? `? (${r.costNote})` : `$${r.cost.toFixed(2)}${r.costNote ? ` (${r.costNote})` : ''}`;
    lines.push(
      `| ${r.repo.split('/')[1]} | [#${r.number}](${r.url}) | ${r.title.replace(/\|/g, '/').slice(0, 60)} | ${r.who} | ${r.tier ?? '?'} | ${r.rounds} | ${cost} | ${r.touched ? `có (${r.touchedWhy})` : 'không'} | ${STATE[r.state]} |`,
    );
  }
  if (secrets.size) {
    lines.push('', '## Secret cấp repo (phải là 0: job của mọi nhánh đều đọc được)', '');
    for (const [repo, names] of secrets) lines.push(`- ${repo}: ${names === null ? 'không kiểm được' : names.length ? names.join(', ') : '0'}`);
  }
  lines.push('', 'Chi phí: token trong profile Claude Code của repo, theo nhánh của PR, tính theo giá API (bin/lib/prices.json). Anh chạm: anh duyệt, nhãn needs-human, hoặc merge không qua auto-merge.');
  return `${lines.join('\n')}\n`;
}

const QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
number title url body author{login} createdAt mergedAt state headRefName
labels(first:30){nodes{name}}
reviews(first:50){nodes{author{login} state}}
timelineItems(first:100,itemTypes:[LABELED_EVENT,AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT,MERGED_EVENT]){nodes{__typename ... on LabeledEvent{label{name}} ... on MergedEvent{createdAt}}}
commits(first:100){nodes{commit{oid parents{totalCount} checkSuites(first:20){nodes{app{slug} checkRuns(first:40){nodes{name conclusion}}}}}}}}}}`;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

function reposUnder(root) {
  const out = [];
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, name);
    if (!existsSync(join(dir, '.gate/config.sh')) || !existsSync(join(dir, '.git'))) continue;
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = /github\.com[:/](.+?)(\.git)?$/.exec(url);
    if (m) out.push(m[1]);
  }
  return out;
}

function main(argv) {
  const opts = { repos: [], since: null, until: null, mode: 'digest', post: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') opts.repos.push(argv[++i]);
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--until') opts.until = argv[++i];
    else if (a === '--rows') opts.mode = 'rows';
    else if (a === '--digest') opts.mode = 'digest';
    else if (a === '--post') opts.post = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  const day = (d) => d.toISOString().slice(0, 10);
  opts.until ??= day(new Date());
  opts.since ??= day(new Date(Date.parse(opts.until) - 7 * 864e5));
  const root = process.env.FACTORY_ROOT ?? join(here, '..', '..');
  const profiles = process.env.AGENT_PROFILES ?? join(process.env.HOME, '.agent-profiles');
  const human = process.env.FACTORY_HUMAN ?? 'tuannd9288';
  if (!opts.repos.length) opts.repos = reposUnder(root);
  if (!opts.repos.length) throw new Error(`no repository under ${root}; pass --repo owner/name`);

  const rows = [];
  const from = Date.parse(`${opts.since}T00:00:00Z`);
  const to = Date.parse(`${opts.until}T23:59:59Z`);
  for (const repo of opts.repos) {
    const [owner, name] = repo.split('/');
    const profile = join(profiles, name, 'claude');
    const costs = existsSync(profile) ? branchCosts(profile) : null;
    const list = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=all&per_page=100&sort=created&direction=desc`])).flat();
    for (const p of list) {
      const created = Date.parse(p.created_at);
      if (created < from || created > to) continue;
      const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${p.number}`]));
      rows.push(rowOf(repo, data.data.repository.pullRequest, { human, costs, profile: existsSync(profile) }));
    }
  }
  rows.sort((a, b) => a.created.localeCompare(b.created));
  if (opts.mode === 'rows') {
    const head = ['repo', 'pr', 'who', 'tier', 'state', 'rounds', 'first_pass', 'no_red', 'human_touched', 'why', 'cost_usd', 'cost_note', 'hours_to_merge', 'title'];
    console.log(head.join('\t'));
    for (const r of rows)
      console.log([r.repo, r.number, r.who, r.tier ?? '', r.state, r.rounds, r.firstPass ?? '', r.noRed, r.touched, r.touchedWhy, r.cost?.toFixed(4) ?? '', r.costNote, r.hours?.toFixed(2) ?? '', r.title].join('\t'));
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
  const text = digest(rows, { ...opts, secrets });
  if (!opts.post) {
    process.stdout.write(text);
    return;
  }
  const file = join(mkdtempSync(join(tmpdir(), 'digest-')), 'digest.md');
  writeFileSync(file, text);
  gh(['label', 'create', 'digest', '--repo', opts.post, '--force']);
  console.log(gh(['issue', 'create', '--repo', opts.post, '--title', `Bản tin xưởng ${opts.since} → ${opts.until}`, '--label', 'digest', '--body-file', file]).trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`factory-ledger: ${String(error.stderr || error.message).trim()}`);
    process.exit(1);
  }
}
