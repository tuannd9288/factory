// scripts/ship: step 4 of "How a change lands" as one command, idempotent on the branch. Each run finds the branch's
// pull request, or opens one, and takes the next step; it refuses a wrong step with the reason. See scripts/ship.
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Installed, this file is a repository's scripts/lib/ship.mjs, beside the kit's .gate/. In the factory it runs from the pack's own source,
// packs/pstack/scripts/lib/, and the kit is under kit/ (FAC-14): the same subject rules scripts/verify applies, and no red-check, since the
// factory has no .gate/config.sh; its CI runs scripts/verify.
const installed = existsSync(new URL('../../.gate/bin/lib/subject.mjs', import.meta.url));
const FACTORY = !installed && existsSync(new URL('../../../../kit/.gate/bin/lib/subject.mjs', import.meta.url));
const { subjectProblem, titleProblem } = await import(FACTORY ? '../../../../kit/.gate/bin/lib/subject.mjs' : '../../.gate/bin/lib/subject.mjs');

// The template's issue lines. A body for a repository on Linear carries `Fixes <KEY>` and `Issue: <KEY>` in their place and passes (#404).
const PLACEHOLDER = '<issue labelled task>';
const FIELDS = 'number,title,url,baseRefName,headRefOid,labels,isDraft,mergeable,autoMergeRequest,statusCheckRollup';
// gh pr merge --auto merges these outright, whatever the repository's auto-merge setting.
const READY = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'];

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const quietGit = (args) => spawnSync('git', args, { stdio: 'ignore' }).status === 0;
const say = (code, line) => {
  console.log(`ship: ${line}`);
  return code;
};

/** Why origin's copy of the branch is not HEAD, or '' when it is: GitHub judges the remote head, not the local one. */
function behind(branch, head) {
  const line = git(['ls-remote', 'origin', `refs/heads/${branch}`]).split('\n')[0];
  const remote = line.split(/\s/)[0];
  if (!remote) return `origin has no branch ${branch}; push HEAD first`;
  if (remote === head) return '';
  const at = `origin/${branch} is at ${remote.slice(0, 7)}`;
  // Fetch that one ref: origin's commit is in HEAD's history (HEAD is ahead: push) or it is not (origin has what HEAD lacks: pull).
  const fetched = spawnSync('git', ['fetch', '--quiet', 'origin', `refs/heads/${branch}`], { stdio: 'ignore' }).status === 0 && quietGit(['cat-file', '-e', `${remote}^{commit}`]);
  if (!fetched) return `${at}, not HEAD ${head.slice(0, 7)}; push HEAD first, or pull, if origin is ahead`;
  if (quietGit(['merge-base', '--is-ancestor', remote, head])) return `${at}, not HEAD ${head.slice(0, 7)}; push HEAD first`;
  return `${at}, which HEAD ${head.slice(0, 7)} does not contain; pull first`;
}

