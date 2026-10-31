// scripts/ship: step 4 of "How a change lands" as one command, idempotent on the branch. Each run finds the branch's
// pull request, or opens one, and takes the next step; it refuses a wrong step with the reason. See scripts/ship.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverAt } from './driver.mjs';

const PLACEHOLDER = '<issue labelled task>';
const FIELDS = 'number,url,baseRefName,baseRefOid,headRefOid,labels,autoMergeRequest,statusCheckRollup';

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

function open(branch, head, args) {
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
  if (!existsSync(redStamp)) {
    say(1, `refused: HEAD ${short} has no red-check stamp against origin/main ${main.slice(0, 7)}; run .gate/bin/red-check --base origin/main`);
    return say(1, dirty);
  }
  const noRed = readFileSync(redStamp, 'utf8').trim();
  const gap = behind(branch, head);
  if (gap) return say(1, `refused: ${gap}`);
  const bodyFile = args.bodyFile ?? '.github/pull_request_template.md';
  if (!existsSync(bodyFile)) return say(1, `refused: the body file ${bodyFile} does not exist`);
  if (readFileSync(bodyFile, 'utf8').includes(PLACEHOLDER))
    return say(1, `refused: the body still holds the template's "Closes #${PLACEHOLDER}"; pass --body-file with the issue number filled in`);
  // red-check passed by a line in the body it was given; CI's red-check reads the body ship sends.
  if (noRed && !readFileSync(bodyFile, 'utf8').split('\n').some((l) => l.trim() === noRed))
    return say(1, `refused: red-check passed by the body's "${noRed}"; the body file lacks that line`);
  const title = args.title ?? git(['log', '-1', '--format=%s']);
  const url = gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile]).trim().split('\n').pop();
  return say(0, `opened #${/(\d+)$/.exec(url)?.[1] ?? '?'} ${url}`);
}

/**
 * Whether the pull request is a tier 3 that waits for the Human: the label tier-3 or raised, or the kit's .gate/bin/tier on
 * the paths, and a tier check that is anything but a SUCCESS (the kit's job fails at once on a tier 3 without his
 * approval, so a red check is the wait). Returns a string when .gate/bin/tier could not judge. The local .gate/bin/tier is
 * advisory: the branch can edit its own policy. GitHub's tier job runs main's copy and labels every pull request
 * tier-<n>, so the labels are the main signal and GitHub still requires the approval.
 */
function tierWait(pr) {
  const names = pr.labels.map((l) => l.name);
  if (!names.includes('tier-3') && !names.includes('raised')) {
    const r = spawnSync('.gate/bin/tier', ['--base', 'origin/main', '--head', 'HEAD', '--labels', names.join(',')], { encoding: 'utf8' });
    if (r.status !== 0) return `.gate/bin/tier exited ${r.status ?? r.signal}`;
    if (!/^tier 3$/m.test(r.stdout ?? '')) return false;
  }
  const tier = (pr.statusCheckRollup ?? []).find((c) => (c.name ?? c.context) === 'tier');
  return !(tier && (tier.conclusion === 'SUCCESS' || tier.state === 'SUCCESS'));
}

/** Main's driver at the pull request's base: an object, null when main names none, undefined when the base is not here. */
function driverOf(pr) {
  const here = () => quietGit(['cat-file', '-e', `${pr.baseRefOid}^{commit}`]);
  if (!here()) spawnSync('git', ['fetch', '--quiet', 'origin', pr.baseRefName], { stdio: 'ignore' });
  return here() ? driverAt(pr.baseRefOid) : undefined;
}

const noteLine = (head) => `not run as a user: no driver (head ${head})`;

/**
 * The pull request's head and its author, and whether a note for that head stands: a comment by the pull request's
 * author, the agents' login, as live-verify's coverage counts a verdict, never edited since (gh's includesCreatedEdit),
 * whose first line is exactly the note. The head is gh's headRefOid, the head coverage() judges a verdict on, not the local
 * HEAD. Anyone can comment, so any other comment, an edited one included, stands for nothing.
 */
function noteOf(n) {
  const view = JSON.parse(gh(['pr', 'view', String(n), '--json', 'author,headRefOid,comments']));
  const author = String(view.author?.login ?? '');
  const stands = Boolean(author) && (view.comments ?? []).some((c) => (
    String(c.author?.login ?? '').toLowerCase() === author.toLowerCase() &&
    c.includesCreatedEdit === false &&
    String(c.body ?? '').replace(/\r/g, '').split('\n')[0] === noteLine(view.headRefOid)
  ));
  return { head: view.headRefOid, author, stands };
}

