// What a pull request's history on GitHub says, read with gh: every label it ever had, which removing a label does
// not erase, how many of its head commits the gate judged red, and where a check stands on one commit.
//   node scripts/lib/history.mjs labels --repo <owner/name> --pr <n>                  the labels, comma-separated
//   node scripts/lib/history.mjs rounds --repo <owner/name> --pr <n> --checks <a,b>   commits a named check failed on
//   node scripts/lib/history.mjs check --repo <owner/name> --head <sha> --name <check>
//     the latest GitHub Actions run of that check on the commit: its conclusion, or pending before it completes
//   node scripts/lib/history.mjs raised-at --repo <owner/name> --pr <n>     when the Actions bot first added the label raised, or nothing
//   node scripts/lib/history.mjs raise --repo <owner/name> --run <id> --head <sha>
//     `pending` while the `review` job of that run has not completed; then `ok` or `red` (its latest attempt's
//     conclusion) and `none`, `absent` (it left no result annotation) or `raise <why>`, from its annotation titled
//     review-result. The job is found through the run, its check run through check_run_url, never by name on the head,
//     where a candidate's own job may carry the name too. A raise in any completed review of any gate-trusted run on the
//     head, this run's earlier attempts included, also counts, since an edited event cancels the run whose tier had not
//     labelled yet; the runs listed for the head must hold this run, or it fails closed.
//   node scripts/lib/history.mjs verdict --repo <owner/name> --run <id> --head <sha> --base <sha>
//     `pending` while the `review` job of that run has not completed; then `ok` or `red` and `pass`, `block`, `mismatch`
//     (its review-verdict annotation names another head or base), `absent` (it left none) or `unavailable <class>`.
//     `verdict` passes only on `ok pass`: it makes no reviewer call of its own.
//   node scripts/lib/history.mjs reuse --repo <owner/name> --run <id> --head <sha> --base <sha> --nored <hash|none> --reviewer <name>
//     `reuse pass|block <run> <result>` when a completed review of a gate-trusted run on the head already judged this head,
//     base and No-red line as this reviewer (its review-verdict annotation names all four), `none` otherwise: one call per head.
//     Only runs of the event pull_request_target are read.
// Exit 2 when GitHub cannot be read or the history does not fit one page: a history half read decides nothing. One page
// is decided by pageInfo, not totalCount: totalCount ignores the itemTypes filter (factory-pack-scratch#3, 2026-10-23).
import { execFileSync } from 'node:child_process';