function open(branch, head, args, drafts) {
  const short = head.slice(0, 7);
  const stamps = join(git(['rev-parse', '--absolute-git-dir']), 'factory');
  const dirty = 'if the work tree is not clean, commit or remove what `git status` shows';
  let main;
  try {
    main = git(['rev-parse', '--verify', 'origin/main^{commit}']);
  } catch {
    return say(1, 'refused: there is no origin/main to judge the head against; fetch it');
  }
  const redStamp = join(stamps, `red-check-${head}-${main}`);
  if (!FACTORY && !existsSync(redStamp)) {
    say(1, `refused: HEAD ${short} has no red-check stamp against origin/main ${main.slice(0, 7)}; run .gate/bin/red-check --base origin/main`);
    return say(1, dirty);
  }
  const noRed = FACTORY ? '' : readFileSync(redStamp, 'utf8').trim();
  const gap = behind(branch, head);
  if (gap) return say(1, `refused: ${gap}`);
  const bodyFile = args.bodyFile ?? '.github/pull_request_template.md';
  if (!existsSync(bodyFile)) return say(1, `refused: the body file ${bodyFile} does not exist`);
  if (readFileSync(bodyFile, 'utf8').includes(PLACEHOLDER))
    return say(1, `refused: the body still holds the template's "Closes #${PLACEHOLDER}"; pass --body-file with the issue number filled in`);
  // red-check passed by a line in the body it was given; CI's red-check reads the body ship sends.
  if (noRed && !readFileSync(bodyFile, 'utf8').split('\n').some((l) => l.trim() === noRed))
    return say(1, `refused: red-check passed by the body's "${noRed}"; the body file lacks that line`);
  // The title carries no issue number: Linear shows the pull request's own, and the issue is in the body.
  const title = args.title ?? git(['log', '-1', '--format=%s']).replace(/ \(#\d+\)$/, '');
  const problem = titleProblem(title);
  if (problem) return say(1, `refused title: ${problem}`);
  const url = gh(['pr', 'create', '--base', args.base ?? 'main', '--head', branch, '--title', title, '--body-file', bodyFile, ...(drafts === 'landable' ? ['--draft'] : [])]).trim().split('\n').pop();
  return say(0, `opened #${/(\d+)$/.exec(url)?.[1] ?? '?'} ${url}`);
}

/**
 * Whether the pull request is a tier 3 that waits for the Human: the label tier-3 or raised, or the kit's .gate/bin/tier on
 * the paths, and a tier check that is anything but a SUCCESS (the kit's job waits for the review, then fails on a
 * tier 3 without his approval where the merge switch asks it, so a red check is the wait). Returns a string when .gate/bin/tier could not judge. The local .gate/bin/tier is
 * advisory: the branch can edit its own policy. GitHub's tier job runs main's copy and labels every pull request
 * tier-<n>, so the labels are the main signal and GitHub still requires the approval.
 */
function tierWait(pr) {
  // The factory's own pull requests all wait for the Human (its CODEOWNERS), and its root has no .gate/bin/tier.
  if (FACTORY) return true;
  const names = pr.labels.map((l) => l.name);
  if (!names.includes('tier-3') && !names.includes('raised')) {
    const r = spawnSync('.gate/bin/tier', ['--base', 'origin/main', '--head', 'HEAD', '--labels', names.join(',')], { encoding: 'utf8' });
    if (r.status !== 0) return `.gate/bin/tier exited ${r.status ?? r.signal}`;
    if (!/^tier 3$/m.test(r.stdout ?? '')) return false;
  }
  const tier = (pr.statusCheckRollup ?? []).find((c) => (c.name ?? c.context) === 'tier');
  return !(tier && (tier.conclusion === 'SUCCESS' || tier.state === 'SUCCESS'));
}

/** The latest run of a check on the pull request's head, by start time: a re-run's, not the run it replaced. */
const latest = (pr, name) =>
  (pr.statusCheckRollup ?? []).filter((c) => (c.name ?? c.context) === name).sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''))).at(-1);

