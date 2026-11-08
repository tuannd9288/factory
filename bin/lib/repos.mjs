// A repository's identity (FAC-85): the owner/name its origin names, the clones taken in under the factory's root, the test of a
// repository that can have teams (#311) and the lookup of a short name. It lives in a module of its own so that bin/seat, the ledger,
// the merge queue, Colly's status, the teams of the accounts file and the Lead's launcher all use it without importing one another.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './checkout.mjs';

export const FACTORY_REPO = 'factory';

// The host, github.com, then the path.
const ON_GITHUB = /github\.com[:/]/;

/** The GitHub owner/name an origin URL names, or null: https://github.com/o/r, ssh://git@github.com/o/r or git@github.com:o/r, with
 * any scheme or user before the host, with or without a trailing .git and /, and a path that is exactly an owner and a name in
 * GitHub's characters. The one parser of an origin (FAC-85). */
export function githubRepo(url) {
  const text = String(url ?? '').trim();
  const at = ON_GITHUB.exec(text);
  if (!at) return null;
  return /^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(text.slice(at.index + at[0].length))?.[1] ?? null;
}

/** The owner/name of the clone at dir, from its origin, or null where git cannot tell. */
export function cloneRepo(dir, timeout = undefined) {
  try {
    return githubRepo(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/** The repositories taken in under root, by owner/name: a folder with a `.git` and the kit's `.gate/config.sh`, whose origin names a
 * GitHub owner/name. The ledger and the merge queue find them by this rule (#211). A kit clone whose origin cannot be read, or whose
 * GitHub origin names no owner/name, is left out and `skip(folder, why)` is called for it; a clone on another host is left out. */
export function clonesUnder(root, skip = () => {}) {
  const out = new Map();
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, name);
    if (!existsSync(join(dir, '.gate/config.sh')) || !existsSync(join(dir, '.git'))) continue;
    let url;
    try {
      url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      skip(dir, `origin cannot be read: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
      continue;
    }
    if (!ON_GITHUB.test(url)) continue;
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

/** The reason to refuse a repository, or null: repo is a plain folder name and root/repo is a real folder with .git, .gate/ and .envrc. */
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
  if (!existsSync(join(dir, '.git'))) return `bin/lead: ${dir} has no .git of its own, so it is not a clone`;
  if (!existsSync(join(dir, '.gate'))) return `bin/lead: ${dir} has no .gate/, so it is not an onboarded clone`;
  if (!existsSync(join(dir, '.envrc'))) return `bin/lead: ${dir} has no .envrc, so it has no profile`;
  return null;
}

/** Whether repo can have teams: the factory itself (the checkout's root, not a folder under it), or an onboarded clone under root. */
export const repoOk = (repo, root = ROOT) => repo === FACTORY_REPO || refusal(repo, root) === null;
