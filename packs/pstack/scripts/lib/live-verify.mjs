// The live verifier: one per pull request, on Codex, which did not write the change. It checks out the parent and the
// head side by side under .claude/worktrees/, gives Codex a brief built from the pull request, its issue, both SHAs
// and main's .gate/driver.json, and posts what Codex saw as one comment, by the pull request's author, the agents'
// account: its verdict, head, parent and patch-id. Anything that keeps it from a verdict it can trust posts BLOCKED:
// no driver, a profile not logged in, Codex failing, a result that twice does not record its commits. It never logs
// in, never approves the pull request, and never tries another model. See scripts/live-verify for the arguments.
// Ported from pstack (cursor/plugins f713f14): shipping.md:5 and :7, autopilot-full.md:14 (re-run the gates, prove the
// load-bearing behaviour live through a named driver, audit the diff), swarm/SKILL.md:20, :23, :31 and :37.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driverAt } from './driver.mjs';
import { SCHEMA, brief, check, comment, coverage, verdictOf } from './verdict.mjs';

const EXIT = { PASS: 0, 'PASS+NOTES': 0, FAIL: 1, BLOCKED: 2 };
const VIEW = 'number,url,title,body,author,state,baseRefName,baseRefOid,headRefName,headRefOid,closingIssuesReferences';

const git = (args, input) => execFileSync('git', args, { input, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['pipe', 'pipe', 'pipe'] });
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const has = (oid) => spawnSync('git', ['cat-file', '-e', `${oid}^{commit}`]).status === 0;

/** The patch-id of the head's own change, its diff from its merge-base with the base, as .gate/bin/lib/approval.mjs
 * computes it; null when it cannot be read. */
export function patchOf(base, head) {
  try {
    const fork = git(['merge-base', base, head]).trim();
    return git(['patch-id', '--verbatim'], git(['diff', '--binary', '--no-renames', fork, head])).split(' ')[0].trim() || null;
  } catch {
    return null;
  }
}

/** Both commits, fetched from origin when the clone lacks them; false when they cannot be had. */
function fetched(view) {
  if (has(view.baseRefOid) && has(view.headRefOid)) return true;
  spawnSync('git', ['fetch', '--quiet', 'origin', `refs/pull/${view.number}/head`, view.baseRefName], { stdio: 'ignore' });
  return has(view.baseRefOid) && has(view.headRefOid);
}

function owners() {
  const text = existsSync('.github/CODEOWNERS') ? readFileSync('.github/CODEOWNERS', 'utf8') : '';
  return new Set([...text.matchAll(/(?:^|\s)@([\w.-]+(?:\/[\w.-]+)?)/gm)].map((m) => m[1].toLowerCase()));
}

