// What a pull request's history on GitHub says, read with gh: every label it ever had, which removing a label does
// not erase, and its last change of base.
//   node .gate/bin/lib/history.mjs labels --repo <owner/name> --pr <n>                  the labels, comma-separated
//   node .gate/bin/lib/history.mjs moved --repo <owner/name> --pr <n>
//     nothing when the base never changed; else `<time> <sha|none>`: when it last changed, by hand or by GitHub when the old base's
//     branch was deleted on merge, and the head of the latest pull request of this repository from the old base into the new one
//     that merged before then (a stack's parent), or none (approval.mjs --moved-at, --parent-head)
// Exit 2 when GitHub cannot be read or the history does not fit one page: a history half read decides nothing. One page
// is decided by pageInfo, not totalCount: totalCount ignores the itemTypes filter (factory-pack-scratch#3, 2026-10-23).
import { gh } from './gh.mjs';

// Not documented: whether pageInfo.hasNextPage counts the itemTypes-filtered list or all timeline items. If all, a pull
// request with more than 100 timeline items of any kind fails closed here: a liveness risk only, never a wrong pass.
const LABELS = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
timelineItems(first:100,itemTypes:[LABELED_EVENT]){pageInfo{hasNextPage} nodes{... on LabeledEvent{createdAt actor{login} label{name}}}}}}}`;
// The last base change only, so no page is left unread; GitHub's event for its own change names the bases oldBase and newBase.
const MOVED = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
timelineItems(last:1,itemTypes:[BASE_REF_CHANGED_EVENT,AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]){nodes{__typename ... on BaseRefChangedEvent{createdAt previousRefName currentRefName}
... on AutomaticBaseChangeSucceededEvent{createdAt previousRefName:oldBase currentRefName:newBase}}}}}}`;
// A parent missed past these (a branch name reused more than 20 times) only leaves the approval asked again.
const PARENT = `query($owner:String!,$name:String!,$head:String!,$base:String!){repository(owner:$owner,name:$name){
pullRequests(states:MERGED,headRefName:$head,baseRefName:$base,first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{headRefOid mergedAt isCrossRepository}}}}`;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const [owner, name] = opt('--repo').split('/');

function pull(query) {
  const out = gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${opt('--pr')}`]);
  const pr = JSON.parse(out).data?.repository?.pullRequest;
  if (!pr) throw new Error(`no pull request #${opt('--pr')} in ${opt('--repo')}`);
  return pr;
}

try {
  if (!owner || !name || !opt('--pr')) throw new Error('--repo owner/name and --pr are needed');
  if (args[0] === 'labels') {
    const items = pull(LABELS).timelineItems;
    if (items.pageInfo?.hasNextPage !== false) throw new Error('the label events are more than one page, or GitHub sent no pageInfo');
    console.log([...new Set(items.nodes.map((n) => n.label?.name).filter(Boolean))].join(','));
  } else if (args[0] === 'moved') {
    const change = pull(MOVED).timelineItems?.nodes?.[0];
    if (change) {
      const { createdAt: at, previousRefName: from, currentRefName: to } = change;
      if (![at, from, to].every((v) => typeof v === 'string' && v)) throw new Error('the last base change has no time or bases');
      const out = gh(['api', 'graphql', '-f', `query=${PARENT}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `head=${from}`, '-f', `base=${to}`]);
      const nodes = JSON.parse(out).data?.repository?.pullRequests?.nodes;
      if (!Array.isArray(nodes)) throw new Error('the merged pull requests of the old base are unreadable');
      const parent = nodes
        .filter((n) => n.isCrossRepository === false && /^[0-9a-f]{40}$/.test(String(n.headRefOid)) && typeof n.mergedAt === 'string' && n.mergedAt <= at)
        .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
        .at(-1);
      console.log(`${at} ${parent?.headRefOid ?? 'none'}`);
    } else console.log('');
  } else throw new Error('usage: history.mjs labels|moved --repo owner/name --pr n');
} catch (error) {
  console.log(`history: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  process.exit(2);
}
