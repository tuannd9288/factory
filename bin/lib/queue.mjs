// The factory's merge queue for repositories without GitHub's: the ruleset requires a branch to be up to date, and
// GitHub never updates one by itself, so a pull request waiting on auto-merge strands once another lands. One sweep
// updates one waiting pull request per repository, the oldest first, so the update triggers the gate, and re-runs a
// tier check that failed before the Human approved the head. It follows the repository's merge switch (#333) by state: each
// finished tier check records the position it ran at (an annotation on its own check run, read once for each run in one
// batched query by node id and kept in the state), and the sweep re-runs, once, the
// tier job of any open tier-3 pull request, armed or not, whose recorded position and the one in force (read from the rules the sweep
// fetches already) differ in a way that changes its verdict; what it re-ran is kept in
// $FACTORY_STATE/queue-<owner>-<name>.switch. A pass (runPass) runs once and ends. Since #399 the job's command (`sweep`, no --repo) only makes sure
// the daemon runs (ensureDaemon): the daemon runs the pass every 60 s in a worker thread (bin/lib/daemon.mjs), and `sweep --once` or `--repo` runs one
// by hand, here. A pass that moves the checkout ends the daemon, so the job's next run starts the new code. It reads
// GitHub afresh each time, holds a lock so two sweeps never overlap, bounds every gh call, refuses the Human's login,
// and leaves $FACTORY_STATE/queue-<owner>-<name>.failed until a sweep of that repository succeeds; a run that fails
// before its repository loop leaves queue-run.failed until a run gets that far. A clean sweep writes
// queue-<owner>-<name>.ok, the time the digest shows as that repository's last good sweep.
// With no --repo it sweeps the repositories taken in (#211), found as the ledger finds them (clonesUnder): a folder
// of the factory's root ($FACTORY_ROOT, else this clone) that holds a .git and the kit's .gate/config.sh, named by its
// origin on github.com. None found is a logged sweep of nothing, not an error. --repo gives an explicit list instead.
// The last step, under the lock, writes the events of #309 (bin/lib/events.mjs): one line to $FACTORY_STATE/events.jsonl when a condition
// begins and one when it ends, from what the sweep read and from the Leads and accounts on this host; it adds no gh call. A sixth (#333) tells each move of a
// repository's merge switch, from the position file queue-<owner>-<name>.position (bin/lib/switch-watch.mjs); the factory's own
// repository is read for it too, by its rules alone (one call), where there is a checkout.
// Right after each repository's read it wakes the Lead that holds the issue of a new comment (#351, bin/lib/comment-wake.mjs), from fields
// of the same query: a `comment` start line in the events and one line into the Lead's inbox socket. It adds a gh call only when the claim
// refs read do not name the holder of a fresh comment's issue and there are more of them (claimLookup).
// Beside it, from the same query (which also asks for each open pull request's body and `mergeable` and 10 merged ones),
// it wakes the Lead on its news (#370, bin/lib/news-wake.mjs): a pull request's checks red or all green, a conflict, a merge, and, once
// after the loop, a seat that ended or a run whose process is gone with no record. One `start` line each, one line into the Lead's
// socket, no gh call; the start of a check-not-started condition wakes that pull request's Lead too. The merged ones are the 10 most
// recently updated of the merged pull requests, the query having no order by merge time.
// The news wake also reads every repository that has a team row (teamRows, bin/lib/teams.mjs) and is not taken in, the factory's own
// among them (leadOnly, sweepNews): the rules' required checks and the same one query, then the news wake and the factory's draft readiness (#455, FAC-13) and approval re-run (#456): no branch
// update but a moved draft's (FAC-13), no tier re-run, no comment wake (no claim is held there), no #309 condition, no switch watch beyond watchOwn's. Not with --repo.
// The rules it read for the factory's own repository are handed to watchOwn, so they are read once in a sweep.
// A pull request of the factory's own repository finds its Lead by its `Team:` line (`Team: lead` is `factory-lead`).
// After that, still under the lock, it checks Lead silence on every sweep, then starts the stream reader's pass (#339, bin/lib/reader.mjs) detached, when 15 minutes have passed since
// the last pass began and none runs, and never waits for it; that costs the sweep no gh call.
// See bin/factory-queue for the arguments.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlists, checkoutRoot, followMain } from './checkout.mjs';
import { POSITIONS, pagesOf, positionOf } from '../../kit/.gate/bin/lib/switch.mjs';
import { RED, failedCheck, pickReruns } from './checks.mjs';
import { FIELDS, holders, readCursor, wakeOnComments } from './comment-wake.mjs';
import { MACBOOK_SHARE, noteGh, observe, resetNotes } from './events.mjs';
import { ask, socketPath } from './daemon-proto.mjs';
import { clonesUnder } from './ledger.mjs';
import { MERGED_FIELDS, wakeOnNews, wakeOnSeats, wakeStarted } from './news-wake.mjs';
import { liveRuns, runFiles } from './seat.mjs';
import { clearFailed, markFailed, markOk, repoMarker } from './status.mjs';
import { listStreams } from './streams.mjs';
import { readerSwitch, settingPath, watchSilence } from './reader.mjs';
import { watchSwitch } from './switch-watch.mjs';
import { FACTORY_REPO, teamRows } from './teams.mjs';
import { sweepWorktrees } from './worktrees.mjs';
import { installedRoot, nodeLogin, placeOf } from './node.mjs';
import { holderOf, isHeld, takeLock } from './lock.mjs';

const CALL_MS = 60_000;

/** The pull request to update now, or null: the oldest one waiting on auto-merge behind its base whose required
 * checks did not fail (a failing one needs a new commit, which the gate judges anyway; a red tier check only waits on
 * the Human), unless another one waiting on auto-merge is up to date and still being judged. One that conflicts with
 * its base is not being judged: pull_request never runs on it, so its verify stays missing, and it cannot land until
 * its owner resolves the conflict. A tier-3 one waits behind until its tier check passed, the Human's approval given:
 * his approval then holds on the updated head, whose patch is unchanged, and he is asked once. At the merge switch's
 * position none (#333) every pull request waits for him, so one with no approval from someone other than its author is
 * left behind too: an update would make a new head and call the reviewer again for a pull request that only waits. A
 * required check of another App (#155: Entire's) is read from `apps`; one it concluded other than success has failed:
 * Entire is neutral while it blocks, and an update would only buy another review. */
