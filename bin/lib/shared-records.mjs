// #366, sublayer 0a: each node keeps the digest's inputs in better-factory's records/<node> branch.
// The issue's shared-records decision is the source: no reference combines several nodes' records (the supplied ref.md is empty).
// The bare clone in FACTORY_STATE is also the outbox: commit locally before fetching or pushing, retain it on failure, and reconcile
// against origin before retrying. refs/factory/pushed records the last acknowledged tip. Origin's rows settle an uncertain push too.
// Only rows.jsonl is published. Costs are already in sessions.jsonl; the ledger's quota reader (seat.accountEvent) reads rate_limit_event
// lines from run*.jsonl one level under FACTORY_RUNS. No assistant text, transcripts, sidecars or profile files are copied.
// FAC-38: the writer runs in the daemon at each ping, pass and seat end, so it works in proportion to what is new. shared-records.cursors.json
// holds, for the outbox head it was written at, the size of the local copy of that head's rows (shared-records.rows) and, for each file, how
// far it was taken (whole lines), a hash of the 4 KiB before that point and its mtime. A file that grew is read from there; one unchanged in
// size and mtime is not opened; one emptied and written again (a seat's log when its tag runs again) no longer has those bytes and is read from
// its start. Nothing is fetched while the head is the pushed one, and a head that only adds commits to the pushed tip, which origin still has,
// is pushed without reading origin's rows. When the cursors do not match the head (the first run, a crash between the two writes), every file
// and the head's rows are read once.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync, appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RATE_LIMIT_LINE } from './claude-code.mjs';

export function nodeName() {
  return hostname().split('.')[0].toLowerCase();
}

