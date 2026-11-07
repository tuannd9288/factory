// #366, sublayer 0a: each node keeps the digest's inputs in better-factory's records/<node> branch.
// The issue's shared-records decision is the source: no reference combines several nodes' records (the supplied ref.md is empty).
// The bare clone in FACTORY_STATE is also the outbox: commit locally before fetching or pushing, retain it on failure, and reconcile
// against origin before retrying. refs/factory/pushed records the last acknowledged tip. Origin's rows settle an uncertain push too.
// Only rows.jsonl is published. Costs are already in sessions.jsonl; the ledger's quota reader (seat.accountEvent) reads rate_limit_event
// lines from run*.jsonl one level under FACTORY_RUNS. No assistant text, transcripts, sidecars or profile files are copied.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nodeName } from './node.mjs';

const exec = promisify(execFile);
// Same private destination as ledger.mjs's DIGEST_REPO; the digest itself is unchanged.
const REMOTE = 'https://github.com/tuannd9288/better-factory.git';
const lines = (text) => text.split('\n').filter((line) => line.trim());

function localRows(state, runs, node) {
  const out = [];
  const sessions = join(state, 'sessions.jsonl');
  for (const row of existsSync(sessions) ? lines(readFileSync(sessions, 'utf8')) : []) {
    JSON.parse(row); // Never advance past a damaged session record.
    out.push(`{"v":1,"node":${JSON.stringify(node)},"kind":"session","row":${row}}`);
  }
  for (const folder of existsSync(runs) ? readdirSync(runs, { withFileTypes: true }) : []) {
    if (!folder.isDirectory()) continue;
    for (const name of readdirSync(join(runs, folder.name))) {
      if (!name.startsWith('run') || !name.endsWith('.jsonl')) continue;
      for (const line of lines(readFileSync(join(runs, folder.name, name), 'utf8'))) {
        if (!line.includes('"type":"rate_limit_event"')) continue; // seat.accountEvent's selector, verbatim
        try { JSON.parse(line); } catch { continue; } // A partial stream line is read again on the next wake.
        out.push(`{"v":1,"node":${JSON.stringify(node)},"kind":"log","run":${JSON.stringify(`${folder.name}/${name}`)},"line":${line}}`);
      }
    }
  }
  return out;
}

// Count occurrences, not just values: two equal lines in one log are still two source rows. Keeping the full local history also keeps
// pending rows if an old run log is removed before the network comes back. The remote prefix is never rewritten.
function appendMissing(base, source) {
  const counts = new Map();
  const key = (line) => JSON.stringify(JSON.parse(line));
  for (const line of base) counts.set(key(line), (counts.get(key(line)) ?? 0) + 1);
  const out = [...base];
  for (const line of source) {
    const k = key(line);
    const n = counts.get(k) ?? 0;
    if (n) counts.set(k, n - 1);
    else out.push(line);
  }
  return out;
}

/** One daemon owns this writer. Calls during a push request another pass, so a seat ending during I/O is not missed. All failures leave
 * the outbox intact and are retried at the next seat end or daemon wake. remote and node are injectable for local bare-repository tests. */
export function recordsWriter({ state, runs, remote = REMOTE, node = nodeName(), log = console.log }) {
  const clone = join(state, 'shared-records.git');
  let busy = null;
  let again = false;
  const git = async (...args) => (await exec('git', ['--git-dir', clone, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trimEnd();
  const tip = async (ref) => {
    try { return await git('rev-parse', '--verify', ref); } catch (error) {
      if (error.code === 128) return null;
      throw error;
    }
  };
  const rowsAt = async (sha) => sha ? lines(await git('show', `${sha}:rows.jsonl`)) : [];
  const commit = async (rows, parent, ref) => {
    const file = join(state, 'shared-records.rows');
    writeFileSync(`${file}.tmp`, `${rows.join('\n')}\n`);
    renameSync(`${file}.tmp`, file);
    const blob = await git('hash-object', '-w', file);
    await git('read-tree', '--empty');
    await git('update-index', '--add', '--cacheinfo', `100644,${blob},rows.jsonl`);
    const tree = await git('write-tree');
    const sha = await git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Append session records');
    await git('update-ref', ref, sha);
    return sha;
  };
  const push = async () => {
    if (!existsSync(clone)) {
      if (!localRows(state, runs, node).length) return;
      mkdirSync(state, { recursive: true });
      await exec('git', ['init', '--bare', clone]);
    }
    // Persist the node name: a host rename must not send the old outbox to another branch.
    const saved = await git('config', '--get', 'factory.node').catch((error) => { if (error.code !== 1) throw error; });
    if (saved) node = saved;
    const ref = `refs/heads/records/${node}`;
    await git('check-ref-format', ref);
    if (!saved) await git('config', 'factory.node', node);
    await git('config', 'remote.origin.url', remote);
    await git('config', 'remote.origin.fetch', `${ref}:refs/remotes/origin/records/${node}`);
    await git('config', 'remote.origin.tagOpt', '--no-tags');
    let head = await tip(ref);
    const old = await rowsAt(head);
    const pending = appendMissing(old, localRows(state, runs, node));
    if (pending.length !== old.length) head = await commit(pending, head, ref);
    if (!head) return;
    const advertised = await git('ls-remote', '--heads', 'origin', ref);
    let parent = null;
    let published = [];
    if (advertised.split('\n').some((line) => line.split('\t')[1] === ref)) {
      await git('fetch', '--no-tags', 'origin', ref);
      parent = await git('rev-parse', 'FETCH_HEAD');
      published = await rowsAt(parent);
    }
    const merged = appendMissing(published, pending);
    if (merged.length === published.length) {
      await git('update-ref', ref, parent);
      await git('update-ref', 'refs/factory/pushed', parent);
      return;
    }
    if (parent !== await tip(`${head}^`) || merged.join('\n') !== pending.join('\n')) head = await commit(merged, parent, ref);
    await git('push', '--porcelain', 'origin', `${head}:${ref}`);
    await git('update-ref', 'refs/factory/pushed', head);
  };
  return function flush() {
    again = true;
    if (!busy) busy = (async () => {
      while (again) {
        again = false;
        try { await push(); } catch (error) {
          log(`records: push deferred; retry at the next seat end or daemon wake (${error.code ?? 'error'})`);
        }
      }
    })().finally(() => { busy = null; });
    return busy;
  };
}
