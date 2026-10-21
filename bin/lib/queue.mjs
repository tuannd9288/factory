// The factory's merge queue for repositories without GitHub's: the ruleset requires a branch to be up to date, and
// GitHub never updates one by itself, so a pull request waiting on auto-merge strands once another lands. sweep
// updates one waiting pull request at a time per repository, the oldest first, as the person whose gh is logged in, so
// the update triggers the gate; it also re-runs a tier-3 verdict that failed before the Human approved. pause and resume take auto-merge off every open pull request and put it back, for
// the minutes a ruleset is off during a rollback. See bin/factory-queue for the arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The pull request to update now, or null: the oldest one waiting on auto-merge behind its base whose last
 * judgement did not fail (a failing one needs a new commit, which the gate judges anyway), unless another one waiting
 * on auto-merge is up to date and still being judged. */
export function pickUpdate(prs) {
  const waiting = prs.filter((p) => p.autoMerge && !p.isDraft);
  if (waiting.some((p) => p.mergeStateStatus !== 'BEHIND' && p.checks === 'PENDING')) return null;
  const behind = waiting.filter((p) => p.mergeStateStatus === 'BEHIND' && p.checks !== 'FAILURE').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return behind[0] ?? null;
}

/** The verdict runs to re-run: a failed verdict on a pull request that someone other than its author approved on the
 * head commit after that verdict finished. The verdict itself decides whether the approver may approve. */
export function pickReruns(prs) {
  return prs
    .filter((p) => p.verdict?.conclusion === 'FAILURE' && p.verdict.runId)
    .filter((p) => p.approvals.some((a) => a.login !== p.author && a.oid === p.head && a.at > p.verdict.completedAt))
    .map((p) => ({ number: p.number, runId: p.verdict.runId }));
}

const QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100){nodes{
number isDraft createdAt mergeStateStatus autoMergeRequest{enabledAt} author{login} headRefOid
reviews(last:50,states:APPROVED){nodes{author{login} commit{oid} submittedAt}}
commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:60){nodes{... on CheckRun{name conclusion completedAt detailsUrl}}}}}}}}}}}`;

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function openPulls(repo) {
  const [owner, name] = repo.split('/');
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`]));
  return data.data.repository.pullRequests.nodes.map((p) => {
    const rollup = p.commits.nodes[0]?.commit.statusCheckRollup;
    const verdict = (rollup?.contexts.nodes ?? []).filter((c) => c.name === 'verdict').sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0];
    return {
      number: p.number,
      isDraft: p.isDraft,
      createdAt: p.createdAt,
      mergeStateStatus: p.mergeStateStatus,
      autoMerge: Boolean(p.autoMergeRequest),
      checks: rollup?.state ?? 'PENDING',
      author: p.author?.login,
      head: p.headRefOid,
      approvals: p.reviews.nodes.map((r) => ({ login: r.author?.login, oid: r.commit?.oid, at: r.submittedAt })),
      verdict: verdict && { conclusion: verdict.conclusion, completedAt: verdict.completedAt ?? '', runId: /\/runs\/(\d+)/.exec(verdict.detailsUrl ?? '')?.[1] },
    };
  });
}

function sweep(repo) {
  const prs = openPulls(repo);
  for (const { number, runId } of pickReruns(prs)) {
    gh(['run', 'rerun', runId, '--failed', '--repo', repo]);
    console.log(`queue: re-ran the verdict of ${repo}#${number} after its approval`);
  }
  const pr = pickUpdate(prs);
  if (!pr) return;
  gh(['pr', 'update-branch', String(pr.number), '--repo', repo]);
  console.log(`queue: updated ${repo}#${pr.number} to its base`);
}

const stateFile = (repo) => join(process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory'), `paused-${repo.replace('/', '-')}.json`);

function pause(repo) {
  const file = stateFile(repo);
  const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const now = openPulls(repo).filter((p) => p.autoMerge).map((p) => p.number);
  for (const n of now) gh(['pr', 'merge', String(n), '--repo', repo, '--disable-auto']);
  const all = [...new Set([...before, ...now])].sort((a, b) => a - b);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all)}\n`);
  console.log(`queue: auto-merge off on ${repo} ${all.length ? all.map((n) => `#${n}`).join(' ') : '(none was on)'}; saved in ${file}`);
}

function resume(repo) {
  const file = stateFile(repo);
  if (!existsSync(file)) return console.log(`queue: nothing paused on ${repo}`);
  const open = new Set(openPulls(repo).map((p) => p.number));
  const back = JSON.parse(readFileSync(file, 'utf8')).filter((n) => open.has(n));
  for (const n of back) gh(['pr', 'merge', String(n), '--repo', repo, '--auto', '--merge']);
  rmSync(file);
  console.log(`queue: auto-merge back on ${repo} ${back.length ? back.map((n) => `#${n}`).join(' ') : '(none still open)'}`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const repos = [];
  let every = 0;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--repo') repos.push(rest[++i]);
    else if (rest[i] === '--every') every = Number(rest[++i]);
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  const run = { sweep, pause, resume }[command];
  if (!run || !repos.length) throw new Error('usage: factory-queue sweep|pause|resume --repo owner/name... [--every seconds]');
  const once = () => {
    for (const repo of repos) {
      try {
        run(repo);
      } catch (error) {
        console.error(`queue: ${repo}: ${String(error.stderr || error.message).trim()}`);
        if (!every) process.exitCode = 1;
      }
    }
  };
  once();
  if (every && command === 'sweep') setInterval(once, every * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`factory-queue: ${error.message}`);
    process.exit(2);
  }
}
