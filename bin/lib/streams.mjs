// Streams under $FACTORY_RUNS: run.jsonl or run-<tag>.jsonl, .err and .log, and Lead transcript copies.
// A seat's files are in its run folder, <runs>/<folder>/, or, for a seat run by hand, <runs>/<repo>/<seat>/ (the layout quota.mjs reads, FAC-43).
// With a state folder, also include its sessions.jsonl seat lifecycle records. Links are never followed.
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_COPY = /^([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/;
const SEAT_FILE = /^run(?:-(.+))?\.(?:jsonl|err|log)$/;
const NOT_SEATS = new Set(['w', 'transcripts']);

const entries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The streams under the runs folder: [{ key, file, header }] with the key relative to it. A seat's header is `<run folder> <tag>` (or
 * `<repo>/<seat> <tag>` two folders down), a Lead's `<repo>-<team> <first 8 characters of the session id>`. */
export function listStreams(runs, state) {
  const found = [];
  const seats = (folder) => {
    for (const f of entries(join(runs, folder)).filter((e) => e.isFile())) {
      const m = SEAT_FILE.exec(f.name);
      if (m) found.push({ key: `${folder}/${f.name}`, file: join(runs, folder, f.name), header: `${folder} ${m[1] ?? 'run'}` });
    }
  };
  for (const d of entries(runs).filter((e) => e.isDirectory())) {
    seats(d.name);
    // w/ is a pack Lead's worktree, whose root may hold a product repository's run.log, and transcripts/ a Lead's copies: no seat folders.
    for (const sub of entries(join(runs, d.name)).filter((e) => e.isDirectory() && !NOT_SEATS.has(e.name))) seats(`${d.name}/${sub.name}`);
    for (const f of entries(join(runs, d.name, 'transcripts')).filter((e) => e.isFile())) {
      const m = SESSION_COPY.exec(f.name);
      if (m) found.push({ key: `${d.name}/transcripts/${f.name}`, file: join(runs, d.name, 'transcripts', f.name), header: `${d.name} ${m[1]}` });
    }
  }
  if (state) {
    const file = join(state, 'sessions.jsonl');
    try {
      if (lstatSync(file).isFile()) found.push({ key: 'sessions.jsonl', file, header: 'sessions.jsonl' });
    } catch { /* no seat records yet */ }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}
