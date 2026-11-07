// packs/pstack/bin/codex-step.mjs (#182, FAC-4): one pstack step that asks for another model family than the Claude that runs
// the session, run on Codex, as the Human decided on 2026-10-30 (D2): a factory script on `codex exec`, like the live verifier was,
// on the verifier's Codex profile, never on Claude. `factory codex` runs it (bin/lib/factory.mjs); the Lead is granted that verb,
// never `codex` itself.
//   factory codex --role <role> [--effort low|medium|high|xhigh] [--write <folder>] [--repo <owner/name>]   the brief on stdin
// The roles are the steps the factory maps to Codex: a panel's other-family seat (arena-runner, architect-runner,
// interrogate-reviewer), arena's cross-judge (cross-judge, eval's judge too), show-me-your-work's review of the trail
// (trail-reviewer) and Orchestrate's verifier (verifier). A review role's prompt ends with the Human's score-and-file sentence,
// read from kit/.gate/gate-section.md, its one home. Codex runs in the current folder under its own permission profile, not a
// sandbox mode: it reads the whole disk but the paths no agent reads (bin/lib/deny-read.mjs: the profiles and their tokens, gh's,
// ssh's, Claude Code's and Codex's own, every .env* file), writes nothing, and has no network. The profile
// binds only the commands Codex runs (codex-rs/sandboxing/src/manager.rs:437-473 wraps each in /usr/bin/sandbox-exec), so Codex
// itself still reads its login and config under the denied profiles folder; --write lets it write in one
// folder of the current repository (a runner's or an adversary's worktree) and the temporary folders. --repo names the repository
// in the wait log when the folder is not its clone (a MacBook run, on the host by ssh). No other option reaches codex.
// Exit 0 with Codex's last message on stdout; 2 a refused call (nothing run); 3 the step waits for Codex: codex is not installed,
// the profile is not logged in, the account is out of quota, the run timed out or failed. A wait says so, appends
// {at, cause, role, repo, cwd} to ~/.local/state/factory/codex-waits.jsonl, where the ledger can count the waits by cause (the Human,
// 2026-10-30: he judges Codex's quota from them), and runs nothing on Claude. The runner's arguments come from the live verifier
// (before-fac-8, packs/pstack/scripts/lib/live-verify.mjs:106-116 and :137-150).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexPaths } from '../../../bin/lib/deny-read.mjs';
import { INHERIT, MODELS, entryOf } from '../../../bin/lib/models.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ROLES = ['arena-runner', 'architect-runner', 'interrogate-reviewer', 'cross-judge', 'trail-reviewer', 'verifier'];
const REVIEW = new Set(['interrogate-reviewer', 'cross-judge', 'trail-reviewer', 'verifier']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const MINUTES = 30;
// Nothing of the caller's environment chooses a path or a program here: a seat's sandbox runs `factory codex` outside it with the
// seat's environment (#182). Codex and git are found in fixed folders and get a fixed PATH; every other path comes from paths().
const SAFE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const CODEX_BINS = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
const GIT = '/usr/bin/git';
const USAGE = `usage: factory codex --role <${ROLES.join('|')}> [--effort ${EFFORTS.join('|')}] [--write <folder>] [--repo <owner/name>], the brief on stdin`;
// What Codex prints when the account's usage limit is reached; checked on the Mac mini's first real wait (#182).
const QUOTA = /usage limit|usage_limit|rate.?limit|quota|\b429\b/i;
const PROFILE = 'factory-codex-step';
// What Codex's own workspace-write keeps read-only in a writable folder (rust-v0.163.0, protocol/src/permissions.rs:40-43 and
// :2360-2400): a hook, a config or a credential helper planted there would run later, outside the sandbox.
const KEEP_READ_ONLY = ['.git', '.agents', '.codex', '.aws'];

/**
 * The `-c` overrides that make Codex's permission profile for this step (Codex 0.163.0's `[permissions]` table, selected by
 * `default_permissions`, which cannot go with a sandbox mode): read `:root` but bin/lib/deny-read.mjs's codex paths (the paths no
 * agent reads under home, the profiles folder, every .env* file; a glob twice, since Codex's `*` stops at one path part); with write,
 * write the folder and the temporary folders too, but not the folder's KEEP_READ_ONLY. No `network` table leaves the network off.
 * Shown on `codex sandbox` with a temporary home: each denied path refused, the work folder read, and a write to <write>/.git/hooks
 * refused (#182).
 */
export function permissionArgs({ home, profiles, write = null, tmp = [] }) {
  const deny = codexPaths(home, profiles);
  const entries = [[':root', 'read'], ...deny.map((p) => [p, 'deny']), ...(write ? [...new Set([write, ...tmp])].map((p) => [p, 'write']) : [])];
  // The more specific path wins over the folder's write, whether or not it exists yet.
  if (write) entries.push(...KEEP_READ_ONLY.map((name) => [`${write}/${name}`, 'read']));
  const table = `{${entries.map(([path, mode]) => `${JSON.stringify(path)}=${JSON.stringify(mode)}`).join(',')}}`;
  return ['-c', `permissions.${PROFILE}.filesystem=${table}`, '-c', `default_permissions="${PROFILE}"`];
}

/**
 * The step's own paths, from the factory user's home as getpwuid gives it (os.userInfo), never from HOME, AGENT_PROFILES, TMPDIR,
 * FACTORY_STATE or CODEX_HOME, which the caller sets: the profiles folder and Codex's login in it, the waits file, a scratch folder
 * no seat's sandbox may write, and the temporary folders a writing step may use (/tmp and macOS's own per-user one, by getconf).
 */
export function paths(home = userInfo().homedir) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const darwinTmp = process.platform === 'darwin' ? spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', env: {} }).stdout?.trim() : '';
  const profiles = join(home, '.agent-profiles');
  const state = join(home, '.local/state/factory');
  return {
    home,
    profiles,
    codexHome: join(profiles, 'verifier/codex'),
    waits: join(state, 'codex-waits.jsonl'),
    scratch: join(state, 'codex-step'),
    tmp: [...new Set([real('/tmp'), darwinTmp ? real(darwinTmp) : null].filter(Boolean))],
  };
}

