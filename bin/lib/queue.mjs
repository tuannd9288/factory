// The factory's merge queue for repositories without GitHub's: the ruleset requires a branch to be up to date, and
// GitHub never updates one by itself, so a pull request waiting on auto-merge strands once another lands. One sweep
// updates one waiting pull request per repository, the oldest first, so the update triggers the gate, and re-runs a
// tier check that failed before the Human approved the head. It runs once and exits: launchd repeats it. It reads
// GitHub afresh each time, holds a lock so two sweeps never overlap, bounds every gh call, refuses the Human's login,
// and leaves $FACTORY_STATE/queue-<owner>-<name>.failed until a sweep of that repository succeeds; a run that fails
// before its repository loop leaves queue-run.failed until a run gets that far. A clean sweep writes
// queue-<owner>-<name>.ok, the time the digest shows as that repository's last good sweep.
// See bin/factory-queue for the arguments.
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const CALL_MS = 60_000;

/** The pull request to update now, or null: the oldest one waiting on auto-merge behind its base whose required
 * checks did not fail (a failing one needs a new commit, which the gate judges anyway; a red tier check only waits on
 * the Human), unless another one waiting on auto-merge is up to date and still being judged. One that conflicts with
 * its base is not being judged: pull_request never runs on it, so its verify stays missing, and it cannot land until
 * its owner resolves the conflict. A tier-3 one waits behind until its tier check passed, the Human's approval given:
 * his approval then holds on the updated head, whose patch is unchanged, and he is asked once. */
export function pickUpdate(prs, required) {
  const waiting = prs.filter((p) => p.autoMerge && !p.isDraft);
  const judging = (p) => required.some((name) => !p.checks[name] || p.checks[name].state === 'PENDING');
  const failed = (p) => required.some((name) => name !== 'tier' && RED.has(p.checks[name]?.state));
  const unapproved = (p) => p.labels.some((l) => l === 'tier-3' || l === 'needs-human') && p.checks.tier?.state !== 'SUCCESS';
  if (waiting.some((p) => !['BEHIND', 'DIRTY'].includes(p.mergeStateStatus) && judging(p))) return null;
  const behind = waiting
    .filter((p) => p.mergeStateStatus === 'BEHIND' && !failed(p) && !unapproved(p))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return behind[0] ?? null;
}

/** The tier jobs to re-run, alone, so no reviewer runs again for a click: a failed tier check on a pull request that
 * someone other than its author approved on the head commit after that check started, so an approval landing while
 * the job ran is not lost. The tier check itself decides whether the approver may approve. */
export function pickReruns(prs) {
  return prs
    .filter((p) => RED.has(p.checks.tier?.state) && p.checks.tier.jobId)
    .filter((p) => p.approvals.some((a) => a.login !== p.author && a.oid === p.head && a.at > p.checks.tier.startedAt))
    .map((p) => ({ number: p.number, jobId: p.checks.tier.jobId }));
}

const QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100){nodes{
number isDraft createdAt mergeStateStatus autoMergeRequest{enabledAt} author{login} headRefOid labels(first:30){nodes{name}}
reviews(last:50,states:APPROVED){nodes{author{login} commit{oid} submittedAt}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name status conclusion startedAt detailsUrl checkSuite{app{slug}}}}}}}}}}}}}`;

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CALL_MS });

/** A check run's state as the queue reads it: its conclusion once completed, PENDING before. */
const stateOf = (run) => (run.status === 'COMPLETED' ? run.conclusion : 'PENDING');

function openPulls(repo) {
  const [owner, name] = repo.split('/');
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`]));
  return data.data.repository.pullRequests.nodes.map((p) => {
    const runs = (p.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((c) => c.name && c.checkSuite?.app?.slug === 'github-actions');
    const checks = {};
    for (const run of runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))))
      checks[run.name] = { state: stateOf(run), startedAt: run.startedAt ?? '', jobId: /\/job\/(\d+)/.exec(run.detailsUrl ?? '')?.[1] };
    return {
      number: p.number,
      isDraft: p.isDraft,
      createdAt: p.createdAt,
      mergeStateStatus: p.mergeStateStatus,
      autoMerge: Boolean(p.autoMergeRequest),
      author: p.author?.login,
      head: p.headRefOid,
      labels: p.labels.nodes.map((l) => l.name),
      approvals: p.reviews.nodes.map((r) => ({ login: r.author?.login, oid: r.commit?.oid, at: r.submittedAt })),
      checks,
    };
  });
}

