// Scores probe pull requests on the scratch repository from the gate's own runs, one tab-separated line each, and says
// what the reviewer cost. It reads GitHub with gh pr, gh run list and gh run view only: no gh api.
//   node probes/score.mjs --repo <owner/name> <pr>...
//   pr <n> caught|missed|pending   caught: the pull request did not merge and a required check failed on its head
//   job <n> <name> <conclusion> <minutes>   the job's run time, rounded up to a whole minute: what Actions bills for it
//   minutes <n> <total>
//   quota <n> <line>   the reviewer's own line about a quota or rate-limit event in its stream (or that there was none)
// It stops at the first head whose reviewer was unavailable (a usage limit, a bad token, a timeout): that head is not
// scored, no later one is read, and the exit is 3. The run is resumed by naming the later pull requests again.
// Run the first four heads alone by naming only those four.
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

for (const n of prs) {
  const pr = JSON.parse(gh('pr', 'view', n, '--repo', repo, '--json', 'state,headRefOid,statusCheckRollup'));
  const [run] = JSON.parse(gh('run', 'list', '--repo', repo, '--workflow', 'gate-trusted.yml', '--commit', pr.headRefOid, '--json', 'databaseId', '--limit', '1'));
  if (!run) {
    console.log(`pr\t${n}\tpending`);
    continue;
  }
  const log = gh('run', 'view', String(run.databaseId), '--repo', repo, '--log');
  const down = /reviewer unavailable \(([a-z-]+)\)/.exec(log);
  if (down) {
    console.log(`STOP\t${n}\treviewer unavailable (${down[1]}); this head is not scored`);
    process.exit(3);
  }
  const failed = (pr.statusCheckRollup ?? []).some((c) => REQUIRED.has(c.name) && c.conclusion === 'FAILURE');
  const done = (pr.statusCheckRollup ?? []).filter((c) => REQUIRED.has(c.name) && c.conclusion).length === REQUIRED.size;
  console.log(`pr\t${n}\t${pr.state !== 'MERGED' && failed ? 'caught' : pr.state === 'MERGED' || done ? 'missed' : 'pending'}`);
  let total = 0;
  for (const j of JSON.parse(gh('run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs')).jobs) {
    const minutes = Math.max(1, Math.ceil((Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 60_000));
    total += minutes;
    console.log(`job\t${n}\t${j.name}\t${j.conclusion}\t${minutes}`);
  }
  console.log(`minutes\t${n}\t${total}`);
  for (const line of log.split('\n').map((l) => l.replace(/^.*?\t.*?\t/, '')).filter((l) => /reviewer: (quota event|no quota)/.test(l)))
    console.log(`quota\t${n}\t${line.trim()}`);
}