export function pickUpdate(prs, required, position) {
  const waiting = prs.filter((p) => p.autoMerge && !p.isDraft);
  const check = (p, name) => p.checks[name] ?? p.apps?.[name];
  const judging = (p) => required.some((name) => !check(p, name) || check(p, name).state === 'PENDING');
  const failed = (p) => required.some((name) => name !== 'tier' && failedCheck(p, name));
  const unapproved = (p) =>
    (p.labels.some((l) => l === 'tier-3' || l === 'needs-human') && p.checks.tier?.state !== 'SUCCESS') ||
    (position === 'none' && !p.approvals.some((a) => a.login !== p.author));
  if (waiting.some((p) => !['BEHIND', 'DIRTY'].includes(p.mergeStateStatus) && judging(p))) return null;
  const behind = waiting
    .filter((p) => p.mergeStateStatus === 'BEHIND' && !failed(p) && !unapproved(p))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return behind[0] ?? null;
}

// pickReruns is in bin/lib/checks.mjs, where the wake on a Lead's news reads it too (#370); tests and callers still take it from here.
export { pickReruns };

export const QUERY = `query($owner:String!,$name:String!,$since:DateTime){repository(owner:$owner,name:$name){issues(states:OPEN,labels:["needs-human"],first:50){nodes{number title}} ${FIELDS} ${MERGED_FIELDS} pullRequests(states:OPEN,first:100){nodes{
number isDraft body mergeable createdAt mergeStateStatus baseRefName autoMergeRequest{enabledAt} author{login} headRefOid labels(first:30){nodes{name}}
timelineItems(last:1,itemTypes:[BASE_REF_CHANGED_EVENT,AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]){nodes{... on BaseRefChangedEvent{previousRefName currentRefName createdAt} ... on AutomaticBaseChangeSucceededEvent{previousRefName:oldBase currentRefName:newBase createdAt}}}
reviews(last:50,states:APPROVED){nodes{author{login} commit{oid} submittedAt}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{id databaseId name status conclusion startedAt completedAt detailsUrl checkSuite{app{slug}}}}}}}}}}}}}`;

/** The merge switch records of finished check runs, by node id: one batched query, a few points, for the runs whose record the
 * state does not hold yet. The annotations are not asked in QUERY: they would be counted for every context of every pull
 * request, a hundred times the cost of the rest. */
const recordsQuery = (ids) => `query{nodes(ids:${JSON.stringify(ids)}){... on CheckRun{id databaseId annotations(first:10){nodes{title message}}}}}`;

// A failed call is noted for the events (#309: gh-refused) and thrown as before.
const gh = (args) => {
  try {
    // The query's answer carries the body of up to 110 pull requests (#370), which can pass execFileSync's 1 MiB default.
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CALL_MS, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    noteGh(args, error);
    throw error;
  }
};

/** A check run's state as the queue reads it: its conclusion once completed, PENDING before. */
const stateOf = (run) => (run.status === 'COMPLETED' ? run.conclusion : 'PENDING');

/** The open pull requests and, from the same query, the open issues labelled needs-human (#309), and the claim refs and the issues updated
 * since the comment cursor (`since`, none for all) with their last comments (#351, bin/lib/comment-wake.mjs). */
function openPulls(repo, since) {
  const [owner, name] = repo.split('/');
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, ...(since ? ['-F', `since=${since}`] : [])]));
  const issues = (data.data.repository.issues?.nodes ?? []).map((i) => ({ number: i.number, title: i.title }));
  const prs = data.data.repository.pullRequests.nodes.map((p) => {
    const all = (p.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((c) => c.name);
    const byStart = (a, b) => String(a.startedAt).localeCompare(String(b.startedAt));
    const checks = {};
    for (const run of all.filter((c) => c.checkSuite?.app?.slug === 'github-actions').sort(byStart))
      checks[run.name] = { state: stateOf(run), status: run.status, startedAt: run.startedAt ?? '', jobId: /\/job\/(\d+)/.exec(run.detailsUrl ?? '')?.[1], id: run.databaseId, nodeId: run.id, completedAt: run.completedAt ?? '' };
    // Other Apps' checks, by name (#155: Entire Gates): the latest started wins.
    const apps = {};
    for (const run of all.filter((c) => c.checkSuite?.app?.slug !== 'github-actions').sort(byStart))
      apps[run.name] = { state: stateOf(run), status: run.status, startedAt: run.startedAt ?? '', completedAt: run.completedAt ?? '' };
    return {
      number: p.number,
      isDraft: p.isDraft,
      body: p.body ?? '',
      mergeable: p.mergeable,
      createdAt: p.createdAt,
      mergeStateStatus: p.mergeStateStatus,
      base: p.baseRefName,
      autoMerge: Boolean(p.autoMergeRequest),
      author: p.author?.login,
      head: p.headRefOid,
      baseChange: p.timelineItems?.nodes?.[0],
      labels: p.labels.nodes.map((l) => l.name),
      approvals: p.reviews.nodes.map((r) => ({ login: r.author?.login, oid: r.commit?.oid, at: r.submittedAt })),
      checks,
      apps,
    };
  });
  const merged = (data.data.repository.merged?.nodes ?? []).map((p) => ({ number: p.number, head: p.headRefOid, body: p.body ?? '', mergedAt: p.mergedAt }));
  return { prs, issues, merged, comments: { claims: data.data.repository.claims, recent: data.data.repository.recent } };
}

/** The claim refs of exactly these issues, by name, in one query (#351): for the holders QUERY's first 100 refs did not reach, since GitHub
 * never deletes a claim ref and lists them by name. Returns nodes as QUERY's `claims` has them; a failed call throws. */
function claimLookup(repo, numbers) {
  const [owner, name] = repo.split('/');
  const ok = numbers.filter((n) => Number.isInteger(n) && n > 0);
  const fields = ok.map((n) => `c${n}:ref(qualifiedName:"refs/heads/claim/${n}"){target{... on Commit{messageHeadline}}}`).join(' ');
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, '-F', `owner=${owner}`, '-F', `name=${name}`]));
  const found = data.data.repository;
  return ok.map((n) => ({ name: String(n), target: found[`c${n}`]?.target }));
}