/** The checks GitHub requires on main now, from the rules in force there: what gates the merge, whatever kit the
 * repository has. */
function requiredOf(repo) {
  const rules = JSON.parse(gh(['api', `repos/${repo}/rules/branches/main`]));
  return [...new Set(rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters.required_status_checks.map((c) => c.context)))];
}

function sweep(repo) {
  const required = requiredOf(repo);
  const prs = openPulls(repo);
  for (const { number, jobId } of pickReruns(prs)) {
    gh(['run', 'rerun', '--job', jobId, '--repo', repo]);
    console.log(`queue: re-ran the tier check of ${repo}#${number} after its approval`);
  }
  const pr = pickUpdate(prs, required);
  if (!pr) return;
  gh(['pr', 'update-branch', String(pr.number), '--repo', repo]);
  console.log(`queue: updated ${repo}#${pr.number} to its base`);
}

/** Takes the lock, or returns false while another sweep holds it; a lock older than ten minutes is a dead sweep's. */
function lock(dir) {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
    return true;
  } catch {
    if (Date.now() - statSync(dir).mtimeMs < 10 * 60_000) return false;
    rmSync(dir, { recursive: true, force: true });
    return lock(dir);
  }
}

/** The checks before the repository loop. Their failure leaves $state/queue-run.failed (a name no repository's
 * `queue-<owner>-<name>.failed` can take) with the time and the cause, so the digest shows it; a run that gets past
 * them removes it. Returns the exit code on failure, null to go on. */
function preflight(state, human) {
  const report = join(state, 'queue-run.failed');
  let why;
  try {
    const login = gh(['api', 'user', '--jq', '.login']).trim();
    if (login.toLowerCase() !== human.toLowerCase()) {
      rmSync(report, { force: true });
      return null;
    }
    why = `runs as the agents' account, not the Human's (${human}); log gh in as the agents' account`;
  } catch (error) {
    why = String(error.stderr || error.message).trim();
  }
  writeFileSync(report, `${new Date().toISOString()} ${why}\n`);
  console.error(`factory-queue: ${why}`);
  return 2;
}

function main(argv) {
  const [command, ...rest] = argv;
  const repos = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--repo') repos.push(rest[++i]);
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (command !== 'sweep' || !repos.length) throw new Error('usage: factory-queue sweep --repo owner/name...');
  const human = process.env.FACTORY_HUMAN ?? 'tuannd9288';
  const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
  const held = join(state, 'queue.lock');
  if (!lock(held)) return console.log('queue: another sweep is running; nothing done');
  try {
    const refused = preflight(state, human);
    if (refused) return refused;
    let failed = 0;
    for (const repo of repos) {
      const report = join(state, `queue-${repo.replace('/', '-')}.failed`);
      try {
        sweep(repo);
        rmSync(report, { force: true });
        writeFileSync(join(state, `queue-${repo.replace('/', '-')}.ok`), `${new Date().toISOString()}\n`);
      } catch (error) {
        const why = String(error.stderr || error.message).trim();
        writeFileSync(report, `${new Date().toISOString()} ${repo}: ${why}\n`);
        console.error(`queue: ${repo}: ${why}`);
        failed += 1;
      }
    }
    return failed ? 1 : 0;
  } finally {
    rmSync(held, { recursive: true, force: true });
  }
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2)) ?? 0;
  } catch (error) {
    console.error(`factory-queue: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 2;
  }
}