/** The options, from a closed list, each once; throws with the usage on anything else. */
export function parse(args) {
  const o = {};
  const take = { '--role': 'role', '--effort': 'effort', '--write': 'write', '--repo': 'repo' };
  for (let i = 0; i < args.length; i += 2) {
    const key = take[args[i]];
    if (!key || args[i + 1] === undefined || o[key] !== undefined) throw new Error(USAGE);
    o[key] = args[i + 1];
  }
  if (!ROLES.includes(o.role)) throw new Error(USAGE);
  if (o.effort !== undefined && !EFFORTS.includes(o.effort)) throw new Error(USAGE);
  if (o.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(USAGE);
  return o;
}

const git = (cwd, args) => {
  try {
    // git reads its config from GIT_* variables too, so it gets a fixed environment of its own.
    return execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: SAFE_PATH } }).trim();
  } catch {
    return null;
  }
};

/** owner/name of the folder's origin on github.com, or null. */
export function repoOf(cwd) {
  const url = git(cwd, ['remote', 'get-url', 'origin']);
  const m = url && /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : null;
}

/** The Human's score-and-file sentence (#171), as the kit's Gate block quotes it. */
function scoreLine() {
  const m = /"(Rate each bug[^"]+)"/.exec(readFileSync(join(ROOT, 'kit/.gate/gate-section.md'), 'utf8'));
  if (!m) throw new Error('the score-and-file sentence is not in kit/.gate/gate-section.md');
  return `The Human's rule for every reviewer: "${m[1]}"`;
}

/**
 * One step. The seam, { home, codex }, is for the tests alone: no caller of `factory codex` can pass it (the verb takes the closed
 * option list and nothing else), and nothing here reads the caller's environment.
 */