/** The rules in force on main now: one call, which gives the required checks and the merge switch. */
const rulesIn = (repo) => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/rules/branches/main`]));

/** The checks GitHub requires on main, from the rules in force there: what gates the merge, whatever kit the repository has. */
const requiredIn = (rules) => [...new Set(rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters.required_status_checks.map((c) => c.context)))];

// How loose each position is for a tier-3 change: the lower, the looser. Only `all` differs: tier asks the approval at 1-2 and
// at none alike. Only tier 3 follows the switch: the verdict of a tier 1 or 2 check does not depend on it, and at none
// GitHub's own review rule holds those.
const LOOSE = { all: 0, '1-2': 1, none: 1 };

/** The branch the sweep reads the rules for: the switch is read from the rules in force there, and tier reads it from the rules
 * of its own pull request's base, so only a pull request on this base is judged. */
const BASE = 'main';

/** The position a `tier` check run recorded on itself, from its annotations: the last one titled "merge switch" whose message
 * is a position, or undefined. Another notice on the same check run, or a message that is no position, does not count. */
const recordOf = (nodes) => [...(nodes ?? [])].reverse().find((a) => a?.title === 'merge switch' && POSITIONS.includes(a.message))?.message;

/** How long after a run completed a read of its annotations that found no record is believed. */
const SETTLE_MS = 5 * 60_000;

/** Whether a check run completed more than SETTLE_MS ago (one with no completion time counts as long ago). */
const settled = (t) => !(Date.now() - Date.parse(t.completedAt) <= SETTLE_MS);

/** What names one run of the tier check in the state: its id and when it started, so a re-run that kept the id is still told
 * from the run before it. */
const keyOf = (t) => `${t.id ?? t.jobId}:${t.startedAt}`;

/** Why a tier-3 pull request's finished `tier` check is due a re-run for the merge switch (#333), or null. The check records the
 * position it ran at; the queue compares that with the position in force, so a move is seen however many there were between
 * two sweeps, and a job that was running at a move is judged once it ends. 'tighter': it ran at a looser position than the
 * one in force and is not red, so it may hold an approval it skipped. 'looser': it ran at a tighter one and is red, so it may
 * pass now. 'bare': a green check of a tier-3 pull request that records none (a gate that predates the record), only told of;
 * a red one failed before it read the switch and is no hole. Only tier 3 is judged, known by the label or by a record, which
 * only tier 3 makes; a check still running, or whose record could not be read, is left. */
export function switchDue(p, position) {
  const t = p.checks.tier;
  if (!position || !t?.jobId || t.state === 'PENDING' || t.unread) return null;
  if (t.recorded === undefined) return p.labels.includes('tier-3') && !RED.has(t.state) ? 'bare' : null;
  if (LOOSE[t.recorded] < LOOSE[position]) return RED.has(t.state) ? null : 'tighter';
  if (LOOSE[t.recorded] > LOOSE[position]) return RED.has(t.state) ? 'looser' : null;
  return null;
}

/** What the sweep keeps of the merge switch for a repository, in $state/queue-<owner>-<name>.switch: the record of each finished
 * check run read so far (`records`, by keyOf: a position, or '' for none; a finished run's annotations do not change, so each
 * is read once, but a read that found none is kept only five minutes after the run completed), the check runs it re-ran
 * (`done`), the ones whose refused re-run it told (`told`), and the head of each pull request whose unrecorded check it told
 * of (`bare`). A file written by an earlier form of this code reads as empty. */
function switchKept(file) {
  let kept = null;
  try {
    kept = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);
  const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const records = Object.fromEntries(Object.entries(plain(kept?.records)).filter(([, v]) => v === '' || POSITIONS.includes(v)));
  return { records, done: list(kept?.done), told: list(kept?.told), bare: plain(kept?.bare) };
}

/** Reads, in batches of 100 node ids, the records of the finished check runs in `runs`; returns { node id: record or '' }. A batch
 * that fails is told in one line and leaves its runs unread (the next sweep asks again). */
function readRecords(repo, runs) {
  const found = {};
  const ids = runs.map((t) => t.nodeId).filter((id) => /^[\w=+/-]+$/.test(id ?? ''));
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${recordsQuery(ids.slice(i, i + 100))}`]));
      for (const node of data.data?.nodes ?? []) if (node?.id) found[node.id] = recordOf(node.annotations?.nodes) ?? '';
    } catch (error) {
      console.log(`queue: the merge switch records of ${repo} could not be read: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
      break;
    }
  }
  return found;
}

/** Follows the merge switch (#333) by state, from the rules the sweep already fetched: GitHub applies a move at once, but a
 * tier check that ran before it keeps its verdict. On every sweep, each open tier-3 pull request's finished tier check (armed or
 * not, a draft or not, on the branch the rules were read for) is re-run once when the position it recorded and the position in
 * force differ in a way that changes its verdict (switchDue). Each finished run's record is read once, in one batched query,
 * and kept in the state. A re-run records the position in force, which clears the condition; one check run is re-run at most
 * once. A re-run GitHub refuses stays due and is tried again on each sweep, its line printed once. A tier-3 check that
 * records no position is not re-run (a re-run keeps its gate): one line for each head says so. Rules that read as no position
 * change nothing.
 * Returns the numbers of the pull requests re-run, and the position read (undefined when the rules gave none). */
function followSwitch(repo, state, rules, all) {
  let position;
  try {
    position = positionOf(rules);
  } catch (error) {
    console.log(`queue: the merge switch of ${repo} could not be read (${error.message}); no tier check re-run for it`);
    return { ran: new Set(), position: undefined };
  }
  // Copies, with their tier check copied: the records and marks set below are this function's, not the events' (#309).
  const prs = all.filter((p) => p.base === BASE).map((p) => ({ ...p, checks: { ...p.checks, ...(p.checks.tier ? { tier: { ...p.checks.tier } } : {}) } }));
  const file = join(state, `queue-${repo.replace('/', '-')}.switch`);
  const kept = switchKept(file);
  const now = new Set(prs.filter((p) => p.checks.tier).map((p) => keyOf(p.checks.tier)));
  const next = {
    records: Object.fromEntries(Object.entries(kept.records).filter(([k]) => now.has(k))),
    done: kept.done.filter((k) => now.has(k)),
    told: kept.told.filter((k) => now.has(k)),
    bare: Object.fromEntries(Object.entries(kept.bare).filter(([n]) => prs.some((p) => String(p.number) === n))),
  };
  // The record of each finished tier check run is read once, in one batched query for the runs not known yet.
  const unknown = prs.map((p) => p.checks.tier).filter((t) => t?.jobId && t.state !== 'PENDING' && !(keyOf(t) in next.records));
  if (unknown.length) {
    const found = readRecords(repo, unknown);
    // A position is kept at once. A read that found none is kept only for a run that completed a while ago: the annotation
    // listing can trail a finished job, so a younger run is read again next sweep, and not judged until then.
    for (const t of unknown) if (t.nodeId in found && (found[t.nodeId] !== '' || settled(t))) next.records[keyOf(t)] = found[t.nodeId];
  }
  for (const p of prs) {
    const t = p.checks.tier;
    if (!t || t.state === 'PENDING') continue;
    if (keyOf(t) in next.records) t.recorded = next.records[keyOf(t)] || undefined;
    else t.unread = true;
  }
  const ran = new Set();
  for (const p of prs) {
    const due = switchDue(p, position);
    if (!due) continue;
    const t = p.checks.tier;
    const key = keyOf(t);
    if (due === 'bare') {
      // Nothing to re-run: a re-run keeps the original run's gate. Said once for each head.
      if (next.bare[p.number] !== p.head) {
        next.bare[p.number] = p.head;
        console.log(`queue: the tier check of ${repo}#${p.number} records no merge switch position: that repository's gate does not record its position yet`);
      }
      continue;
    }
    if (next.done.includes(key)) continue;
    const why = `because it ran at the merge switch's position ${t.recorded} and ${position} is in force`;
    if (rerun(repo, p.number, t.jobId, why, next.told.includes(key))) {
      next.done.push(key);
      ran.add(p.number);
    } else if (!next.told.includes(key)) next.told.push(key);
  }
  if (JSON.stringify(next) !== JSON.stringify(kept)) {
    mkdirSync(state, { recursive: true });
    writeFileSync(file, JSON.stringify(next));
  }
  return { ran, position };
}

