// The factory's merge queue for repositories without GitHub's: the ruleset requires a branch to be up to date, and
// GitHub never updates one by itself, so a pull request waiting on auto-merge strands once another lands. One sweep
// updates one waiting pull request per repository, the oldest first, so the update triggers the gate, and re-runs a
// tier check that failed before the Human approved the head. It runs once and exits: launchd repeats it. It reads
// GitHub afresh each time, holds a lock so two sweeps never overlap, bounds every gh call, refuses the Human's login,
// and leaves $FACTORY_STATE/queue-<owner>-<name>.failed until a sweep of that repository succeeds; a run that fails
// before its repository loop leaves queue-run.failed until a run gets that far. A clean sweep writes
// queue-<owner>-<name>.ok, the time the digest shows as that repository's last good sweep.
// With no --repo it sweeps the repositories taken in (#211), found as the ledger finds them (clonesUnder): a folder
// of the factory's root ($FACTORY_ROOT, else this clone) that holds a .git and the kit's .gate/config.sh, named by its
// origin on github.com. None found is a logged sweep of nothing, not an error. --repo gives an explicit list instead.
// See bin/factory-queue for the arguments.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, checkPlists, followMain } from './checkout.mjs';
import { clonesUnder } from './ledger.mjs';
import { liveRuns, runFiles } from './seat.mjs';
import { sweepWorktrees } from './worktrees.mjs';

const RED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const CALL_MS = 60_000;
const ENTIRE = 'Entire Gates';

/** The pull request to update now, or null: the oldest one waiting on auto-merge behind its base whose required
 * checks did not fail (a failing one needs a new commit, which the gate judges anyway; a red tier check only waits on
 * the Human), unless another one waiting on auto-merge is up to date and still being judged. One that conflicts with
 * its base is not being judged: pull_request never runs on it, so its verify stays missing, and it cannot land until
 * its owner resolves the conflict. A tier-3 one waits behind until its tier check passed, the Human's approval given:
 * his approval then holds on the updated head, whose patch is unchanged, and he is asked once. A required check of
 * another App (#155: Entire's) is read from `apps`; one it concluded other than success has failed: Entire is neutral
 * while it blocks, and an update would only buy another review. */
export function pickUpdate(prs, required) {
  const waiting = prs.filter((p) => p.autoMerge && !p.isDraft);
  const check = (p, name) => p.checks[name] ?? p.apps?.[name];
  const judging = (p) => required.some((name) => !check(p, name) || check(p, name).state === 'PENDING');
  const failed = (p) =>
    required.some((name) => name !== 'tier' && (p.checks[name] ? RED.has(p.checks[name].state) : Boolean(p.apps?.[name]) && !['SUCCESS', 'PENDING'].includes(p.apps[name].state)));
  const unapproved = (p) => p.labels.some((l) => l === 'tier-3' || l === 'needs-human') && p.checks.tier?.state !== 'SUCCESS';
  if (waiting.some((p) => !['BEHIND', 'DIRTY'].includes(p.mergeStateStatus) && judging(p))) return null;
  const behind = waiting
    .filter((p) => p.mergeStateStatus === 'BEHIND' && !failed(p) && !unapproved(p))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return behind[0] ?? null;
}

/** The tier jobs to re-run, alone, so no reviewer runs again for a click: a failed tier check on a pull request that
 * someone other than its author approved on the head commit after that check started, so an approval landing while
 * the job ran is not lost, or (#155) whose Entire Gates check, of an App other than Actions, concluded after it
 * started. The tier check itself decides whether the approver may approve, and what Entire's conclusion means; it
 * pins Entire's App, so a copy of that name only costs one re-run. */
export function pickReruns(prs) {
  return prs
    .filter((p) => RED.has(p.checks.tier?.state) && p.checks.tier.jobId)
    .filter(
      (p) =>
        p.approvals.some((a) => a.login !== p.author && a.oid === p.head && a.at > p.checks.tier.startedAt) ||
        (Boolean(p.apps?.[ENTIRE]?.completedAt) && p.apps[ENTIRE].completedAt > p.checks.tier.startedAt),
    )
    .map((p) => ({ number: p.number, jobId: p.checks.tier.jobId }));
}

const QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100){nodes{
number isDraft createdAt mergeStateStatus autoMergeRequest{enabledAt} author{login} headRefOid labels(first:30){nodes{name}}
reviews(last:50,states:APPROVED){nodes{author{login} commit{oid} submittedAt}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{app{slug}}}}}}}}}}}}}`;

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CALL_MS });

/** A check run's state as the queue reads it: its conclusion once completed, PENDING before. */
const stateOf = (run) => (run.status === 'COMPLETED' ? run.conclusion : 'PENDING');

function openPulls(repo) {
  const [owner, name] = repo.split('/');
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`]));
  return data.data.repository.pullRequests.nodes.map((p) => {
    const all = (p.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).filter((c) => c.name);
    const byStart = (a, b) => String(a.startedAt).localeCompare(String(b.startedAt));
    const checks = {};
    for (const run of all.filter((c) => c.checkSuite?.app?.slug === 'github-actions').sort(byStart))
      checks[run.name] = { state: stateOf(run), startedAt: run.startedAt ?? '', jobId: /\/job\/(\d+)/.exec(run.detailsUrl ?? '')?.[1] };
    // Other Apps' checks, by name (#155: Entire Gates): the latest started wins.
    const apps = {};
    for (const run of all.filter((c) => c.checkSuite?.app?.slug !== 'github-actions').sort(byStart))
      apps[run.name] = { state: stateOf(run), startedAt: run.startedAt ?? '', completedAt: run.completedAt ?? '' };
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
      apps,
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
    console.log(`queue: re-ran the tier check of ${repo}#${number} after its approval or Entire's check`);
  }
  const pr = pickUpdate(prs, required);
  if (!pr) return;
  gh(['pr', 'update-branch', String(pr.number), '--repo', repo]);
  console.log(`queue: updated ${repo}#${pr.number} to its base`);
}