function postNote(n, head) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-'));
  try {
    writeFileSync(join(dir, 'note.md'), `${noteLine(head)}\n\n.gate/driver.json on main names no driver, so no live verdict was run. The ledger counts this head as a miss.\n`);
    gh(['pr', 'comment', String(n), '--body-file', join(dir, 'note.md')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function step(pr, head, branch) {
  const n = pr.number;
  const short = head.slice(0, 7);
  const armed = Boolean(pr.autoMergeRequest);
  const driver = driverOf(pr);
  if (driver === undefined) return say(2, `could not read .gate/driver.json: the base ${String(pr.baseRefOid).slice(0, 7)} is not here and could not be fetched`);
  const covered = () => (driver ? spawnSync('scripts/live-verify', ['--covered', String(n)], { stdio: 'ignore' }).status === 0 : noteOf(n).stands);
  const how = driver ? 'a live verdict covers it' : 'a no-driver note covers it';
  const known = quietGit(['cat-file', '-e', `${pr.headRefOid}^{commit}`]);
  const ahead = head !== pr.headRefOid && known && !quietGit(['merge-base', '--is-ancestor', head, pr.headRefOid]);

  const disarm = (why) => {
    gh(['pr', 'merge', String(n), '--disable-auto']);
    return say(0, `disarmed #${n}: ${why}`);
  };
  if (armed && ahead) return disarm(`HEAD ${short} is past what was verified; push it, then run ship again`);
  if (armed && !covered()) return disarm(`no ${driver ? 'live verdict' : 'no-driver note'} covers HEAD ${short}; run ship again once it is pushed`);

  if (pr.labels.some((l) => l.name === 'needs-human')) return say(1, `stopped on #${n}: it carries needs-human; the Human decides`);
  const wait = tierWait(pr);
  if (typeof wait === 'string') return say(2, `could not judge the tier (${wait})`);
  const stop = () => (wait ? say(1, `stopped on #${n}: tier 3 waits for the Human's approval`) : 0);
  if (armed) return stop() || say(0, `#${n} is armed and ${how}; nothing to do`);
  if (ahead) return say(1, `refused: HEAD ${short} has commits #${n} lacks; git push first`);

  const gap = behind(branch, head);
  if (gap) return say(1, `refused: ${gap}`);

  // No driver: live-verify would only answer BLOCKED. The note stands for the pull request's head in its place, once, and
  // the run goes on. Never arm a head nobody checked: a local HEAD that is not the pull request's head is refused, and a
  // note that does not count once posted (the author is not this login) stops the run before the arming.
  if (!driver) {
    const note = noteOf(n);
    if (note.head !== head) return say(1, `refused: HEAD ${short} is not the pull request's head ${String(note.head).slice(0, 7)}; pull or push so they agree`);
    if (!note.stands) {
      postNote(n, note.head);
      const posted = noteOf(n);
      if (!posted.stands) return say(1, `stopped on #${n}: the note it posted does not count: the pull request's author (${posted.author}) is not ship's login; nothing was armed`);
    }
  } else if (!covered()) {
    const r = spawnSync('scripts/live-verify', [String(n)], { encoding: 'utf8', maxBuffer: 64 << 20 });
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    if (r.status === 1) return say(1, `refused to arm #${n}: live-verify answered FAIL; fix forward with a red test, then run ship again`);
    // Exit 2 is BLOCKED, which live-verify says in its first words; any other exit 2 is a run that did not happen.
    if (r.status === 2 && /^live-verify: BLOCKED\b/m.test(r.stdout ?? ''))
      return say(2, `stopped on #${n}: live-verify is BLOCKED; put the reason and your recommended answer in the pull request`);
    if (r.status === 2) return say(2, `live-verify could not run on #${n} (exit 2); nothing was armed`);
    if (r.status !== 0) return say(2, `could not run: live-verify exited ${r.status ?? r.signal}`);
  }
  if (pr.baseRefName !== 'main') return say(1, `refused to arm #${n}: its base is ${pr.baseRefName}, not main`);
  gh(['pr', 'merge', String(n), '--auto', '--merge']);
  say(0, driver ? `armed #${n}: a live PASS covers HEAD ${short}` : `armed #${n}: not run as a user, no driver; the note covers HEAD ${short}`);
  return stop();
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--body-file' && argv[i + 1]) out.bodyFile = argv[i + 1];
    else if (argv[i] === '--title' && argv[i + 1]) out.title = argv[i + 1];
    else return null;
  }
  return out;
}

function main(argv) {
  const args = parse(argv);
  if (!args) return say(2, 'usage: scripts/ship [--body-file <file>] [--title <title>]');
  const branch = git(['branch', '--show-current']);
  if (!branch) return say(1, 'refused: HEAD is on no branch');
  if (branch === 'main') return say(1, 'refused: the branch is main; work on a branch of its own');
  const head = git(['rev-parse', 'HEAD']);
  const [pr] = JSON.parse(gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', FIELDS]));
  return pr ? step(pr, head, branch) : open(branch, head, args);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.log(`ship: could not run: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  process.exitCode = 2;
}