/** Re-runs one approval or tier job and says so; a re-run GitHub refuses (a run over 30 days old, one still in progress) is told in one
 * line, unless `quiet` says it was told already, and returns false, and never stops the sweep. */
function rerun(repo, number, jobId, why, quiet = false, check = 'tier') {
  try {
    gh(['run', 'rerun', '--job', jobId, '--repo', repo]);
  } catch (error) {
    if (!quiet) console.log(`queue: could not re-run the ${check} check of ${repo}#${number} ${why}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    return false;
  }
  console.log(`queue: re-ran the ${check} check of ${repo}#${number} ${why}`);
  return true;
}

/** One repository's sweep. What it read is put in `reads` as soon as the reads succeeded, so a later failed action does not make the
 * read a failed one; a repository whose read failed is not in `reads`, and its conditions stay as they were (#309). The switch is
 * followed after that (#333): its record query and re-runs are not reads of the events, and the pull requests it judges are
 * copies, so what `reads` holds is what the first two reads gave. */
function sweep(repo, reads, state, switches, { self, folder, runs, clone }) {
  const rules = pagesOf(rulesIn(repo));
  const required = requiredIn(rules);
  const asked = new Date().toISOString();
  const { prs, issues, merged, comments } = openPulls(repo, readCursor(state, repo)?.at);
  reads.set(repo, { required, prs, issues, claims: comments.claims?.nodes, folder });
  // The wake on comments (#351) follows the read, and a failure of it never stops the sweep.
  try {
    wakeOnComments({ repo, folder, state, runs, data: comments, self, asked, lookup: (numbers) => claimLookup(repo, numbers) });
  } catch (error) {
    console.log(`queue: the comments of ${repo} were not handled: ${String(error.message).split('\n')[0]}`);
  }
  // So is the wake on the Lead's news (#370), beside it.
  try {
    wakeOnNews({ repo, folder, state, runs, data: { prs, merged, required, claims: comments.claims?.nodes } });
  } catch (error) {
    console.log(`queue: the news of ${repo} was not handled: ${String(error.message).split('\n')[0]}`);
  }
  draftReadiness(repo, prs, clone);
  const { ran, position } = followSwitch(repo, state, rules, prs);
  if (position) switches.set(repo, watchSwitch({ state, repo, position }));
  for (const { number, jobId } of pickReruns(prs).filter((p) => !ran.has(p.number))) rerun(repo, number, jobId, "after its approval or Entire's check");
  const pr = pickUpdate(prs, required, position);
  if (!pr) return;
  gh(['pr', 'update-branch', String(pr.number), '--repo', repo]);
  console.log(`queue: updated ${repo}#${pr.number} to its base`);
}

/** Whether a pull request is a draft moved onto main from another branch, a stack's child (by GitHub when its parent's branch was deleted on
 * merge, or by ship): one that may lack main's merge of its parent. */
export const movedDraft = (pr) => pr.isDraft && pr.base === BASE && pr.baseChange?.currentRefName === BASE && pr.baseChange.previousRefName !== BASE;

function draftReadiness(repo, prs, clone) {
  // Like ship, only origin/main's policy counts, never the candidate's driver file.
  let policy = {};
  if (clone && spawnSync('git', ['-C', clone, 'cat-file', '-e', 'origin/main:.gate/driver.json'], { stdio: 'ignore' }).status === 0)
    policy = JSON.parse(execFileSync('git', ['-C', clone, 'show', 'origin/main:.gate/driver.json'], { encoding: 'utf8' }));
  // FAC-13: a moved draft whose head lacks main's tip is brought up to main by a merge, never a rewrite, so its verify runs on main's
  // merge of its parent before its Lead's ship readies it (INN-38 A). By ancestry, GitHub's compare of main with its head: one whose Lead
  // merged main in has nothing to merge. One that conflicts waits for its Lead. GitHub's edited event already re-runs verify against main
  // on a move; this closes the sweep that reads before that run starts, and a head behind main under an up-to-date rule. With stacks off on
  // main there are no stacks to restack.
  for (const pr of prs.filter((p) => policy.stacks !== 'off' && movedDraft(p) && p.mergeable === 'MERGEABLE')) {
    try {
      if (JSON.parse(gh(['api', `repos/${repo}/compare/${BASE}...${pr.head}`])).behind_by === 0) continue;
      gh(['pr', 'update-branch', String(pr.number), '--repo', repo]);
      console.log(`queue: brought ${repo}#${pr.number}, moved onto ${BASE} from ${pr.baseChange.previousRefName}, up to ${BASE}`);
    } catch (error) {
      console.log(`queue: could not bring ${repo}#${pr.number} up to ${BASE}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
  }
  // FAC-55: a draft is its owner's hold, and readying it is the owner's step (scripts/ship), as in every reference system; the queue never
  // readies one. It only turns a ready pull request whose verify is not green, or that conflicts, back into a draft.
  if ((policy.drafts ?? 'landable') === 'landable') {
    for (const pr of prs) {
      // Only a pull request on main, the base the rulesets guard (#455): a stacked child is left as it is until it is moved to main.
      if (pr.base !== BASE || pr.isDraft) continue;
      if (pr.checks.verify?.state !== 'SUCCESS' || pr.mergeable === 'CONFLICTING') {
        gh(['pr', 'ready', String(pr.number), '--repo', repo, '--undo']);
        pr.isDraft = true;
      }
    }
  }
}

/** The repositories with a team row (teamRows) that are not taken in, for the news wake alone (#370): { repo (owner/name), folder }, the
 * factory's own among them (its folder is FACTORY_REPO and its clone is `root`). `taken` is the set of clone folders the sweep reads in
 * full and `swept` the owner/name list it reads; `origin` names a clone's repository and is passed in for tests. A clone whose origin
 * cannot be read is left out. */
export function leadOnly({ state, root, taken, swept = [], origin = ownRepo }) {
  const out = [];
  for (const folder of new Set(teamRows(state, root).map((t) => t.repo))) {
    if (taken.has(folder)) continue;
    let repo;
    try {
      repo = origin(folder === FACTORY_REPO ? root : join(root, folder));
    } catch {
      continue;
    }
    if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && !swept.includes(repo)) out.push({ repo, folder });
  }
  return out;
}

/** The sweep of a repository that is not taken in, for the news wake alone (#370): the rules' required checks and the same one query, then
 * wakeOnNews, and the factory's draft readiness (#455, FAC-13) and approval re-run (#456). No branch update but a moved draft's, no tier re-run, comment wake, condition for the events or switch watch. Returns the claim
 * holders it read, for a seat's run that names no team. The rules it read are put in `rulesRead` (repo -> pages), for watchOwn, so the
 * factory's own rules are read once in a sweep. */
function sweepNews(repo, folder, state, runs, rulesRead, root) {
  const rules = pagesOf(rulesIn(repo));
  rulesRead.set(repo, rules);
  const required = requiredIn(rules);
  const { prs, merged, comments } = openPulls(repo);
  if (folder === FACTORY_REPO) {
    draftReadiness(repo, prs, root);
    for (const { number, jobId } of pickReruns(prs, 'approval')) rerun(repo, number, jobId, 'after its approval', false, 'approval');
  }
  wakeOnNews({ repo, folder, state, runs, data: { prs, merged, required, claims: comments.claims?.nodes } });
  return holders(comments.claims?.nodes);
}

/** The checks before the repository loop. Their failure leaves $state/queue-run.failed (a name no repository's
 * `queue-<owner>-<name>.failed` can take) with the time and the cause, so the digest shows it; a run that gets past
 * them removes it. Returns the exit code on failure, null to go on; `who.login` is the sweep's own login once it is read. */
function preflight(state, human, who) {
  let why;
  try {
    const login = gh(['api', 'user', '--jq', '.login']).trim();
    who.login = login;
    if (login.toLowerCase() !== human.toLowerCase()) {
      clearFailed(state, 'queue-run');
      return null;
    }
    why = `runs as the agents' account, not the Human's (${human}); log gh in as the agents' account`;
  } catch (error) {
    why = String(error.stderr || error.message).trim();
  }
  markFailed(state, 'queue-run', why);
  console.error(`factory-queue: ${why}`);
  return 2;
}

/** The first step of a sweep (#257): the checkout the daemons and bin/seat run from follows main, and the installed plists are
 * compared with what the code renders. A refusal or a failure is told in queue-checkout.failed and never stops the sweep. Returns whether it
 * moved the checkout (#399: the daemon exits after that pass, so the job's next run starts the new code). */
function followCheckout(state) {
  const home = process.env.HOME;
  const root = checkoutRoot();
  if (!root) return false;
  let moved = false;
  try {
    const r = followMain({ root, state, live: () => liveRuns(process.env.FACTORY_RUNS ?? join(home, 'factory-runs')) });
    if (r.status === 'updated') {
      moved = true;
      console.log(`queue: checkout ${r.from.slice(0, 7)}..${r.to.slice(0, 7)} (${r.behind} commits)`);
    } else if (r.status === 'refused') console.log(`queue: checkout not moved: ${r.why}`);
    else if (r.status !== 'current') console.log(`queue: checkout ${r.status}`);
    const differ = checkPlists({ root, state, plistDir: process.env.FACTORY_PLIST_DIR ?? '/Library/LaunchDaemons' }).differ;
    if (differ.length) console.log(`queue: installed plist differs from the code's: ${differ.join(' ')}`);
  } catch (error) {
    markFailed(state, 'queue-checkout', `the update raised ${error.name}: ${error.message}`);
    console.error(`queue: checkout: ${error.message}`);
  }
  return moved;
}

/** The factory's own repository, named by the origin of the checkout at `root`, or undefined. */
function ownRepo(root) {
  const origin = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(origin)?.[1];
}

/** The merge switch of the factory's own repository (#333), which the sweep does not otherwise read: its rules in force on main, one
 * call, and none of its pull requests. Read on the factory host alone: a node off it (#366) has a checkout of the factory too, its
 * installed copy, and would tell the same move again. Not read where there is no checkout, or when `swept` holds it already. A failure
 * is told in a line and leaves the switch's condition as it was. `rulesRead` holds the rules the news read already took this sweep
 * (repo -> pages): they are used in place of a second read. */
function watchOwn(state, swept, switches, rulesRead = new Map()) {
  if (placeOf() !== 'factory') return;
  const root = checkoutRoot();
  if (!root) return;
  let own;
  try {
    own = ownRepo(root);
    if (!own || swept.includes(own)) return;
    const position = positionOf(rulesRead.get(own) ?? pagesOf(rulesIn(own)));
    switches.set(own, watchSwitch({ state, repo: own, position }));
  } catch (error) {
    console.log(`queue: the merge switch of ${own ?? 'the factory'} could not be read (${String(error.stderr || error.message).trim().split('\n')[0]})`);
  }
}

/** The step after it (#279): the worktrees of landed work go, in the checkout and in each clone under it. Where followCheckout does
 * not run, this does not. A failure is told in queue-worktrees.failed and never stops the sweep. */
function sweepLanded(state) {
  const root = checkoutRoot();
  if (!root) return;
  const merged = (repo) =>
    new Set(JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'merged', '--limit', '1000', '--json', 'headRefName'])).map((p) => p.headRefName));
  try {
    const runs = process.env.FACTORY_RUNS ?? join(process.env.HOME, 'factory-runs');
    // A worktree is held when a live run's folder is its parent: the run files of that folder alone are listed.
    const live = (path) => liveRuns(runs, (dir, ext) => runFiles(dir, ext).filter((f) => path.startsWith(`${dirname(f)}/`)));
    const own = ownRepo(root);
    const clones = [...(own ? [{ repo: own, dir: root }] : []), ...[...clonesUnder(root)].map(([repo, dir]) => ({ repo, dir }))];
    const r = sweepWorktrees({ clones, state, live, merged });
    if (r.removed || r.kept.length) console.log(`queue: worktrees removed ${r.removed}, kept ${r.kept.length}${r.kept.length ? ' (queue-worktrees.failed names them)' : ''}`);
  } catch (error) {
    markFailed(state, 'queue-worktrees', `the sweep raised ${error.name}: ${error.message}`);
    console.error(`queue: worktrees: ${error.message}`);
  }
}

/** The last step of a sweep (#309), under its lock: the conditions written to the events file from what the sweep read and from the
 * Leads and the accounts on this host (bin/lib/events.mjs). A failure is told in queue-events.failed and never changes the sweep's result. */
function recordEvents(state, reads, switches) {
  try {
    const home = process.env.HOME;
    const runs = process.env.FACTORY_RUNS ?? join(home, 'factory-runs');
    const seen = new Set();
    observe({ state, reads, switches, runs, agentProfiles: process.env.AGENT_PROFILES ?? join(home, '.agent-profiles'), onStart: (condition) => wakeStarted({ condition, reads, runs, seen }) });
    clearFailed(state, 'queue-events');
  } catch (error) {
    markFailed(state, 'queue-events', `the events step raised ${error.name}: ${error.message}`);
    console.error(`queue: events: ${error.message}`);
  }
}

export const READER_EVERY_MS = 15 * 60_000;

/** Starts one pass of the stream reader (#339) and returns true, when 15 minutes have passed since the last pass began (`reader/started`, in
 * ms; the pass and this both write it), no pass holds `reader.lock` (bin/lib/lock.mjs), and some stream exists to read. The pass
 * is a node process of its own, detached (a new process group, so launchd does not end it with the sweep), with this process's environment
 * unchanged, and nothing here waits for it. It runs bin/lib/reader.mjs with process.execPath, which is what bin/factory-reader (a bash
 * wrapper that finds node) execs, since a bash script cannot be started with a node path. With no stream there is nothing to read, so no
 * pass starts; the first pass then puts the first streams at their end, as it would have. With reader.json's switch off (INN-39) no pass
 * starts and readerSwitch tells it once; it runs on every sweep, so a cursor a running pass saves after the switch went off goes at the next. */
export function startReader({ state, runs, now = Date.now(), spawnFn = spawn, env = process.env, settingFile = settingPath(env) }) {
  if (readerSwitch({ state, settingFile, now }) === 'off') return false;
  if (isHeld(join(state, 'reader.lock'))) return false;
  let last = 0;
  try {
    last = Number(readFileSync(join(state, 'reader/started'), 'utf8').trim()) || 0;
  } catch {
    // no pass has begun yet
  }
  if (last <= now && now - last < READER_EVERY_MS) return false;
  if (!listStreams(runs).length) return false;
  mkdirSync(join(state, 'reader'), { recursive: true });
  writeFileSync(join(state, 'reader/started'), `${now}\n`);
  const child = spawnFn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'reader.mjs')], { detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
  return true;
}

