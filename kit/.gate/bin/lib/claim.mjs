// A claim on an issue is the ref refs/heads/claim/<n> on origin, taken by a push GitHub accepts once. The tip's subject is the
// state: `claim <n> <team>`, `handoff <n> <team>` (the holder is <team>) or `release <n>`. Every commit is an empty one made with
// git commit-tree, so no work tree or index is touched, and is pushed as a fast-forward: never `+`, `--force` or a delete.
//   .gate/bin/claim <n> <team>                        take issue <n>; refused, naming the holder, while it is held
//   .gate/bin/claim --release <n> <team|--human>      the holder (or the Human, with admin rights) lets it go
//   .gate/bin/claim --handoff <n> <from|--human> <to> the holder (or the Human) gives it to another team
//   .gate/bin/claim --list [--all]                    the held claims; --all adds the released ones
// A success prints `Claim: <sha>`, the line for the pull request. After a release or handoff it disarms the auto-merge of each
// open pull request that names the issue and re-runs its `tier` check, which then reads the moved ref (a warning, never a
// failure, when that cannot be done). GitHub keeps the ref created once, never rewritten, never deleted (the rulesets
// factory-branches and factory-claims); it does not know who pushed, so who may release is this command's rule and the
// Human's, cooperative under one login. Porcelain gh only, never `gh api`.
// Exit 0 done, 1 refused, 2 usage or something it could not read.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claim as claimLine, isTeam, issue as issueLine } from './prbody.mjs';

class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const git = (...args) => run('git', args);
const gitOut = (...args) => {
  const r = git(...args);
  if (r.status !== 0) throw new Stop(`git ${args[0]} failed: ${String(r.stderr).trim().split('\n')[0]}`, 2);
  return r.stdout.trim();
};
const gh = (...args) => run('gh', args);
const ghJson = (...args) => {
  const r = gh(...args);
  if (r.status !== 0) throw new Stop(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr).trim().split('\n')[0]}`, 2);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Stop(`gh ${args.slice(0, 2).join(' ')} did not print JSON`, 2);
  }
};

const refOf = (n) => `refs/heads/claim/${n}`;
const short = (sha) => sha.slice(0, 7);
/** One line, no control characters and no workflow command, cut to 72. */
export const oneLine = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').replace(/##\[/g, '## [').trim().slice(0, 72);

/** What a tip's subject says about claim n. */
export function stateOf(n, subject) {
  const held = /^(claim|handoff) ([1-9]\d*) (\S+)$/.exec(subject);
  if (held && Number(held[2]) === n && isTeam(held[3])) return { state: held[1] === 'claim' ? 'claimed' : 'handed-off', team: held[3] };
  const released = /^release ([1-9]\d*)$/.exec(subject);
  if (released && Number(released[1]) === n) return { state: 'released', team: null };
  return { state: 'invalid', team: null };
}

/** The sha origin gives the ref of exactly this full name, or ''. `git ls-remote origin <pattern>` matches the pattern against the
 * tail of a ref name, so refs/heads/claim/5 also finds a branch named a/refs/heads/claim/5: only the line whose name is the ref counts. */
const shaOf = (out, ref) => out.split('\n').map((line) => line.split('\t')).find(([, name]) => name === ref)?.[0] ?? '';

/** The tip of claim n on origin, read from origin itself, with its subject and date; sha is null when there is no claim. */
export function tipOf(n, net = []) {
  const sha = shaOf(gitOut(...net, 'ls-remote', 'origin', refOf(n)), refOf(n));
  if (!sha) return { sha: null };
  gitOut(...net, 'fetch', '--quiet', 'origin', refOf(n));
  const [subject, date] = gitOut('log', '-1', '--format=%s%x09%cI', sha).split('\t');
  return { sha, subject, date, ...stateOf(n, subject) };
}

function mainTip() {
  const sha = shaOf(gitOut('ls-remote', 'origin', 'refs/heads/main'), 'refs/heads/main');
  if (!sha) throw new Stop('origin has no main', 2);
  gitOut('fetch', '--quiet', 'origin', 'refs/heads/main');
  return sha;
}

/** An empty commit on parent, with this subject. */
const commitOn = (parent, subject) => gitOut('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', subject);
const push = (n, sha) => git('push', '--quiet', 'origin', `${sha}:${refOf(n)}`).status === 0;

const refuseHeld = (n, tip) => {
  if (tip.state === 'invalid') return new Stop(`claim: ${refOf(n)} holds a commit no form of claim wrote ("${oneLine(tip.subject)}", ${short(tip.sha)}); the Human decides`);
  return new Stop(`claim: #${n} is held by ${tip.team} (${short(tip.sha)}, ${tip.date})`);
};