export function main(args, { home: seamHome, codex: seamCodex, models = MODELS } = {}) {
  let o;
  let prompt;
  let dir;
  let model;
  const cwd = realpathSync(process.cwd());
  try {
    o = parse(args);
    // Codex's model is the codex entry of the factory's one table (INN-39); inherit passes none, so Codex's own default applies.
    ({ model } = entryOf(models, 'codex'));
    const brief = readFileSync(0, 'utf8');
    if (!brief.trim()) throw new Error(`the brief is empty; ${USAGE}`);
    prompt = REVIEW.has(o.role) ? `${brief.replace(/\n*$/, '\n')}\n${scoreLine()}\n` : brief;
    dir = cwd;
    if (o.write !== undefined) {
      const top = git(cwd, ['rev-parse', '--show-toplevel']);
      let target = null;
      try {
        target = realpathSync(resolve(cwd, o.write));
      } catch {
        // No such folder: refused below.
      }
      const inside = top && target && !isAbsolute(relative(realpathSync(top), target)) && !relative(realpathSync(top), target).startsWith('..');
      if (!inside || !statSync(target).isDirectory()) throw new Error(`--write ${o.write} is not a folder of this repository; make the worktree under it`);
      dir = target;
    }
  } catch (e) {
    console.error(`codex: ${e.message}`);
    return 2;
  }

  const p = paths(seamHome);
  const home = p.codexHome;
  const codex = seamCodex ?? CODEX_BINS.find((b) => existsSync(b)) ?? CODEX_BINS[0];
  const me = userInfo();
  // Codex gets the factory user's own basics and its profile: no variable of the caller's.
  const codexEnv = { PATH: SAFE_PATH, HOME: p.home, USER: me.username, LOGNAME: me.username, SHELL: me.shell ?? '/bin/zsh', LANG: 'en_US.UTF-8', ...(p.tmp[1] ? { TMPDIR: p.tmp[1] } : {}), CODEX_HOME: home };
  const wait = (cause, why) => {
    console.log(`codex: ${o.role} waits for Codex: ${why}. This step does not run on Claude; say so, and go on with other work.`);
    try {
      mkdirSync(dirname(p.waits), { recursive: true });
      appendFileSync(p.waits, `${JSON.stringify({ at: new Date().toISOString(), cause, role: o.role, repo: o.repo ?? repoOf(cwd), cwd })}\n`);
    } catch (e) {
      console.error(`codex: the wait was not logged: ${e.code ?? e.message}`);
    }
    return 3;
  };

  const which = spawnSync(codex, ['--version'], { env: codexEnv, encoding: 'utf8' });
  if (which.error || which.status !== 0) return wait('not-installed', 'codex is not installed on this machine');
  if (spawnSync(codex, ['login', 'status'], { env: codexEnv, stdio: 'ignore' }).status !== 0)
    return wait('not-logged-in', `the verifier's Codex profile (CODEX_HOME=${home}) is not logged in; the Human logs it in, an agent never does`);

  // Under the factory's state folder, which no seat's sandbox may write, so nobody swaps the answer file for a link.
  mkdirSync(p.scratch, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(p.scratch, 'run-'));
  try {
    const out = join(scratch, 'last.md');
    // The step's permission profile (above); no approval prompt to wait on, no execpolicy rules and no AGENTS.md of the folder, no
    // bypass of any of it.
    const argv = ['exec', '-C', dir, ...permissionArgs({ home: p.home, profiles: p.profiles, write: o.write === undefined ? null : dir, tmp: p.tmp }), '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0'];
    if (model !== INHERIT) argv.push('-m', model);
    if (o.effort) argv.push('-c', `model_reasoning_effort="${o.effort}"`);
    if (git(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') argv.push('--skip-git-repo-check');
    // --ignore-user-config: Codex loads a folder's own .codex/config.toml (and a config.toml in the folder), with its MCP servers, hooks
    // and exec policies, only when its user config.toml trusts that folder (rust-v0.163.0, config/src/loader/mod.rs:130-134, :375-383).
    // A worker writes the folder, so no user config is loaded and nothing is trusted (:520-528); auth still reads CODEX_HOME. A `-c`
    // that marks the folder untrusted did not undo a trust the user config grants (codex mcp list, 0.163.0), so it is not used.
    argv.push('--ignore-user-config', '--ignore-rules', '--ephemeral', '-o', out, '-');
    const r = spawnSync(codex, argv, { env: codexEnv, input: prompt, encoding: 'utf8', maxBuffer: 256 << 20, timeout: MINUTES * 60_000 });
    if (r.error?.code === 'ETIMEDOUT') return wait('timeout', `codex exec ran past ${MINUTES} minutes`);
    if (r.error || r.status !== 0) {
      const said = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const last = said.trim().split('\n').pop() ?? '';
      if (last) console.error(`codex: codex exec said: ${last}`);
      return QUOTA.test(said) ? wait('no-quota', 'the Codex account is out of quota') : wait('failed', `codex exec exited ${r.status ?? r.error?.code ?? r.signal}`);
    }
    let answer = '';
    try {
      answer = readFileSync(out, 'utf8');
    } catch {
      // No answer file: a failed run, below.
    }
    if (!answer.trim()) return wait('failed', 'codex exec left no answer');
    process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