const exec = promisify(execFile);
// Same private destination as ledger.mjs's DIGEST_REPO; the digest itself is unchanged.
const REMOTE = 'https://github.com/tuannd9288/better-factory.git';
const lines = (text) => text.split('\n').filter((line) => line.trim());
const sizeOf = (file) => {
  try {
    return statSync(file).size;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const CHUNK = Buffer.alloc(1 << 20);
const TAIL = 4096;
const RATE_LIMIT = RATE_LIMIT_LINE; // seat.accountEvent's selector, the one in claude-code.mjs

/** Calls `each` with the bytes of each whole line of `fd` from byte `at` to its last newline before `size`, read 1 MiB at a time into one
 * buffer (larger only for a longer line), so a long log is never in memory whole and only the lines kept are decoded; the bytes are valid
 * during the call. Returns the position after the last line. */
function eachLine(fd, at, size, each) {
  let buf = CHUNK;
  let kept = 0; // the start of a line that the next read completes
  let pos = at;
  let end = at;
  while (pos < size) {
    if (kept === buf.length) {
      const bigger = Buffer.alloc(buf.length * 2);
      buf.copy(bigger, 0, 0, kept);
      buf = bigger;
    }
    const n = readSync(fd, buf, kept, Math.min(buf.length - kept, size - pos), pos);
    if (!n) break;
    pos += n;
    const len = kept + n;
    const read = buf.subarray(0, len);
    let start = 0;
    for (let nl = read.indexOf(10); nl !== -1; nl = read.indexOf(10, start)) {
      each(read.subarray(start, nl));
      start = nl + 1;
    }
    if (start) end = pos - (len - start);
    buf.copy(buf, 0, start, len);
    kept = len - start;
  }
  return end;
}

/** A hash of the bytes of `fd` just before `at`, up to 4 KiB: the end of what was taken, which a log emptied and written again no longer has. */
function tailOf(fd, at) {
  const k = Math.min(at, TAIL);
  const buf = CHUNK.subarray(0, k);
  let got = 0;
  for (let n; got < k; got += n) if (!(n = readSync(fd, buf, got, k - got, at - k + got))) break;
  return createHash('sha256').update(buf.subarray(0, got)).digest('base64url');
}

/** Takes the whole lines of `file` past `was` ({ at, tail, mtime }: the position after the lines taken before, the hash of the bytes just before
 * it, and the file's mtime then) and returns the new { at, tail, mtime }; `was` itself when the file is gone, or unchanged in size and mtime,
 * which is not opened. A file shorter than `at`, or whose bytes before `at` are no longer those taken, was emptied and written again (a seat's
 * log when its tag runs again, bin/lib/seat.mjs), so it is read from its start. */
function take(file, was, each) {
  let st;
  try {
    st = statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return was;
    throw error;
  }
  if (was && st.size === was.at && st.mtimeMs === was.mtime) return was;
  const fd = openSync(file, 'r');
  try {
    const at = was && st.size >= was.at && tailOf(fd, was.at) === was.tail ? was.at : 0;
    const end = eachLine(fd, at, st.size, each);
    return { at: end, tail: tailOf(fd, end), mtime: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** The rows of the local files past their cursors in `from` (by file: 'sessions.jsonl', '<folder>/<run*.jsonl>'), and the new cursors; a
 * file that is gone keeps its cursor. */
function localRows(state, runs, node, from = {}) {
  const out = [];
  const files = { ...from };
  const sessions = take(join(state, 'sessions.jsonl'), from['sessions.jsonl'], (bytes) => {
    const row = bytes.toString('utf8');
    if (!row.trim()) return;
    JSON.parse(row); // Never advance past a damaged session record.
    out.push(`{"v":1,"node":${JSON.stringify(node)},"kind":"session","row":${row}}`);
  });
  if (sessions) files['sessions.jsonl'] = sessions;
  for (const folder of existsSync(runs) ? readdirSync(runs, { withFileTypes: true }) : []) {
    if (!folder.isDirectory()) continue;
    for (const name of readdirSync(join(runs, folder.name))) {
      if (!name.startsWith('run') || !name.endsWith('.jsonl')) continue;
      const key = `${folder.name}/${name}`;
      const log = take(join(runs, key), from[key], (bytes) => {
        if (!bytes.includes(RATE_LIMIT)) return;
        const line = bytes.toString('utf8');
        try { JSON.parse(line); } catch { return; }
        out.push(`{"v":1,"node":${JSON.stringify(node)},"kind":"log","run":${JSON.stringify(key)},"line":${line}}`);
      });
      if (log) files[key] = log;
    }
  }
  return { rows: out, files };
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
  const isAncestor = async (a, b) => {
    try {
      await git('merge-base', '--is-ancestor', a, b);
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  };
  const rowsFile = join(state, 'shared-records.rows');
  const cursorsFile = join(state, 'shared-records.cursors.json');
  const writeRows = (rows) => {
    writeFileSync(`${rowsFile}.tmp`, `${rows.join('\n')}\n`);
    renameSync(`${rowsFile}.tmp`, rowsFile);
  };
  /** Commits shared-records.rows as rows.jsonl on `parent` and moves `ref` to it. */
  const commitFile = async (parent, ref) => {
    const blob = await git('hash-object', '-w', rowsFile);
    await git('read-tree', '--empty');
    await git('update-index', '--add', '--cacheinfo', `100644,${blob},rows.jsonl`);
    const tree = await git('write-tree');
    const sha = await git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Append session records');
    await git('update-ref', ref, sha);
    return sha;
  };
  const commit = async (rows, parent, ref) => {
    writeRows(rows);
    return commitFile(parent, ref);
  };
  const readCursors = () => {
    try {
      const c = JSON.parse(readFileSync(cursorsFile, 'utf8'));
      const fileOk = (f) => Number.isInteger(f?.at) && typeof f.tail === 'string' && typeof f.mtime === 'number';
      return typeof c?.head === 'string' && Number.isInteger(c.rowsBytes) && c.files && typeof c.files === 'object' && Object.values(c.files).every(fileOk) ? c : null;
    } catch {
      return null;
    }
  };
  const saveCursors = (head, files) => {
    writeFileSync(`${cursorsFile}.tmp`, `${JSON.stringify({ head, rowsBytes: sizeOf(rowsFile), files })}\n`);
    renameSync(`${cursorsFile}.tmp`, cursorsFile);
  };
  let configured = null;
  const push = async () => {
    if (!existsSync(clone)) {
      if (!localRows(state, runs, node)?.rows.length) return;
      mkdirSync(state, { recursive: true });
      await exec('git', ['init', '--bare', clone]);
      configured = null;
    }
    if (!configured) {
      // Persist the node name: a host rename must not send the old outbox to another branch.
      const saved = await git('config', '--get', 'factory.node').catch((error) => { if (error.code !== 1) throw error; });
      if (saved) node = saved;
      const ref = `refs/heads/records/${node}`;
      await git('check-ref-format', ref);
      if (!saved) await git('config', 'factory.node', node);
      await git('config', 'remote.origin.url', remote);
      await git('config', 'remote.origin.fetch', `${ref}:refs/remotes/origin/records/${node}`);
      await git('config', 'remote.origin.tagOpt', '--no-tags');
      configured = ref;
    }
    const ref = configured;
    let head = await tip(ref);
    const cursors = readCursors();
    const fresh = head && cursors?.head === head && (sizeOf(rowsFile) ?? -1) >= cursors.rowsBytes ? localRows(state, runs, node, cursors.files) : null;
    let files;
    if (fresh) {
      // The local copy of the head's rows, cut back to what the head holds, and the new rows after it.
      truncateSync(rowsFile, cursors.rowsBytes);
      if (fresh.rows.length) {
        appendFileSync(rowsFile, `${fresh.rows.join('\n')}\n`);
        head = await commitFile(head, ref);
      }
      files = fresh.files;
    } else {
      const old = await rowsAt(head);
      const all = localRows(state, runs, node);
      const pending = appendMissing(old, all.rows);
      files = all.files;
      if (pending.length !== old.length) head = await commit(pending, head, ref);
      else if (head) writeRows(old);
    }
    if (!head) return;
    saveCursors(head, files);
    const pushed = await tip('refs/factory/pushed');
    if (head === pushed) return;
    const advertised = await git('ls-remote', '--heads', 'origin', ref);
    const remoteTip = advertised.split('\n').map((line) => line.split('\t')).find(([, name]) => name === ref)?.[0] ?? null;
    if (pushed && remoteTip === pushed && await isAncestor(pushed, head)) {
      // Origin still has the tip it acknowledged, and the head only adds to it.
      await git('push', '--porcelain', 'origin', `${head}:${ref}`);
      await git('update-ref', 'refs/factory/pushed', head);
      return;
    }
    const pending = await rowsAt(head);
    let parent = null;
    let published = [];
    if (remoteTip) {
      await git('fetch', '--no-tags', 'origin', ref);
      parent = await git('rev-parse', 'FETCH_HEAD');
      published = await rowsAt(parent);
    }
    const merged = appendMissing(published, pending);
    if (merged.length === published.length) {
      await git('update-ref', ref, parent);
      await git('update-ref', 'refs/factory/pushed', parent);
      writeRows(published);
      saveCursors(parent, files);
      return;
    }
    if (parent !== await tip(`${head}^`) || merged.join('\n') !== pending.join('\n')) {
      head = await commit(merged, parent, ref);
      saveCursors(head, files);
    }
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
