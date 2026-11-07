// packs/pstack/bin/codex-step.mjs (#182, FAC-4): one pstack step that asks for another model family than the Claude that runs
// the session, run on Codex, as the Human decided on 2026-10-30 (D2): a factory script on `codex exec`, like the live verifier was,
// on the verifier's Codex profile, never on Claude. `factory codex` runs it (bin/lib/factory.mjs); the Lead and every seat are
// granted that verb, never `codex` itself, and a sandboxed seat runs it outside its sandbox (bin/lib/seat.mjs), passing the brief
// with --brief-file, a file of the repository or the temporary folder that the seat itself may read (briefFrom).
//   factory codex --role <role> [--effort low|medium|high|xhigh] [--write <folder>] [--repo <owner/name>] [--brief-file <file>]
// with the brief on stdin, or in the file.
// The roles are the steps the factory maps to Codex: a panel's other-family seat (arena-runner, architect-runner,
// interrogate-reviewer), arena's cross-judge (cross-judge, eval's judge too), show-me-your-work's review of the trail
// (trail-reviewer) and Orchestrate's verifier (verifier). A review role's prompt ends with the Human's score-and-file sentence,
// read from kit/.gate/gate-section.md, its one home. Codex runs in the current folder under its own permission profile, not a
// sandbox mode: it reads the whole disk but the folders the seats' sandbox denies (DENY_READ, bin/lib/seat.mjs: the profiles and
// their tokens, gh's, ssh's, Claude Code's and Codex's own) and every .env* file, writes nothing, and has no network. The profile
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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENY_READ } from '../../../bin/lib/seat.mjs';

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
const USAGE = `usage: factory codex --role <${ROLES.join('|')}> [--effort ${EFFORTS.join('|')}] [--write <folder>] [--repo <owner/name>] [--brief-file <file>], the brief on stdin or in the file`;
// What Codex prints when the account's usage limit is reached; checked on the Mac mini's first real wait (#182).
const QUOTA = /usage limit|usage_limit|rate.?limit|quota|\b429\b/i;
const PROFILE = 'factory-codex-step';
const ENV_FILES = '/**/.env*';
// What Codex's own workspace-write keeps read-only in a writable folder (rust-v0.163.0, protocol/src/permissions.rs:40-43 and
// :2360-2400): a hook, a config or a credential helper planted there would run later, outside the sandbox.
const KEEP_READ_ONLY = ['.git', '.agents', '.codex', '.aws'];

/**
 * The `-c` overrides that make Codex's permission profile for this step (Codex 0.163.0's `[permissions]` table, selected by
 * `default_permissions`, which cannot go with a sandbox mode): read `:root` but the seats' DENY_READ under home and the profiles
 * folder; with write, write the folder and the temporary folders too, but not the folder's KEEP_READ_ONLY. No `network` table
 * leaves the network off. Codex's `*` stops at one path part, so a glob is denied twice, as itself and with `/**` for what lies
 * under what it names. Shown on `codex sandbox` with a temporary home: each denied path refused, the work folder read, and a
 * write to <write>/.git/hooks refused (#182).
 */
export function permissionArgs({ home, profiles, write = null, tmp = [] }) {
  const deny = [...new Set([...DENY_READ.map((d) => `${home}/${d}`), profiles])].flatMap((p) => (p.includes('*') ? [p, `${p}/**`] : [p]));
  // The kit denies a session `Read(./.env*)` (kit/.claude/settings.json); Codex reads every folder, so its .env files go everywhere.
  deny.push(ENV_FILES);
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

/**
 * The brief from --brief-file, the way a seat passes it: a seat's sandbox runs `factory codex` outside it only when the call holds
 * no redirect or pipe (bin/lib/seat.mjs), and this process then reads with the factory user's whole reach. So the file, by its
 * real path (a link is followed), must be a file of the current repository or a temporary folder, and not in a folder the seats'
 * sandbox denies (DENY_READ, the profiles folder) nor a .env* file: nothing a seat could not read itself.
 */
function briefFrom(path, { cwd, p }) {
  let real;
  try {
    real = realpathSync(resolve(cwd, path));
  } catch {
    throw new Error(`--brief-file ${path} does not exist`);
  }
  const under = (dir) => {
    const rel = relative(dir, real);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  const realOr = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const home = realOr(p.home);
  const fromHome = relative(home, real);
  const denied = DENY_READ.some((d) => (d.includes('*') ? !fromHome.startsWith('..') && fromHome.split('/')[0].startsWith(d.replace('*', '')) : under(realOr(join(home, d)))))
    || under(realOr(p.profiles)) || basename(real).startsWith('.env');
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const roots = [...(top ? [realOr(top)] : []), ...p.tmp];
  if (denied || !roots.some(under) || !statSync(real).isFile())
    throw new Error(`--brief-file ${path} is not a file of this repository or the temporary folder that a seat may read`);
  return readFileSync(real, 'utf8');
}

/** The options, from a closed list, each once; throws with the usage on anything else. */
export function parse(args) {
  const o = {};
  const take = { '--role': 'role', '--effort': 'effort', '--write': 'write', '--repo': 'repo', '--brief-file': 'briefFile' };
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
export function main(args, { home: seamHome, codex: seamCodex } = {}) {
  let o;
  let prompt;
  let dir;
  const cwd = realpathSync(process.cwd());
  const p = paths(seamHome);
  try {
    o = parse(args);
    const brief = o.briefFile === undefined ? readFileSync(0, 'utf8') : briefFrom(o.briefFile, { cwd, p });
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
    if (o.effort) argv.push('-c', `model_reasoning_effort="${o.effort}"`);
    if (git(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') argv.push('--skip-git-repo-check');
    argv.push('--ignore-rules', '--ephemeral', '-o', out, '-');
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
