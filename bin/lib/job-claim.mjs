import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

/** #366: shared from ledger.mjs:731-771 (the digest claim), itself a port of kit/.gate/bin/lib/claim.mjs:1-3.
 * An empty commit, accepted once by origin,
 * under the claim/** ruleset, with no force, delete, index or worktree change. A claim is never released. The node that
 * took it records the claim in its state, so a run after its own failed post posts again; another node skips. */
export function claimJob(root, state, kind, key, log = console.log) {
  const mine = join(state, `${kind}-claims`, key);
  const own = existsSync(mine) ? readFileSync(mine, 'utf8').trim() : '';
  const ref = `refs/heads/claim/${kind}/${key}`;
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('check-ref-format', ref);
  const remote = () => {
    const rows = git('ls-remote', 'origin', ref).split('\n').map((line) => line.split('\t'));
    // As in claim.mjs's push: refuse names Git could resolve instead of the protected branch.
    const lookalikes = [`refs/${ref}`, `refs/heads/${ref}`, `refs/tags/${ref}`];
    if (rows.some(([, name]) => lookalikes.includes(name))) throw new Error(`${kind}: origin holds a look-alike of ${ref}; nothing posted`);
    return rows.find(([, name]) => name === ref)?.[0];
  };
  const skip = (held) => {
    if (own && held === own) {
      log(`${kind}: this node holds ${ref}; posting again`);
      return true;
    }
    log(`${kind}: another node holds ${ref}; skipping this run`);
    return false;
  };
  const first = remote();
  if (first) return skip(first);
  const parent = git('ls-remote', 'origin', 'refs/heads/main').split('\n').map((line) => line.split('\t'))
    .find(([, name]) => name === 'refs/heads/main')?.[0];
  if (!parent) throw new Error(`${kind}: origin has no main; nothing posted`);
  git('fetch', '--quiet', 'origin', 'refs/heads/main');
  const sha = git('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', `claim ${kind}/${key} ${hostname()}:${process.pid}`);
  const pushed = spawnSync('git', ['-C', root, 'push', '--porcelain', 'origin', `${sha}:${ref}`], { encoding: 'utf8' });
  const held = remote();
  // An up-to-date push is not a new claim, even if two contenders made identical commits.
  if (pushed.status === 0 && /^\*\t/m.test(pushed.stdout) && held === sha) {
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, `${sha}\n`);
    return true;
  }
  if (held) return skip(held);
  throw new Error(`${kind}: claim push failed; nothing posted: ${String(pushed.stderr ?? pushed.error ?? '').trim()}`);
}

