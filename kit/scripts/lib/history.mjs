// What a pull request's history on GitHub says, read with gh: every label it ever had, which removing a label does
// not erase, how many of its head commits the gate judged red, and where a check stands on one commit.
//   node scripts/lib/history.mjs labels --repo <owner/name> --pr <n>                  the labels, comma-separated
//   node scripts/lib/history.mjs rounds --repo <owner/name> --pr <n> --checks <a,b>   commits a named check failed on
//   node scripts/lib/history.mjs check --repo <owner/name> --head <sha> --name <check>
//     the latest GitHub Actions run of that check on the commit: its conclusion, or pending before it completes
//   node scripts/lib/history.mjs raised-at --repo <owner/name> --pr <n>     when the label raised was first added, or nothing
//   node scripts/lib/history.mjs raise --repo <owner/name> --run <id> --head <sha>
//     `pending` while the `review` job of that run has not completed; then `ok` or `red` (its latest attempt's
//     conclusion) and `none`, `absent` (it left no result annotation) or `raise <why>`, from its annotation titled
//     review-result. The job is found through the run, its check run through check_run_url, never by name on the head,
//     where a candidate's own job may carry the name too. A raise in any completed review of any gate-trusted run on the
//     head also counts, since an edited event cancels the run whose tier had not labelled yet.
// Exit 2 when GitHub cannot be read or the history does not fit one page: a history half read decides nothing. One page
// is decided by pageInfo, not totalCount: totalCount ignores the itemTypes filter (factory-pack-scratch#3, 2026-10-23).
import { execFileSync } from 'node:child_process';

// Not documented: whether pageInfo.hasNextPage counts the itemTypes-filtered list or all timeline items. If all, a pull
// request with more than 100 timeline items of any kind fails closed here: a liveness risk only, never a wrong pass.
const LABELS = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
timelineItems(first:100,itemTypes:[LABELED_EVENT]){pageInfo{hasNextPage} nodes{... on LabeledEvent{createdAt label{name}}}}}}}`;
const ROUNDS = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
commits(last:100){pageInfo{hasPreviousPage} nodes{commit{oid checkSuites(first:20){nodes{app{slug} checkRuns(first:50){nodes{name conclusion}}}}}}}}}}`;
const RED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const [owner, name] = opt('--repo').split('/');

function pull(query) {
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${opt('--pr')}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pr = JSON.parse(out).data?.repository?.pullRequest;
  if (!pr) throw new Error(`no pull request #${opt('--pr')} in ${opt('--repo')}`);
  return pr;
}

try {
  if (!owner || !name || !(opt('--pr') || opt('--head') || opt('--run'))) throw new Error('--repo owner/name and --pr, --head or --run are needed');
  if (args[0] === 'check') {
    const out = execFileSync('gh', ['api', `repos/${owner}/${name}/commits/${opt('--head')}/check-runs?check_name=${opt('--name')}&per_page=100`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runs = JSON.parse(out).check_runs.filter((c) => c.app?.slug === 'github-actions' && c.name === opt('--name'));
    const last = runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))).at(-1);
    console.log(last?.status === 'completed' ? last.conclusion : 'pending');
  } else if (args[0] === 'raise') {
    const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const base = `repos/${owner}/${name}`;
    // Model text is one line with `##[` broken, as result.mjs prints it: it reaches tier's log and step summary.
    const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, ' ').replace(/##\[/g, '## [').trim().slice(0, 500);
    const reviewsOf = (run) => {
      const listing = api(`${base}/actions/runs/${run}/jobs?filter=all&per_page=100`);
      if (!Array.isArray(listing.jobs) || listing.total_count !== listing.jobs.length) throw new Error(`the jobs of run ${run} are more than one page, or unreadable`);
      return listing.jobs
        .filter((j) => j.name === 'review')
        .map((j) => {
          const id = /\/check-runs\/(\d+)$/.exec(String(j.check_run_url ?? ''))?.[1];
          if (!id || !Number.isInteger(j.run_attempt)) throw new Error(`a review job of run ${run} lacks its check_run_url or run_attempt`);
          return { ...j, checkRun: id };
        })
        .sort((a, b) => a.run_attempt - b.run_attempt);
    };
    /** What a completed review reported: none, absent (no result annotation), or raise <why>; only the annotation titled
     * review-result at level notice counts, and exactly one may exist. */
    const resultOf = (job) => {
      const notes = api(`${base}/check-runs/${job.checkRun}/annotations?per_page=100`);
      if (!Array.isArray(notes) || notes.length >= 100) throw new Error('the review annotations are more than one page, or unreadable');
      const mine = notes.filter((n) => n.title === 'review-result' && n.annotation_level === 'notice');
      if (mine.length > 1) throw new Error('the review left more than one result annotation');
      if (!mine.length) return 'absent';
      const message = String(mine[0].message);
      if (message === 'none') return 'none';
      if (message.startsWith('raise: ')) return `raise ${clean(message.slice(7))}`;
      throw new Error('the review result annotation is neither none nor raise: <why>');
    };
    const own = reviewsOf(opt('--run')).at(-1);
    if (!own) throw new Error(`run ${opt('--run')} has no review job`);
    if (own.status !== 'completed') console.log('pending');
    else {
      let found = resultOf(own);
      // A raise found in any completed review of any gate-trusted run on this head counts: an edited event starts a run
      // that cancels the one whose tier had not labelled yet, and a raise found anywhere only raises.
      const runs = api(`${base}/actions/workflows/gate-trusted.yml/runs?head_sha=${opt('--head')}&per_page=100`);
      if (!Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) throw new Error('the runs on this head are more than one page, or unreadable');
      for (const run of runs.workflow_runs.filter((r) => String(r.id) !== String(opt('--run'))))
        for (const job of reviewsOf(run.id).filter((j) => j.status === 'completed')) {
          const other = resultOf(job);
          if (other.startsWith('raise ') && !found.startsWith('raise ')) found = other;
        }
      console.log(`${own.conclusion === 'success' ? 'ok' : 'red'} ${found}`);
    }
  } else if (args[0] === 'labels') {
    const items = pull(LABELS).timelineItems;
    if (items.pageInfo?.hasNextPage !== false) throw new Error('the label events are more than one page, or GitHub sent no pageInfo');
    console.log([...new Set(items.nodes.map((n) => n.label?.name).filter(Boolean))].join(','));
  } else if (args[0] === 'raised-at') {
    const items = pull(LABELS).timelineItems;
    if (items.pageInfo?.hasNextPage !== false) throw new Error('the label events are more than one page, or GitHub sent no pageInfo');
    const times = items.nodes.filter((n) => n.label?.name === 'raised').map((n) => n.createdAt);
    if (times.some((t) => typeof t !== 'string' || !t)) throw new Error('a raised label event has no createdAt');
    console.log(times.sort()[0] ?? '');
  } else if (args[0] === 'rounds') {
    const checks = new Set(opt('--checks').split(',').filter(Boolean));
    const commits = pull(ROUNDS).commits;
    if (commits.pageInfo?.hasPreviousPage !== false) throw new Error('the commits are more than one page, or GitHub sent no pageInfo');
    const red = commits.nodes.filter(({ commit }) =>
      commit.checkSuites.nodes.some((s) => s.app?.slug === 'github-actions' && s.checkRuns.nodes.some((c) => checks.has(c.name) && RED.has(c.conclusion))),
    );
    console.log(red.length);
  } else throw new Error('usage: history.mjs labels|raised-at|rounds|check|raise --repo owner/name --pr n|--head sha|--run id [--checks a,b] [--name c]');
} catch (error) {
  console.log(`history: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  process.exit(2);
}