function post(pr, body, verdict) {
  const dir = mkdtempSync(join(tmpdir(), 'live-verify-'));
  try {
    writeFileSync(join(dir, 'comment.md'), body);
    gh(['pr', 'comment', String(pr), '--body-file', join(dir, 'comment.md')]);
  } catch (error) {
    console.log(body);
    console.log(`live-verify: ${verdict}, but the comment could not be posted: ${String(error.stderr || error.message).trim()}`);
    return 2;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return EXIT[verdict];
}

function covered(pr) {
  const view = JSON.parse(gh(['pr', 'view', String(pr), '--json', 'number,author,baseRefName,baseRefOid,headRefOid,comments']));
  const patch = fetched(view) ? patchOf(view.baseRefOid, view.headRefOid) : null;
  const c = coverage(view.comments, { author: view.author?.login, head: view.headRefOid, patch });
  const at = (v) => `${v.verdict} on ${v.head.slice(0, 7)}`;
  if (c.covered) {
    console.log(`live-verify: #${pr} covered by ${at(c.by)}${c.by.head === view.headRefOid ? '' : ', whose patch the head carries unchanged'}`);
    return 0;
  }
  if (c.by) console.log(`live-verify: #${pr} not covered: the latest verdict on its patch is ${at(c.by)}`);
  else if (c.covered === null) console.log(`live-verify: #${pr} not covered: its head's patch could not be computed, and no verdict names the head`);
  else console.log(`live-verify: #${pr} not covered: no verdict on head ${view.headRefOid.slice(0, 7)} or its patch`);
  return 1;
}

function verify(pr) {
  const view = JSON.parse(gh(['pr', 'view', String(pr), '--json', VIEW]));
  const author = view.author?.login ?? '';
  const login = gh(['api', 'user', '--jq', '.login']).trim();
  if (login.toLowerCase() !== author.toLowerCase() || owners().has(login.toLowerCase())) {
    console.log(`live-verify: posts as the pull request's author (${author}), not as ${login}; nothing done`);
    return 2;
  }
  if (view.state !== 'OPEN') {
    console.log(`live-verify: #${pr} is ${String(view.state).toLowerCase()}; nothing done`);
    return 2;
  }
  const head = view.headRefOid;
  let parent = '';
  let patch = '';
  let driver = null;
  let runs = 0;
  let version = '';
  const codex = () => (runs ? `${version}, ${runs} run${runs > 1 ? 's' : ''}` : 'not run');
  const blocked = (reason) => {
    console.log(`live-verify: BLOCKED on #${pr}: ${reason}`);
    return post(pr, comment({ verdict: 'BLOCKED', head, parent, patch, driver: driver?.name, codex: codex(), reason }), 'BLOCKED');
  };
  if (!fetched(view)) return blocked(`the base ${view.baseRefOid.slice(0, 7)} or the head ${head.slice(0, 7)} could not be fetched`);
  parent = git(['merge-base', view.baseRefOid, head]).trim();
  patch = patchOf(view.baseRefOid, head) ?? '';
  driver = driverAt(view.baseRefOid);
  if (!driver)
    return blocked(`no driver: .gate/driver.json on main (${view.baseRefOid.slice(0, 7)}) names none, so nothing can run the change as a user would. The repository's session fills it, in a tier-3 pull request.`);
  const which = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (which.error || which.status !== 0) return blocked('codex is not installed on this machine');
  version = which.stdout.trim();
  const home = process.env.GATE_VERIFIER_HOME || join(homedir(), '.agent-profiles/verifier/codex');
  const shown = home.startsWith(homedir()) ? `~${home.slice(homedir().length)}` : home;
  // Codex and what it runs get the shell's basics and the verifier's profile, nothing of the agent that called it:
  // no gh or model credentials, no Claude Code profile.
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM'];
  const env = { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), CODEX_HOME: home };
  if (spawnSync('codex', ['login', 'status'], { env, stdio: 'ignore' }).status !== 0)
    return blocked(`the verifier's Codex profile (CODEX_HOME=${shown}) is not logged in. The Human logs it in; an agent never does.`);

  const root = realpathSync('.');
  // Its own tree: mkdtemp creates the folder atomically under a random suffix, so two runs on one pull request never
  // share a path, and drop() removes this run's tree only. A killed run leaves its tree for a hand cleanup.
  mkdirSync(join(root, '.claude/worktrees'), { recursive: true });
  const wt = mkdtempSync(join(root, '.claude/worktrees', `live-verify-${pr}-`));
  const log = `${wt}.log`;
  const drop = () => {
    for (const side of ['parent', 'head']) spawnSync('git', ['worktree', 'remove', '--force', join(wt, side)], { stdio: 'ignore' });
    rmSync(wt, { recursive: true, force: true });
  };
  const scratch = mkdtempSync(join(tmpdir(), 'live-verify-'));
  try {
    const worktrees = { parent: join(wt, 'parent'), head: join(wt, 'head') };
    git(['worktree', 'add', '--quiet', '--detach', worktrees.parent, parent]);
    git(['worktree', 'add', '--quiet', '--detach', worktrees.head, head]);
    const issues = (view.closingIssuesReferences ?? []).slice(0, 3).map((i) => JSON.parse(gh(['issue', 'view', String(i.number), '--json', 'number,title,body'])));
    const prompt = brief({ pr: view, issues, parent, head, driver, worktrees });
    writeFileSync(join(scratch, 'schema.json'), JSON.stringify(SCHEMA));
    const out = join(scratch, 'result.json');
    // The sandbox: workspace-write over the two worktrees, outbound network only when the driver needs it, no
    // approval prompt to wait on, no execpolicy rules and no AGENTS.md from the candidate, no bypass of any of it.
    const args = ['exec', '-C', worktrees.head, '--add-dir', worktrees.parent, '-s', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0'];
    if (driver.network) args.push('-c', 'sandbox_workspace_write.network_access=true');
    args.push('--ignore-rules', '--ephemeral', '--output-schema', join(scratch, 'schema.json'), '-o', out, '-');
    const minutes = Number(process.env.GATE_VERIFY_MINUTES || 30);
    let why = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      rmSync(out, { force: true });
      runs += 1;
      const r = spawnSync('codex', args, { env, input: prompt, encoding: 'utf8', maxBuffer: 256 << 20, timeout: minutes * 60_000 });
      appendFileSync(log, `--- run ${attempt} at ${new Date().toISOString()}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`);
      if (r.error || r.status !== 0)
        return blocked(r.error?.code === 'ETIMEDOUT' ? `codex exec ran past ${minutes} minutes` : `codex exec exited ${r.status ?? r.signal}; its output is in ${log.slice(root.length + 1)}`);
      let result = null;
      try {
        result = JSON.parse(readFileSync(out, 'utf8'));
      } catch {
        result = null;
      }
      why = check(result, { parent, head });
      if (!why) {
        const verdict = verdictOf(result);
        console.log(`live-verify: ${verdict} on #${pr} (head ${head.slice(0, 7)}, patch ${patch.slice(0, 7)})`);
        return post(pr, comment({ verdict, head, parent, patch, driver: driver.name, codex: codex(), result, reason: result.verdict === 'BLOCKED' ? result.reason : '' }), verdict);
      }
    }
    return blocked(`the verifier's result ${why}, twice`);
  } finally {
    drop();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  const covering = argv[0] === '--covered';
  const pr = covering ? argv[1] : argv[0];
  if (!/^\d+$/.test(pr ?? '') || argv.length !== (covering ? 2 : 1)) {
    console.log('usage: scripts/live-verify <pr> | scripts/live-verify --covered <pr>');
    return 2;
  }
  return covering ? covered(pr) : verify(pr);
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`live-verify: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 2;
  }
}
