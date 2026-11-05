// The test of a repository (#311): whether a name is a repository that can have teams. It lives in a module of its own so that bin/seat,
// the teams of the accounts file and the Lead's launcher all use it without importing one another.
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './checkout.mjs';

export const FACTORY_REPO = 'factory';

/** The reason to refuse a repository, or null: repo is a plain folder name and root/repo is a real folder with .git and .envrc, plus .gate/ except for factory. */
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
  if (repo !== FACTORY_REPO && !existsSync(join(dir, '.gate'))) return `bin/lead: ${dir} has no .gate/, so it is not an onboarded clone`;
  if (!existsSync(join(dir, '.envrc'))) return `bin/lead: ${dir} has no .envrc, so it has no profile`;
  return null;
}

/** Whether repo can have teams: the factory itself (the checkout's root, not a folder under it), or an onboarded clone under root. */
export const repoOk = (repo, root = ROOT) => repo === FACTORY_REPO || refusal(repo, root) === null;