/** A process's start time as ps prints it, or null: with the pid it names one process, so a reused pid differs. */
const startOf = (pid) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

/** The holder a lock file records, or null when it is not one (a legacy directory lock, a torn or foreign file). */
function holderOf(path) {
  try {
    const h = JSON.parse(readFileSync(path, 'utf8'));
    return typeof h?.pid === 'number' && h.token ? h : null;
  } catch {
    return null;
  }
}

/** Whether a holder is gone. The state folder is single-machine (AGENTS.md), so the recorded host decides nothing:
 * hostname() is not stable. ESRCH is gone. EPERM means a process of another user has the pid, which may be a reused
 * one, so the start time decides, as for a live pid. Any other error is alive. A pid with another start time is a
 * reused pid. When ps cannot say, the holder counts as alive: a held lock is the safe mistake. */
function gone(h) {
  try {
    process.kill(h.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code !== 'EPERM') return false;
  }
  const now = startOf(h.pid);
  return Boolean(h.start) && now !== null && now !== h.start;
}

/** Takes the lock at path and returns what it recorded ({pid, start, host, token}), or null while another sweep holds
 * it. The record is written to a file of its own and link()ed into place: link fails with EEXIST like O_EXCL, and the
 * content is there from the first instant. A holder that is gone is displaced by renaming its lock to a name of ours:
 * of several sweeps that found it dead, one rename succeeds. We then read what we moved; if it is not the lock we
 * judged dead, a third sweep took over meanwhile, and we link it back and give up. An unreadable lock (the old
 * directory, a torn file) is a dead sweep's after ten minutes. afterRead is for tests: it runs between the read and
 * the rename. */
