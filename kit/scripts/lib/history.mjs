// What a pull request's history on GitHub says, read with gh: every label it ever had, which removing a label does
// not erase, how many of its head commits the gate judged red, and where a check stands on one commit.
//   node scripts/lib/history.mjs labels --repo <owner/name> --pr <n>                  the labels, comma-separated
//   node scripts/lib/history.mjs rounds --repo <owner/name> --pr <n> --checks <a,b>   commits a named check failed on
//   node scripts/lib/history.mjs check --repo <owner/name> --head <sha> --name <check>
//     the latest GitHub Actions run of that check on the commit: its conclusion, or pending before it completes
// Exit 2 when GitHub cannot be read or the history does not fit one page: a history half read decides nothing. One page
// is decided by pageInfo, not totalCount: totalCount ignores the itemTypes filter (factory-pack-scratch#3, 2026-10-23).
import { execFileSync } from 'node:child_process';

const LABELS = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
timelineItems(first:100,itemTypes:[LABELED_EVENT]){pageInfo{hasNextPage} nodes{... on LabeledEvent{label{name}}}}}}}`;
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
  if (!owner || !name || !(opt('--pr') || opt('--head'))) throw new Error('--repo owner/name and --pr or --head are needed');
  if (args[0] === 'check') {
    const out = execFileSync('gh', ['api', `repos/${owner}/${name}/commits/${opt('--head')}/check-runs?check_name=${opt('--name')}&per_page=100`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runs = JSON.parse(out).check_runs.filter((c) => c.app?.slug === 'github-actions' && c.name === opt('--name'));
    const last = runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))).at(-1);
    console.log(last?.status === 'completed' ? last.conclusion : 'pending');
  } else if (args[0] === 'labels') {
    const items = pull(LABELS).timelineItems;
    if (items.pageInfo?.hasNextPage !== false) throw new Error('the label events are more than one page, or GitHub sent no pageInfo');
    console.log([...new Set(items.nodes.map((n) => n.label?.name).filter(Boolean))].join(','));
  } else if (args[0] === 'rounds') {
    const checks = new Set(opt('--checks').split(',').filter(Boolean));
    const commits = pull(ROUNDS).commits;
    if (commits.pageInfo?.hasPreviousPage !== false) throw new Error('the commits are more than one page, or GitHub sent no pageInfo');
    const red = commits.nodes.filter(({ commit }) =>
      commit.checkSuites.nodes.some((s) => s.app?.slug === 'github-actions' && s.checkRuns.nodes.some((c) => checks.has(c.name) && RED.has(c.conclusion))),
    );
    console.log(red.length);
  } else throw new Error('usage: history.mjs labels|rounds|check --repo owner/name --pr n|--head sha [--checks a,b] [--name c]');
} catch (error) {
  console.log(`history: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  process.exit(2);
}