function comment(n, lines) {
  const dir = mkdtempSync(join(tmpdir(), 'claim-'));
  try {
    writeFileSync(join(dir, 'body.md'), `${lines.join('\n')}\n`);
    const r = gh('issue', 'comment', String(n), '--body-file', join(dir, 'body.md'));
    if (r.status !== 0) console.log(`claim: warning: the comment on #${n} failed (${String(r.stderr).trim().split('\n')[0]}); the claim stands, since the ref is the claim`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function take(n, team) {
  const issue = ghJson('issue', 'view', String(n), '--json', 'state,labels');
  if (issue?.state !== 'OPEN') throw new Stop(`claim: #${n} is not open`);
  if (!Array.isArray(issue.labels) || !issue.labels.some((l) => l?.name === 'task')) throw new Stop(`claim: #${n} is not labelled task`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tip = tipOf(n);
    if (tip.sha && tip.state !== 'released') throw refuseHeld(n, tip);
    const sha = commitOn(tip.sha ?? mainTip(), `claim ${n} ${team}`);
    if (!push(n, sha)) continue; // lost the race: read the winner and refuse naming it
    comment(n, [`claim: ${team} at ${sha}`, '', `Work on #${n} goes on a branch \`${team}/${n}-<slug>\`; its pull request says \`Issue: #${n}\`, \`Claim: ${sha}\` and \`Team: ${team}\`.`]);
    console.log(`claim: #${n} held by ${team} at ${short(sha)}`);
    console.log(`Claim: ${sha}`);
    return;
  }
  throw new Stop(`claim: #${n} could not be taken: the push was refused twice`);
}

/** Whether the login running gh has admin rights on the repository: the Human's. */
function isAdmin() {
  return ghJson('repo', 'view', '--json', 'viewerPermission')?.viewerPermission === 'ADMIN';
}

function authorize(n, tip, who) {
  if (!tip.sha || (tip.state !== 'claimed' && tip.state !== 'handed-off')) throw new Stop(`claim: #${n} is held by no one`);
  if (who === '--human') {
    if (!isAdmin()) throw new Stop(`claim: --human needs admin rights on this repository; only the holder (${tip.team}) or the Human releases #${n}`);
  } else if (who !== tip.team) throw new Stop(`claim: #${n} is held by ${tip.team}, not ${who}; only the holder or the Human releases it`);
}

function move(n, tip, subject, said) {
  const sha = commitOn(tip.sha, subject);
  if (!push(n, sha)) throw new Stop(`claim: ${refOf(n)} moved while this was pushed; read it again with --list`);
  comment(n, [`${said} at ${sha}`]);
  console.log(`claim: ${subject} at ${short(sha)}`);
  console.log(`Claim: ${sha}`);
  rerun(n);
}

/** Each open pull request naming the issue loses its auto-merge and has its `tier` run again, so it reads the moved ref now. */
function rerun(n) {
  const warn = (text) => console.log(`claim: warning: ${text}`);
  const r = gh('pr', 'list', '--state', 'open', '--search', `"Issue: #${n}" in:body`, '--json', 'number,headRefOid,body');
  let prs;
  try {
    if (r.status !== 0) throw new Error(String(r.stderr).trim().split('\n')[0]);
    prs = JSON.parse(r.stdout);
  } catch (error) {
    return warn(`the pull requests naming #${n} could not be listed (${error.message}); their tier checks read the claim at their next run`);
  }
  for (const pr of prs) {
    const named = issueLine(pr.body);
    if (!(named.ok && named.kind === 'number' && named.number === n)) continue;
    gh('pr', 'merge', String(pr.number), '--disable-auto');
    try {
      const run = ghJson('run', 'list', '--workflow', 'gate-trusted.yml', '--commit', pr.headRefOid, '--limit', '1', '--json', 'databaseId,status')[0];
      if (!run) throw new Error('no run of gate-trusted.yml for its head');
      const tier = ghJson('run', 'view', String(run.databaseId), '--json', 'jobs').jobs.find((j) => j.name === 'tier');
      if (!tier) throw new Error('no tier job in its run');
      const again = gh('run', 'rerun', '--job', String(tier.databaseId));
      if (again.status !== 0) throw new Error(String(again.stderr).trim().split('\n')[0]);
      console.log(`claim: re-ran the tier check of #${pr.number}`);
    } catch (error) {
      warn(`the tier check of #${pr.number} was not re-run (${error.message}); it reads the claim at its next run`);
    }
  }
}

function list(all) {
  const out = gitOut('ls-remote', 'origin', 'refs/heads/claim/*');
  const rows = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const n = /^[0-9a-f]+\trefs\/heads\/claim\/([1-9]\d*)$/.exec(line)?.[1];
    if (n) rows.push(Number(n));
  }
  for (const n of rows.sort((a, b) => a - b)) {
    const tip = tipOf(n);
    if (!tip.sha || (tip.state === 'released' && !all)) continue;
    console.log([n, tip.state, tip.team ?? '-', short(tip.sha), tip.date].join('\t'));
  }
}

// The git options of the trusted jobs, whose checkout keeps no credential (the helper of gate-trusted.yml's fetch steps).
const JOB_NET = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

/** The tier job's check of one pull request: its Issue: and Claim: lines against the tip of claim/<n>, read now. */
export function check(repo, pr) {
  const view = ghJson('pr', 'view', pr, '--repo', repo, '--json', 'closingIssuesReferences,body');
  if (typeof view?.body !== 'string' || !Array.isArray(view.closingIssuesReferences)) throw new Stop('tier: the pull request body and closing issues could not be read', 2);
  const red = (text) => new Stop(`tier: claim: ${text}`);
  const named = issueLine(view.body);
  if (!named.ok) throw red('the pull request body needs one line "Issue: #<n>" or "Issue: none"');
  const here = view.closingIssuesReferences
    .filter((r) => `${r?.repository?.owner?.login}/${r?.repository?.name}`.toLowerCase() === repo.toLowerCase())
    .map((r) => r.number);
  if (named.kind === 'none') {
    if (here.length) throw red(`the body says "Issue: none" but the pull request closes #${here[0]}`);
    return console.log('tier: claim: Issue: none, so there is no claim to check');
  }
  const n = named.number;
  const other = here.find((c) => c !== n);
  if (other) throw red(`the body names #${n} but the pull request closes #${other}; one pull request is for one issue`);
  const line = claimLine(view.body);
  if (!line.ok) throw red(`the body needs one line "Claim: <sha>" for #${n}; run .gate/bin/claim ${n} <team>`);
  const tip = tipOf(n, JOB_NET);
  if (!tip.sha) throw red(`there is no claim on #${n}; run .gate/bin/claim ${n} <team>`);
  if (tip.sha !== line.sha) throw red(`Claim: ${short(line.sha)} is not the claim on #${n}: ${refOf(n)} is at ${short(tip.sha)}, "${oneLine(tip.subject)}"`);
  if (tip.state !== 'claimed' && tip.state !== 'handed-off') throw red(`the claim on #${n} was released ("${oneLine(tip.subject)}")`);
  console.log(`tier: claim: #${n} is held by ${tip.team} at ${short(tip.sha)}`);
}

const NUMBER = /^[1-9]\d*$/;
const USAGE = 'usage: .gate/bin/claim <n> <team> | --release <n> <team|--human> | --handoff <n> <from|--human> <to> | --list [--all]';

export function main(argv) {
  const [first, ...rest] = argv;
  const team = (name) => {
    if (!isTeam(name)) throw new Stop(`claim: "${name}" is not a team name (letters, digits, . _ -, at most one "/")`, 2);
    return name;
  };
  const number = (s) => {
    if (!NUMBER.test(s ?? '')) throw new Stop(USAGE, 2);
    return Number(s);
  };
  if (first === 'check' && rest.length === 4 && rest[0] === '--repo' && rest[2] === '--pr' && /^[\w.-]+\/[\w.-]+$/.test(rest[1]) && NUMBER.test(rest[3])) return check(rest[1], rest[3]);
  if (first === '--list' && rest.length <= 1 && (rest[0] ?? '--all') === '--all') return list(rest[0] === '--all');
  if (first === '--release' && rest.length === 2) {
    const n = number(rest[0]);
    const who = rest[1] === '--human' ? rest[1] : team(rest[1]);
    const tip = tipOf(n);
    authorize(n, tip, who);
    return move(n, tip, `release ${n}`, `release: ${who === '--human' ? 'the Human' : who} released #${n}`);
  }
  if (first === '--handoff' && rest.length === 3) {
    const n = number(rest[0]);
    const from = rest[1] === '--human' ? rest[1] : team(rest[1]);
    const to = team(rest[2]);
    const tip = tipOf(n);
    authorize(n, tip, from);
    return move(n, tip, `handoff ${n} ${to}`, `handoff: #${n} goes from ${tip.team} to ${to}`);
  }
  if (first && !first.startsWith('-') && rest.length === 1) return take(number(first), team(rest[0]));
  throw new Stop(USAGE, 2);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.log(error.message);
    process.exitCode = error.code;
  }
}