export function takeLock(path, { afterRead } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const mine = { pid: process.pid, start: startOf(process.pid), host: hostname(), token: randomBytes(8).toString('hex') };
  const tmp = `${path}.${mine.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(mine));
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        linkSync(tmp, path);
        return mine;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const held = holderOf(path);
      afterRead?.(held);
      let dead;
      try {
        dead = held ? gone(held) : Date.now() - statSync(path).mtimeMs >= 10 * 60_000;
      } catch {
        continue;
      }
      if (!dead) return null;
      const aside = `${path}.dead.${mine.token}`;
      try {
        renameSync(path, aside);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const moved = holderOf(aside);
      if ((moved?.token ?? null) !== (held?.token ?? null)) {
        try {
          linkSync(aside, path);
        } catch {}
        rmSync(aside, { recursive: true, force: true });
        return null;
      }
      rmSync(aside, { recursive: true, force: true });
    }
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Removes the lock only if it is the one we made. Between the read and the unlink another sweep can only take it
 * if it judged us gone, and we are running. */
export function releaseLock(path, token) {
  if (holderOf(path)?.token === token) rmSync(path, { force: true });
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

/** The checkout the daemons and bin/seat run from: $FACTORY_CHECKOUT, else this clone when it is ~/WORKSPACES, so a clone anywhere
 * else (a developer's, a test's) is never touched; null otherwise. */
function checkoutRoot() {
  const home = process.env.HOME;
  if (process.env.FACTORY_CHECKOUT) return process.env.FACTORY_CHECKOUT;
  try {
    if (home && realpathSync(join(home, 'WORKSPACES')) === realpathSync(ROOT)) return ROOT;
  } catch {
    // no ~/WORKSPACES
  }
  return null;
}

/** The first step of a sweep (#257): the checkout the daemons and bin/seat run from follows main, and the installed plists are
 * compared with what the code renders. A refusal or a failure is told in queue-checkout.failed and never stops the sweep. */
function followCheckout(state) {
  const home = process.env.HOME;
  const root = checkoutRoot();
  if (!root) return;
  try {
    const r = followMain({ root, state, live: () => liveRuns(process.env.FACTORY_RUNS ?? join(home, 'factory-runs')) });
    if (r.status === 'updated') console.log(`queue: checkout ${r.from.slice(0, 7)}..${r.to.slice(0, 7)} (${r.behind} commits)`);
    else if (r.status === 'refused') console.log(`queue: checkout not moved: ${r.why}`);
    else if (r.status !== 'current') console.log(`queue: checkout ${r.status}`);
    const differ = checkPlists({ root, state, plistDir: process.env.FACTORY_PLIST_DIR ?? '/Library/LaunchDaemons' }).differ;
    if (differ.length) console.log(`queue: installed plist differs from the code's: ${differ.join(' ')}`);
  } catch (error) {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'queue-checkout.failed'), `${new Date().toISOString()} the update raised ${error.name}: ${String(error.message).split('\n')[0].slice(0, 200)}\n`);
    console.error(`queue: checkout: ${error.message}`);
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
    const origin = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const own = /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(origin)?.[1];
    const clones = [...(own ? [{ repo: own, dir: root }] : []), ...[...clonesUnder(root)].map(([repo, dir]) => ({ repo, dir }))];
    const r = sweepWorktrees({ clones, state, live, merged });
    if (r.removed || r.kept.length) console.log(`queue: worktrees removed ${r.removed}, kept ${r.kept.length}${r.kept.length ? ' (queue-worktrees.failed names them)' : ''}`);
  } catch (error) {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'queue-worktrees.failed'), `${new Date().toISOString()} the sweep raised ${error.name}: ${String(error.message).split('\n')[0].slice(0, 200)}\n`);
    console.error(`queue: worktrees: ${error.message}`);
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
 * link's folder, which an upgrade does not remove. `as` makes it another job of this clone (#24's claude-canary):
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
  return {
    label,
    interval: calendar ? null : interval,
    calendar,
    program: [join(factory, tool), ...(verb ? [verb] : []), ...args, ...repos.flatMap((repo) => ['--repo', repo])],
    cwd: factory,
    env: { PATH: path, ...kept, ...(daemon ? { HOME: env.HOME } : {}) },
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
function check(repos, human) {
  const j = job(repos);
  const env = { HOME: process.env.HOME, USER: process.env.USER ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', ...j.env };
  const say = (line) => console.log(`check: ${line}`);
  mkdirSync(dirname(j.log), { recursive: true });
  const who = spawnSync('gh', ['api', 'user', '--jq', '.login'], { env, encoding: 'utf8', timeout: CALL_MS });
  const login = who.status === 0 ? who.stdout.trim() : '';
  say(`gh login ${login || `none: ${String(who.stderr || who.error?.message || '').trim()}`}`);
  say(`node ${spawnSync('node', ['--version'], { env, encoding: 'utf8' }).stdout?.trim() || 'not found'}`);
  say(`state folder ${env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory')}`);
  say(`log ${j.log}`);
  const run = spawnSync(j.program[0], j.program.slice(1), { cwd: j.cwd, env, encoding: 'utf8', timeout: 10 * CALL_MS });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  for (const line of out.trim().split('\n').filter(Boolean).slice(-10)) say(`  ${line}`);
  say(`one sweep exited ${run.status}`);
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

function main(argv) {
  const [command, ...rest] = argv;
  const repos = [];
  let daemon = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--daemon') {
      if (command !== 'plist') throw new Error('--daemon is for plist alone');
      daemon = true;
      continue;
    }
    if (rest[i] !== '--repo') throw new Error(`unknown argument ${rest[i]}`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(rest[i + 1] ?? '')) throw new Error(`--repo needs owner/name, not ${JSON.stringify(rest[i + 1] ?? '')}`);
    repos.push(rest[++i]);
  }
  if (!['sweep', 'plist', 'check'].includes(command)) throw new Error('usage: factory-queue sweep|plist|check [--repo owner/name...]');
  const human = process.env.FACTORY_HUMAN ?? 'tuannd9288';
  if (command === 'plist') return void process.stdout.write(plist(job(repos, process.env, daemon)));
  if (command === 'check') return check(repos, human);
  const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
  const held = join(state, 'queue.lock');
  const mine = takeLock(held);
  if (!mine) {
    const other = holderOf(held);
    return console.log(`queue: another sweep is running${other ? ` (pid ${other.pid}, started ${other.start})` : ''}; nothing done`);
  }
  try {
    followCheckout(state);
    sweepLanded(state);
    const refused = preflight(state, human);
    if (refused) return refused;
    // No --repo: the repositories taken in, found as the ledger finds them (#211).
    const skip = (folder, why) => console.log(`queue: skipped ${folder}: ${why}`);
    const swept = repos.length ? repos : [...clonesUnder(process.env.FACTORY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'), skip).keys()];
    if (!swept.length) console.log('queue: no repository taken in under the factory root; nothing swept');
    let failed = 0;
    for (const repo of swept) {
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
    releaseLock(held, mine.token);
  }
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2)) ?? 0;
  } catch (error) {
    const why = String(error.stderr || error.message).trim();
    console.error(`factory-queue: ${why}`);
    process.exitCode = 2;
    // Best effort: the digest should show a failure before the repository loop, a plist typo among them. plist and
    // check are the Human's, run by hand, and keep no queue state.
    if (!['plist', 'check'].includes(process.argv[2])) {
      try {
        const state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory');
        mkdirSync(state, { recursive: true });
        writeFileSync(join(state, 'queue-run.failed'), `${new Date().toISOString()} ${why}\n`);
      } catch {}
    }
  }
}
