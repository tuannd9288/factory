// A repository's identity (FAC-85): the owner/name its origin names, the clones taken in under the factory's root, the test of a
// repository that can have teams (#311) and the lookup of a short name. It lives in a module of its own so that bin/seat, the ledger,
// the merge queue, Colly's status, the teams of the accounts file and the Lead's launcher all use it without importing one another.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './checkout.mjs';

export const FACTORY_REPO = 'factory';

// Where git reads `host` as the host of an origin: after a scheme git speaks over a network (http, https, ssh, git, git+ssh, ssh+git), its
// // and an optional user@ with no / ? # in it; or, in the scp-like form, at the start or after a user@ with no / or : in it, before a :.
// A look-alike host (evilgithub.com), github.com in another host's path, user, query or fragment, after another host's scp-like colon, or
// in a local path (github.com/o/r, x@github.com/o/r, file://) is none. The host is matched in lower case, as every reader of an origin
// matched it before (FAC-85).
const hostAt = (host) => new RegExp(`^(?:(?:https?|ssh|git|git\\+ssh|ssh\\+git):\\/\\/(?:[^@\\/?#\\s]+@)?${host}[:\\/]|(?:[^@\\/:\\s]+@)?${host}:)`);
// github.com, and www.github.com, which every reader but bin/seat's took.
const ON_GITHUB = hostAt('(?:www\\.)?github\\.com');
// GitHub's hosts, with ssh.github.com (its ssh over port 443), for clonesUnder's line about a GitHub origin that names no owner/name.
const GITHUB_HOST = hostAt('(?:www\\.|ssh\\.)?github\\.com');

/** The GitHub owner/name an origin URL names, or null: https://github.com/o/r, ssh://git@github.com/o/r or git@github.com:o/r, with a
 * user before the host or not, with or without a trailing .git and /, and a path that is exactly an owner and a name in GitHub's
 * characters. The one parser of an origin (FAC-85). */
export function githubRepo(url) {
  const text = String(url ?? '').trim();
  const at = ON_GITHUB.exec(text);
  if (!at) return null;
  return /^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(text.slice(at[0].length))?.[1] ?? null;
}

/** The owner/name of the clone at dir, from its origin, or null where git cannot tell. */
export function cloneRepo(dir, timeout = undefined) {
  try {
    return githubRepo(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/** The one rule for a repository taken in (FAC-85): a folder that holds a `.git` of its own and the kit's `.gate/`, which bin/onboard
 * lays. clonesUnder finds the repositories by it, and refusal adds what a team needs on top. Each entry says why a folder without it
 * is none. */
const TAKEN_IN = [['.git', 'has no .git of its own, so it is not a clone'], ['.gate', 'has no .gate/, so it is not an onboarded clone']];

/** The repositories taken in under root, by owner/name: a folder that TAKEN_IN holds for, whose origin names a GitHub owner/name. The
 * ledger and the merge queue find them by this rule (#211). A kit clone whose origin cannot be read, or whose GitHub origin names no
 * owner/name, is left out and `skip(folder, why)` is called for it; a clone on another host is left out. */
export function clonesUnder(root, skip = () => {}) {
  const out = new Map();
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, name);
    if (TAKEN_IN.some(([file]) => !existsSync(join(dir, file)))) continue;
    let url;
    try {
      url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      skip(dir, `origin cannot be read: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
      continue;
    }
    if (!GITHUB_HOST.test(url)) continue;
    const repo = githubRepo(url);
    if (repo) out.set(repo, dir);
    else skip(dir, `origin ${url} does not name owner/name`);
  }
  return out;
}

/** The one owner/name among names whose name part is short, or null: none has it, or two owners share it, which is refused rather
 * than taking the first (FAC-85). */
export function byName(names, short) {
  const hits = [...new Set(names)].filter((r) => typeof r === 'string' && r.slice(r.indexOf('/') + 1) === short);
  return hits.length === 1 ? hits[0] : null;
}

/** The reason to refuse a repository, or null: repo is a plain folder name and root/repo is a real folder that TAKEN_IN holds for, with
 * a profile (.envrc). */
export function refusal(repo, root) {
  // GitHub's own name characters only: the name goes into the deny rules' paths, where a glob character would bend them.
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo.startsWith('-') || repo.includes('..')) {
    return `bin/lead: "${repo ?? ''}" is not a plain folder name`;
  }
  const dir = join(root, repo);
  let st = null;
  try {
    st = lstatSync(dir);
  } catch {
    // a missing folder is refused below
  }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return `bin/lead: ${dir} is not a folder of its own (missing, a symlink or a file)`;
  for (const [file, why] of TAKEN_IN) if (!existsSync(join(dir, file))) return `bin/lead: ${dir} ${why}`;
  if (!existsSync(join(dir, '.envrc'))) return `bin/lead: ${dir} has no .envrc, so it has no profile`;
  return null;
}

/** Whether repo can have teams: the factory itself (the checkout's root, not a folder under it), or an onboarded clone under root. */
export const repoOk = (repo, root = ROOT) => repo === FACTORY_REPO || refusal(repo, root) === null;