// Not documented: whether pageInfo.hasNextPage counts the itemTypes-filtered list or all timeline items. If all, a pull
// request with more than 100 timeline items of any kind fails closed here: a liveness risk only, never a wrong pass.
const LABELS = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
timelineItems(first:100,itemTypes:[LABELED_EVENT]){pageInfo{hasNextPage} nodes{... on LabeledEvent{createdAt actor{login} label{name}}}}}}}`;
const ROUNDS = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
commits(last:100){pageInfo{hasPreviousPage} nodes{commit{oid checkSuites(first:20){nodes{app{slug} checkRuns(first:50){nodes{databaseId name conclusion}}}}}}}}}}`;
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
/** What a completed review reported: none, absent (no result annotation), unavailable <class>, or raise <why>; only the annotation titled
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
  if (/^unavailable: [a-z-]{1,30}$/.test(message)) return `unavailable ${message.slice(13)}`;
  throw new Error('the review result annotation is neither none nor raise: <why> nor unavailable: <class>');
};
/** The review-verdict annotation of a completed review (`head=<sha> base=<sha> pass|block`), or null; one at most. */
const verdictOf = (job) => {
const notes = api(`${base}/check-runs/${job.checkRun}/annotations?per_page=100`);
if (!Array.isArray(notes) || notes.length >= 100) throw new Error('the review annotations are more than one page, or unreadable');
const mine = notes.filter((n) => n.title === 'review-verdict' && n.annotation_level === 'notice');
if (mine.length > 1) throw new Error('the review left more than one verdict annotation');
return mine.length ? String(mine[0].message) : null;
};

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
    const ownAll = reviewsOf(opt('--run'));
    const own = ownAll.at(-1);
    if (!own) throw new Error(`run ${opt('--run')} has no review job`);
    if (own.status !== 'completed') console.log('pending');
    else {
      let found = resultOf(own);
      // A raise found in any completed review, of any attempt, of any gate-trusted run on this head counts, this run's
      // earlier attempts too: an edited event starts a run that cancels the one whose tier had not labelled yet, and
      // "Re-run all jobs" asks the reviewer again. A raise found anywhere only raises. The listing must hold this run:
      // if GitHub did not report the pull request's head as the run's head_sha, it would be empty and the union a
      // silent no-op, so this check fails closed instead.
      const runs = api(`${base}/actions/workflows/gate-trusted.yml/runs?head_sha=${opt('--head')}&per_page=100`);
      if (!Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) throw new Error('the runs on this head are more than one page, or unreadable');
      if (!runs.workflow_runs.some((r) => String(r.id) === String(opt('--run'))))
        throw new Error(`the runs listed for head ${String(opt('--head')).slice(0, 8)} do not include run ${opt('--run')}, so the union of raises cannot be trusted and this check fails closed`);
      for (const run of runs.workflow_runs)
        for (const job of (String(run.id) === String(opt('--run')) ? ownAll : reviewsOf(run.id)).filter((j) => j.status === 'completed' && j !== own)) {
          const other = resultOf(job);
          if (other.startsWith('raise ') && !found.startsWith('raise ')) found = other;
        }
      console.log(`${own.conclusion === 'success' ? 'ok' : 'red'} ${found}`);
    }
  } else if (args[0] === 'verdict') {
    const own = reviewsOf(opt('--run')).at(-1);
    if (!own) throw new Error(`run ${opt('--run')} has no review job`);
    if (own.status !== 'completed') console.log('pending');
    else {
      const state = own.conclusion === 'success' ? 'ok' : 'red';
      const result = resultOf(own);
      const verdict = result.startsWith('unavailable ') ? null : verdictOf(own);
      if (result.startsWith('unavailable ')) console.log(`${state} ${result}`);
      else if (verdict === null) console.log(`${state} absent`);
      else {
        const m = /^head=([0-9a-f]{40}) base=([0-9a-f]{40})(?: nored=(?:[0-9a-f]+|none))?(?: reviewer=[a-z-]*)? (pass|block)$/.exec(verdict);
        if (!m) throw new Error('the review verdict annotation is not head=<sha> base=<sha> [nored=<hash>] pass|block');
        console.log(m[1] !== opt('--head') || m[2] !== opt('--base') ? `${state} mismatch` : `${state} ${m[3]}`);
      }
    }
  } else if (args[0] === 'reuse') {
    // The latest completed review of any gate-trusted run on this head whose verdict names this head, base and No-red line.
    const runs = api(`${base}/actions/workflows/gate-trusted.yml/runs?head_sha=${opt('--head')}&per_page=100`);
    if (!Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) throw new Error('the runs on this head are more than one page, or unreadable');
    const found = [];
    // Only a run of pull_request_target is main's workflow, run with main's scripts: a pull_request run takes the workflow file
    // of the branch it is built from, which can print any annotation (the raise union above only ever raises, so it may read them).
    for (const run of runs.workflow_runs.filter((r) => r.event === 'pull_request_target'))
      for (const job of reviewsOf(run.id).filter((j) => j.status === 'completed')) {
        const m = /^head=([0-9a-f]{40}) base=([0-9a-f]{40}) nored=([0-9a-f]+|none) reviewer=([a-z-]+) (pass|block)$/.exec(verdictOf(job) ?? '');
        if (!m || m[1] !== opt('--head') || m[2] !== opt('--base') || m[3] !== opt('--nored') || m[4] !== opt('--reviewer')) continue;
        const result = resultOf(job);
        if (!result.startsWith('unavailable ') && result !== 'absent') found.push({ at: String(job.completed_at ?? ''), line: `reuse ${m[5]} ${run.id} ${result}` });
      }
    console.log(found.sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.line ?? 'none');
  } else if (args[0] === 'labels') {
    const items = pull(LABELS).timelineItems;
    if (items.pageInfo?.hasNextPage !== false) throw new Error('the label events are more than one page, or GitHub sent no pageInfo');
    console.log([...new Set(items.nodes.map((n) => n.label?.name).filter(Boolean))].join(','));
  } else if (args[0] === 'raised-at') {
    const items = pull(LABELS).timelineItems;
    if (items.pageInfo?.hasNextPage !== false) throw new Error('the label events are more than one page, or GitHub sent no pageInfo');
    // Only the Actions bot's raise counts: a raised label another account added early would let an earlier approval
    // stand. tier removes the label before it adds it, so its own event always exists; an event with no actor does not count.
    const times = items.nodes.filter((n) => n.label?.name === 'raised' && n.actor?.login === 'github-actions').map((n) => n.createdAt);
    if (times.some((t) => typeof t !== 'string' || !t)) throw new Error('a raised label event has no createdAt');
    console.log(times.sort()[0] ?? '');
  } else if (args[0] === 'rounds') {
    const checks = new Set(opt('--checks').split(',').filter(Boolean));
    // A review or verdict that ended because the reviewer was unavailable judged nothing: it is no round. Its annotations are
    // read by REST (asking for them in the query would cost 1,021 points of the 1,000 an hour), for red runs of those two only.
    const onlyUnavailable = (c) =>
      (c.name === 'review' || c.name === 'verdict') &&
      Number.isInteger(c.databaseId) &&
      api(`${base}/check-runs/${c.databaseId}/annotations?per_page=100`).some((n) => n.title === 'review-result' && n.annotation_level === 'notice' && /^unavailable: /.test(String(n.message)));
    const commits = pull(ROUNDS).commits;
    if (commits.pageInfo?.hasPreviousPage !== false) throw new Error('the commits are more than one page, or GitHub sent no pageInfo');
    const red = commits.nodes.filter(({ commit }) =>
      commit.checkSuites.nodes.some((s) => s.app?.slug === 'github-actions' && s.checkRuns.nodes.some((c) => checks.has(c.name) && RED.has(c.conclusion) && !onlyUnavailable(c))),
    );
    console.log(red.length);
  } else throw new Error('usage: history.mjs labels|raised-at|rounds|check|raise|verdict|reuse --repo owner/name --pr n|--head sha|--run id [--checks a,b] [--name c]');
} catch (error) {
  console.log(`history: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  process.exit(2);
}
