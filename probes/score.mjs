// Scores probe pull requests on the scratch repository from the gate's own runs, one tab-separated line each, and says
// what the reviewer cost. It reads GitHub with gh pr, gh run list and gh run view only: no gh api.
//   node probes/score.mjs --repo <owner/name> <pr>...
//   pr <n> caught|missed|pending   caught: the pull request did not merge and a required check failed on its head
//   job <n> <name> <conclusion> <minutes>   the job's run time rounded up to a whole minute: what Actions bills for it;
//        0 for a skipped job, ? when GitHub gave no times
//   minutes <n> <total> gate-trusted.yml jobs only, not gate.yml's verify
//   usage <n> <line>   the reviewer's own line on what one call spent: its tokens and total_cost_usd (one per call)
// It stops at the first head whose reviewer was unavailable (a usage limit, a bad token, a timeout): that head is not
// scored, no later one is read, its usage lines are printed before STOP, and the exit is 3. The run is resumed by naming
// the later pull requests again. Run the first four heads alone by naming only those four. A run still in progress is
// pending. Once its log can be read, a merged pull request scores missed: a merged probe was not blocked, whatever
// check GitHub still shows running or failed.
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const repo = args[args.indexOf('--repo') + 1];
const prs = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--repo');
if (!repo || !prs.length) {
  console.error('usage: score.mjs --repo <owner/name> <pr>...');
  process.exit(2);
}
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const REQUIRED = new Set(['verify', 'review', 'verdict', 'tier']);
// `gh run view --log` prints `job<TAB>step<TAB>timestamp message`; a plain line has no fields. The reviewer's own lines
// start the message, so a model's claim that quotes them is not one.
const messageOf = (line) => line.replace(/^[^\t]*\t[^\t]*\t/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trim();

for (const n of prs) {
  const pr = JSON.parse(gh('pr', 'view', n, '--repo', repo, '--json', 'state,headRefOid,statusCheckRollup'));
  // The newest run on the head by createdAt, not the first gh lists.
  const run = JSON.parse(gh('run', 'list', '--repo', repo, '--workflow', 'gate-trusted.yml', '--commit', pr.headRefOid, '--json', 'databaseId,createdAt', '--limit', '20')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  let log;
  try {
    log = run ? gh('run', 'view', String(run.databaseId), '--repo', repo, '--log') : null;
  } catch {
    log = null; // a run still in progress has no log to read yet
  }
  if (log === null) {
    console.log(`pr\t${n}\tpending`);
    continue;
  }
  const messages = log.split('\n').map(messageOf);
  const usage = messages.filter((m) => /^reviewer: usage: /.test(m));
  const down = messages.map((m) => /^(?:review|verdict): reviewer unavailable \(([a-z-]+)\)/.exec(m)).find(Boolean);
  if (down) {
    for (const line of usage) console.log(`usage\t${n}\t${line}`);
    console.log(`STOP\t${n}\treviewer unavailable (${down[1]}); this head is not scored`);
    process.exit(3);
  }
  // The rollup keeps the check runs of every earlier run on the head. gh gives a running check status IN_PROGRESS (or QUEUED),
  // conclusion "" and completedAt 0001-01-01: such an entry makes the head pending, whatever older entries say. Of completed
  // entries only the latest of each required check counts: by completedAt, then startedAt, then the later place in the rollup.
  const time = (t) => (typeof t === 'string' && Date.parse(t) > Date.parse('0002-01-01T00:00:00Z') ? Date.parse(t) : 0);
  const entries = (pr.statusCheckRollup ?? []).filter((c) => REQUIRED.has(c.name));
  const running = entries.some((c) => (c.status !== undefined && c.status !== 'COMPLETED') || (c.completedAt !== undefined && !time(c.completedAt)));
  const latest = new Map();
  for (const c of entries) {
    const key = [time(c.completedAt), time(c.startedAt)];
    const old = latest.get(c.name);
    if (!old || key[0] > old.key[0] || (key[0] === old.key[0] && key[1] >= old.key[1])) latest.set(c.name, { key, conclusion: c.conclusion });
  }
  const failed = !running && [...latest.values()].some((c) => c.conclusion === 'FAILURE');
  const done = !running && [...latest.values()].filter((c) => c.conclusion).length === REQUIRED.size;
  console.log(`pr\t${n}\t${pr.state === 'MERGED' ? 'missed' : running ? 'pending' : failed ? 'caught' : done ? 'missed' : 'pending'}`);
  let total = 0;
  for (const j of JSON.parse(gh('run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs')).jobs) {
    const ms = Date.parse(j.completedAt) - Date.parse(j.startedAt);
    const minutes = j.conclusion === 'skipped' ? 0 : Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 60_000)) : '?';
    if (minutes !== '?') total += minutes;
    console.log(`job\t${n}\t${j.name}\t${j.conclusion}\t${minutes}`);
  }
  console.log(`minutes\t${n}\t${total}\tgate-trusted.yml jobs only, not gate.yml's verify`);
  for (const line of usage) console.log(`usage\t${n}\t${line}`);
}