// The pull request's last base change and its head commit; a change GitHub made itself, when the old base's branch was deleted on merge,
// names the bases oldBase and newBase.
const MOVED = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){'
  + 'timelineItems(last:1,itemTypes:[BASE_REF_CHANGED_EVENT,AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]){nodes{'
  + '... on BaseRefChangedEvent{previousRefName currentRefName createdAt} ... on AutomaticBaseChangeSucceededEvent{previousRefName:oldBase currentRefName:newBase createdAt}}}}}}';

/**
 * Why a draft is not readied yet, or '' (FAC-55): verify has not passed on its head, it conflicts with main, or it is a stack's child moved
 * onto main that INN-38 A (2026-11-07 07:33:46 +07) holds: its parent has not landed on main, or its head does not hold the commit that
 * landed it, so it is not restacked yet (by ancestry, never a committer's clock). The queue's merge of main into it restacks it.
 */
function draftWait(pr) {
  const verify = latest(pr, 'verify');
  if (!(verify && (verify.conclusion === 'SUCCESS' || verify.state === 'SUCCESS'))) return 'verify has not passed on its head';
  if (pr.mergeable === 'CONFLICTING') return 'it conflicts with main; merge main into it and push';
  const data = JSON.parse(gh(['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${pr.number}`, '-f', `query=${MOVED}`]));
  const move = data.data?.repository?.pullRequest?.timelineItems?.nodes?.[0];
  if (!move || move.currentRefName !== 'main' || move.previousRefName === 'main') return '';
  const parents = JSON.parse(gh(['pr', 'list', '--head', move.previousRefName, '--base', 'main', '--state', 'merged', '--json', 'headRefOid,mergeCommit']));
  const landings = parents.map((p) => p.mergeCommit?.oid).filter(Boolean);
  if (!landings.length) return `it moved onto main, and its parent ${move.previousRefName} has not landed there`;
  for (const oid of [pr.headRefOid, ...landings])
    if (!quietGit(['cat-file', '-e', `${oid}^{commit}`])) spawnSync('git', ['fetch', '--quiet', 'origin', oid], { stdio: 'ignore' });
  if (landings.some((oid) => quietGit(['merge-base', '--is-ancestor', oid, pr.headRefOid]))) return '';
  return `its parent ${move.previousRefName} landed, and its head does not hold that landing: the queue's restack, its merge of main into it, is pending`;
}

function step(pr, head, branch, stacks, merge, drafts) {
  const n = pr.number;
  const short = head.slice(0, 7);
  const armed = Boolean(pr.autoMergeRequest);
  if (stacks && pr.baseRefName !== 'main') {
    if (armed) {
      gh(['pr', 'merge', String(n), '--disable-auto']);
      return say(0, `disarmed #${n}: its base is ${pr.baseRefName}, not main`);
    }
    const parents = JSON.parse(gh(['pr', 'list', '--head', pr.baseRefName, '--base', 'main', '--state', 'merged', '--json', 'headRefOid']));
    if (!parents.length) return say(0, `#${n} waits for its parent ${pr.baseRefName}; nothing was armed`);
    git(['fetch', '--quiet', 'origin', 'main']);
    if (merge === 'merge' && !parents.some((p) => quietGit(['merge-base', '--is-ancestor', p.headRefOid, 'origin/main'])))
      return say(0, `#${n} waits for its parent ${pr.baseRefName} in origin/main; nothing was armed`);
    // Only the move, which GitHub makes itself where the parent's branch is deleted on merge: the queue then merges main into the child,
    // by a merge for either method, never a rewrite.
    gh(['pr', 'edit', String(n), '--base', 'main']);
    return say(0, `retargeted #${n} to main; the queue merges main into it, then pull before your next commit and run ship again`);
  }
  const problem = titleProblem(pr.title) || (merge === 'squash' && subjectProblem(`${pr.title} (#${n})`));
  if (problem) return say(1, `refused title for #${n}: ${problem}`);
  // A draft is its owner's hold, and readying it is the owner's step, as in every reference system (FAC-55): the queue only turns a red or
  // conflicting pull request back into a draft. ship readies it, just before it arms it, once nothing below stops the arming.
  const hold = pr.isDraft ? draftWait(pr) : '';
  if (hold) return say(0, `#${n} stays a draft: ${hold}; run ship again then`);
  const known = quietGit(['cat-file', '-e', `${pr.headRefOid}^{commit}`]);
  const ahead = head !== pr.headRefOid && known && !quietGit(['merge-base', '--is-ancestor', head, pr.headRefOid]);

  const disarm = (why) => {
    gh(['pr', 'merge', String(n), '--disable-auto']);
    return say(0, `disarmed #${n}: ${why}`);
  };
  if (armed && ahead) return disarm(`HEAD ${short} is past what was verified; push it, then run ship again`);

  if (pr.labels.some((l) => l.name === 'needs-human')) return say(1, `stopped on #${n}: it carries needs-human; the Human decides`);
  const wait = tierWait(pr);
  if (typeof wait === 'string') return say(2, `could not judge the tier (${wait})`);
  const stop = () => (wait ? say(1, `stopped on #${n}: tier 3 waits for the Human's approval (unless the merge switch is at all)`) : 0);
  if (armed) return stop() || say(0, `#${n} is armed; nothing to do`);
  if (ahead) return say(1, `refused: HEAD ${short} has commits #${n} lacks; git push first`);

  const gap = behind(branch, head);
  if (gap) return say(1, `refused: ${gap}`);

  if (pr.baseRefName !== 'main') return say(1, `refused to arm #${n}: its base is ${pr.baseRefName}, not main`);
  // A draft is readied and armed at once, as the queue did before FAC-55. A pull request that was ready already is read fresh: CI may have
  // ended, and arming a ready pull request would merge it.
  if (pr.isDraft) gh(['pr', 'ready', String(n)]);
  else if (READY.includes(JSON.parse(gh(['pr', 'view', String(n), '--json', 'mergeStateStatus'])).mergeStateStatus))
    return say(1, `stopped on #${n}: it is ready to merge and not armed; the Human merges it`);
  try {
    // --match-head-commit reaches enablePullRequestAutoMerge's expectedHeadOid (gh 2.102.0, pkg/cmd/pr/merge/http.go:77-95): only the head judged here lands.
    gh(['pr', 'merge', String(n), '--auto', `--${merge}`, '--match-head-commit', pr.headRefOid]);
  } catch (error) {
    if (!String(error.stderr).includes('Auto merge is not allowed for this repository')) throw error;
    return say(1, `stopped on #${n}: auto-merge is off on this repository; the Human merges it`);
  }
  say(0, `armed #${n} at HEAD ${short}`);
  return stop();
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--body-file' && argv[i + 1]) out.bodyFile = argv[i + 1];
    else if (argv[i] === '--base' && argv[i + 1]) out.base = argv[i + 1];
    else if (argv[i] === '--title' && argv[i + 1]) out.title = argv[i + 1];
    else return null;
  }
  return out;
}

function main(argv) {
  const args = parse(argv);
  if (!args) return say(2, 'usage: scripts/ship [--body-file <file>] [--title <title>] [--base <parent-branch>]');
  const branch = git(['branch', '--show-current']);
  if (!branch) return say(1, 'refused: HEAD is on no branch');
  if (branch === 'main') return say(1, 'refused: the branch is main; work on a branch of its own');
  const head = git(['rev-parse', 'HEAD']);
  const [pr] = JSON.parse(gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', FIELDS]));
  // Only trunk's policy counts; the candidate cannot enable stacks for itself.
  const policy = quietGit(['cat-file', '-e', 'origin/main:.gate/driver.json'])
    ? JSON.parse(git(['show', 'origin/main:.gate/driver.json'])) : {};
  policy.drafts ??= 'landable';
  const stacks = policy.stacks !== 'off';
  // main's driver names the merge method; with none, the repository's own: merge commits where squash is not allowed (the factory), else
  // squash, as the queue armed before FAC-55.
  const methods = () => JSON.parse(gh(['repo', 'view', '--json', 'squashMergeAllowed,mergeCommitAllowed']));
  const merge = policy.merge != null ? (policy.merge === 'merge' ? 'merge' : 'squash')
    : pr && ((m) => !m.squashMergeAllowed && m.mergeCommitAllowed)(methods()) ? 'merge' : 'squash';
  if (!pr && !stacks && args.base && args.base !== 'main')
    return say(1, `refused to open: its base is ${args.base}, not main`);
  return pr ? step(pr, head, branch, stacks, merge, policy.drafts) : open(branch, head, args, policy.drafts);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.log(`ship: could not run: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  process.exitCode = 2;
}