/** The step after the events: a failure is told in queue-reader.failed and never changes the sweep's result. */
function startReaderPass(state) {
  try {
    startReader({ state, runs: process.env.FACTORY_RUNS ?? join(process.env.HOME, 'factory-runs') });
    clearFailed(state, 'queue-reader');
  } catch (error) {
    markFailed(state, 'queue-reader', `starting the reader raised ${error.name}: ${error.message}`);
    console.error(`queue: reader: ${error.message}`);
  }
}

/** Every sweep checks silence under queue.lock; a failure never changes the sweep's result. */
function checkSilence(state) {
  try {
    watchSilence({ state, runs: process.env.FACTORY_RUNS ?? join(process.env.HOME, 'factory-runs') });
    clearFailed(state, 'queue-silence');
  } catch (error) {
    // markFailed never throws: a marker it cannot write is a line on stderr, so the sweep and its lock go on.
    markFailed(state, 'queue-silence', `checking silence raised ${error.name}: ${error.message}`);
    console.error(`queue: silence: ${error.message}`);
  }
}

const LABEL = 'io.github.tuannd9288.factory.queue';

/** The first executable `name` on a PATH, or null. */
function which(name, path) {
  for (const dir of (path ?? '').split(':').filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}

/** The launchd job that sweeps `repos` once a minute (#48): this clone's bin/factory-queue, with the gh and the node
 * this shell finds first on its PATH, and the variables the sweep reads that this shell sets. launchd starts a job with
 * a bare PATH and does not make its log's folder. A node found through a link (Homebrew's /opt/homebrew/bin) keeps the
 * link's folder, which an upgrade does not remove. `as` makes it another job of this clone (the digest's):
 * its label, tool, verb, log name and interval, more variables to keep and more tools to find on the PATH; the
 * defaults are the queue's own. The digest's job (#209) gives no verb, `args` before the repositories, and a
 * `calendar` (launchd's StartCalendarInterval) in place of the interval. */
export function job(repos, env = process.env, daemon = false, as = {}) {
  const gh = which('gh', env.PATH);
  if (!gh) throw new Error('gh is not on PATH, so the job could not run it');
  const node = which('node', env.PATH) ?? process.execPath;
  const factory = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { label = LABEL, tool = 'bin/factory-queue', verb = 'sweep', log = 'queue.log', interval = 60, calendar = null, args = [], keep = [], tools = [] } = as;
  const extra = tools.map((name) => which(name, env.PATH)).filter(Boolean).map((p) => dirname(p));
  const path = [...new Set([dirname(gh), dirname(node), dirname(process.execPath), ...extra, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const found = which('node', path);
  if (!found || realpathSync(found) !== realpathSync(node))
    throw new Error(`${dirname(gh)}, where gh is, holds another node than this shell's ${node}; put both on one folder first`);
  const kept = Object.fromEntries(['GH_CONFIG_DIR', 'FACTORY_STATE', 'FACTORY_HUMAN', ...keep].filter((k) => env[k]).map((k) => [k, env[k]]));
  // #366: off the factory host the sweep follows the node's installed copy (#390), which checkoutRoot knows only by this name. No token is ever
  // here: the daemon reads the node's own (bin/lib/node.mjs). Its events also go to the share, which Colly, in another user, follows (FAC-43).
  const copy = placeOf(env) === 'factory' ? {} : { FACTORY_CHECKOUT: installedRoot(env), FACTORY_EVENTS_SHARE: MACBOOK_SHARE };
  return {
    label,
    interval: calendar ? null : interval,
    calendar,
    program: [join(factory, tool), ...(verb ? [verb] : []), ...args, ...repos.flatMap((repo) => ['--repo', repo])],
    cwd: factory,
    env: { PATH: path, ...kept, ...copy, ...(daemon ? { HOME: env.HOME } : {}) },
    log: join(env.HOME, 'Library/Logs/factory', log),
    // #24: a LaunchDaemon runs as the account that printed it, the agents' own, with that account's HOME.
    user: daemon ? userInfo().username : null,
  };
}

/** The job as a property list, for ~/Library/LaunchAgents/io.github.tuannd9288.factory.queue.plist, or with a user for
 * /Library/LaunchDaemons/, which the Human loads with sudo. Never KeepAlive: a sweep exits after each run. */
export function plist(j) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const str = (s) => `<string>${esc(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(j.label)}
${j.user ? `  <key>UserName</key>\n  ${str(j.user)}\n` : ''}  <key>ProgramArguments</key>
  <array>
${j.program.map((a) => `    ${str(a)}`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  ${str(j.cwd)}
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(j.env).map(([k, v]) => `    <key>${esc(k)}</key>\n    ${str(v)}`).join('\n')}
  </dict>
${j.calendar
    ? `  <key>StartCalendarInterval</key>\n  <dict>\n${Object.entries(j.calendar).map(([k, v]) => `    <key>${esc(k)}</key>\n    <integer>${v}</integer>`).join('\n')}\n  </dict>\n  <key>RunAtLoad</key>\n  <false/>`
    : `  <key>StartInterval</key>\n  <integer>${j.interval ?? 60}</integer>\n  <key>RunAtLoad</key>\n  <true/>`}
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${str(j.log)}
  <key>StandardErrorPath</key>
  ${str(j.log)}
</dict>
</plist>
`;
}

/** Runs one sweep as the job would, before the Human loads it: the job's PATH and variables over what launchd gives
 * every job (HOME, USER, TMPDIR), and nothing of this shell's. It makes the log's folder, which launchd needs. */
async function check(repos, human) {
  const j = job(repos);
  const say = (line) => console.log(`check: ${line}`);
  // #366: off the factory host the job's sweep runs as the agents, with the node's own token, as the daemon does (bin/lib/node.mjs).
  const agents = nodeLogin(process.env, process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory'));
  if (agents.refusal) {
    say(`not ready: ${agents.refusal}`);
    return 1;
  }
  const env = { HOME: process.env.HOME, USER: process.env.USER ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', ...j.env, ...agents.env };
  mkdirSync(dirname(j.log), { recursive: true });
  const who = spawnSync('gh', ['api', 'user', '--jq', '.login'], { env, encoding: 'utf8', timeout: CALL_MS });
  const login = who.status === 0 ? who.stdout.trim() : '';
  say(`gh login ${login || `none: ${String(who.stderr || who.error?.message || '').trim()}`}`);
  say(`node ${spawnSync('node', ['--version'], { env, encoding: 'utf8' }).stdout?.trim() || 'not found'}`);
  say(`state folder ${env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory')}`);
  say(`log ${j.log}`);
  // One pass in this process, under the lock (--once): the job's own command would hand it to the daemon (#399).
  const run = spawnSync(j.program[0], [...j.program.slice(1), '--once'], { cwd: j.cwd, env, encoding: 'utf8', timeout: 10 * CALL_MS });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  for (const line of out.trim().split('\n').filter(Boolean).slice(-10)) say(`  ${line}`);
  say(`one sweep exited ${run.status}`);
  const up = await ask(socketPath(env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory')), { verb: 'ping' }, { timeoutMs: 1000 });
  say(up.ok ? `the daemon answers (pid ${up.result?.pid})` : `the daemon does not answer (${up.why}); the job starts it`);
  const why = !login
    ? 'gh is not logged in'
    : login.toLowerCase() === human.toLowerCase()
      ? "gh is the Human's login; the job must run as the agents' account"
      : run.status !== 0
        ? 'the sweep failed'
        : /another sweep is running/.test(out)
          ? 'another sweep holds the lock, so this one did nothing; run check again once it ends'
          : null;
  say(why ? `not ready: ${why}` : 'ready; the Human loads the job');
  return why ? 1 : 0;
}

/** One pass of the sweep, under queue.lock, which is what a sweep run by hand (`--once`, `--repo`) and the daemon's pass (bin/lib/daemon.mjs, #399)
 * both run, so they never overlap. Returns { code, heldBy, moved }: the exit code (0 for a pass another sweep's lock kept from running), the claim
 * holders it read ({ clone folder -> holders map }, null if it got no further than the checks before the loop), and whether it moved the checkout. */
export function runPass({ repos = [], human, state }) {
  const held = join(state, 'queue.lock');
  const mine = takeLock(held);
  if (!mine) {
    const other = holderOf(held);
    console.log(`queue: another sweep is running${other ? ` (pid ${other.pid}, started ${other.start})` : ''}; nothing done`);
    return { code: 0, heldBy: null, moved: false };
  }
  const reads = new Map();
  const switches = new Map();
  const out = { code: 0, heldBy: null, moved: false };
  resetNotes();
  try {
    out.moved = followCheckout(state);
    sweepLanded(state);
    const who = { login: '' };
    const refused = preflight(state, human, who);
    if (refused) return { ...out, code: refused };
    // No --repo: the repositories taken in, found as the ledger finds them (#211).
    const skip = (folder, why) => console.log(`queue: skipped ${folder}: ${why}`);
    const clones = clonesUnder(process.env.FACTORY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'), skip);
    const swept = repos.length ? repos : [...clones.keys()];
    const runs = process.env.FACTORY_RUNS ?? join(process.env.HOME, 'factory-runs');
    if (!swept.length) console.log('queue: no repository taken in under the factory root; nothing swept');
    let failed = 0;
    for (const repo of swept) {
      try {
        sweep(repo, reads, state, switches, { self: who.login, clone: clones.get(repo), folder: clones.has(repo) ? basename(clones.get(repo)) : repo.split('/')[1], runs });
        clearFailed(state, repoMarker(repo));
        markOk(state, repoMarker(repo));
      } catch (error) {
        const why = String(error.stderr || error.message).trim();
        markFailed(state, repoMarker(repo), `${repo}: ${why}`);
        console.error(`queue: ${repo}: ${why}`);
        failed += 1;
      }
    }
    // A repository with a team row that is not taken in, the factory's own among them, is read for the news wake alone (#370); not with
    // an explicit --repo list.
    const heldBy = new Map([...reads.values()].map((d) => [d.folder, holders(d.claims)]));
    const rulesRead = new Map();
    if (!repos.length) {
      const root = process.env.FACTORY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      for (const { repo, folder } of leadOnly({ state, root, taken: new Set([...clones.values()].map((d) => basename(d))) })) {
        try {
          heldBy.set(folder, sweepNews(repo, folder, state, runs, rulesRead, root));
        } catch (error) {
          console.log(`queue: the news of ${repo} was not read: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
        }
      }
    }
    // The seats' news (#370) is the host's, not a repository's: once, after the loop, with the claim holders the loop read.
    try {
      wakeOnSeats({ state, runs, heldBy });
    } catch (error) {
      console.log(`queue: the seats' news was not handled: ${String(error.message).split('\n')[0]}`);
    }
    watchOwn(state, swept, switches, rulesRead);
    return { ...out, code: failed ? 1 : 0, heldBy };
  } finally {
    recordEvents(state, reads, switches);
    checkSilence(state);
    startReaderPass(state);
    mine.release();
  }
}

const DAEMON_LOG_MAX = 5 * 1024 * 1024;
const FACTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** The job's sweep (#399): if the daemon answers `ping` on daemon.sock there is nothing to do; if not, start bin/factory-daemon detached, in a
 * session of its own (piggery v0.10.3, internal/cli/daemon_unix.go:11-12), with this process's environment, which is the job's (the pass reads
 * GitHub with it: only the job starts the daemon, known by XPC_SERVICE_NAME, never a seat or a hook, whose environment holds their account's
 * token; any other caller is refused with exit 2), and its output to
 * ~/Library/Logs/factory/daemon.log (moved to daemon.log.1 when over 5 MiB), then wait up to 5 s for it to answer. A daemon that holds daemon.lock
 * and does not answer is told in queue-run.failed and the exit code, and nothing else is started. `ping` and `spawnFn` are passed in for tests.
 * Returns the exit code. */
export async function ensureDaemon(state, { ping = ask, spawnFn = spawn, home = process.env.HOME, waitMs = 5000, env = process.env } = {}) {
  const sock = socketPath(state);
  const answers = async (ms) => (await ping(sock, { verb: 'ping' }, { timeoutMs: ms })).ok;
  if (await answers(1000)) return 0;
  const fail = (why) => {
    markFailed(state, 'queue-run', why);
    console.error(`factory-queue: ${why}`);
    return 1;
  };
  const lock = join(state, 'daemon.lock');
  if (isHeld(lock)) {
    // It may be starting or busy for a moment.
    for (let i = 0; i < 6; i += 1) {
      await pause(waitMs / 10);
      if (await answers(500)) return 0;
    }
    const holder = holderOf(lock);
    return fail(`the daemon${holder ? ` (pid ${holder.pid}, started ${holder.start})` : ''} holds ${lock} and does not answer on ${sock}`);
  }
  // Only the job starts the daemon: it hands the pass its environment, and launchd names the job's label in XPC_SERVICE_NAME. A person or a Lead
  // who runs a bare `sweep` would give the daemon theirs (tokens among them).
  if (env.XPC_SERVICE_NAME !== LABEL) {
    console.error(`factory-queue: no daemon answers, and only the job (${LABEL}) starts one; use \`sweep --once\` to run one pass by hand`);
    return 2;
  }
  const log = join(home, 'Library/Logs/factory/daemon.log');
  mkdirSync(dirname(log), { recursive: true });
  try {
    if (statSync(log).size > DAEMON_LOG_MAX) renameSync(log, `${log}.1`);
  } catch {
    // no log yet
  }
  const fd = openSync(log, 'a', 0o600);
  let failure = null;
  let child;
  try {
    child = spawnFn(join(FACTORY, 'bin/factory-daemon'), [], { detached: true, stdio: ['ignore', fd, fd], cwd: FACTORY, env: { ...process.env, FACTORY_DAEMON_LOG: log } });
    child.on('error', (error) => {
      failure = error.code ?? error.message;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  for (const end = Date.now() + waitMs; Date.now() < end && !failure; ) {
    await pause(waitMs / 25);
    if (await answers(500)) {
      console.log(`queue: started the daemon (pid ${child.pid}); its log is ${log}`);
      return 0;
    }
  }
  return fail(`the daemon did not answer within ${waitMs / 1000} s of its start${failure ? ` (${failure})` : ''}; see ${log}`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const repos = [];
  let daemon = false;
  let once = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--daemon') {
      if (command !== 'plist') throw new Error('--daemon is for plist alone');
      daemon = true;
      continue;
    }
    if (rest[i] === '--once') {
      if (command !== 'sweep') throw new Error('--once is for sweep alone');
      once = true;
      continue;
    }
    if (rest[i] !== '--repo') throw new Error(`unknown argument ${rest[i]}`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(rest[i + 1] ?? '')) throw new Error(`--repo needs owner/name, not ${JSON.stringify(rest[i + 1] ?? '')}`);
    repos.push(rest[++i]);
  }
  if (!['sweep', 'plist', 'check'].includes(command)) throw new Error('usage: factory-queue sweep|plist|check [--repo owner/name...] [--once]');
  const human = process.env.FACTORY_HUMAN ?? 'tuannd9288';
  if (command === 'plist') return void process.stdout.write(plist(job(repos, process.env, daemon)));
  if (command === 'check') return check(repos, human);
  const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
  // The job's command, with no repository named, hosts the pass in the daemon (#399); one named, or --once, runs one pass here.
  if (!repos.length && !once) return ensureDaemon(state);
  return runPass({ repos, human, state }).code;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (error) {
    const why = String(error.stderr || error.message).trim();
    console.error(`factory-queue: ${why}`);
    process.exitCode = 2;
    // Best effort: the digest should show a failure before the repository loop, a plist typo among them. plist and
    // check are the Human's, run by hand, and keep no queue state.
    if (!['plist', 'check'].includes(process.argv[2])) markFailed(process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory'), 'queue-run', why);
  }
}
