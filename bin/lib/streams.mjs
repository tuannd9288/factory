// Streams under $FACTORY_RUNS: run.jsonl or run-<tag>.jsonl, .err and .log, and Lead transcript copies.
// With a state folder, also include its sessions.jsonl seat lifecycle records. Links are never followed.
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_COPY = /^([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/;

const entries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The streams under the runs folder: [{ key, file, header }] with the key relative to it. A seat's header is `<run folder> <tag>`, a Lead's
 * `<repo>-<team> <first 8 characters of the session id>`. */
export function listStreams(runs, state) {
  const found = [];
  for (const d of entries(runs).filter((e) => e.isDirectory())) {
    for (const f of entries(join(runs, d.name)).filter((e) => e.isFile())) {
      const m = /^run(?:-(.+))?\.(?:jsonl|err|log)$/.exec(f.name);
      if (m) found.push({ key: `${d.name}/${f.name}`, file: join(runs, d.name, f.name), header: `${d.name} ${m[1] ?? 'run'}` });
    }
    for (const f of entries(join(runs, d.name, 'transcripts')).filter((e) => e.isFile())) {
      const m = SESSION_COPY.exec(f.name);
      if (m) found.push({ key: `${d.name}/transcripts/${f.name}`, file: join(runs, d.name, 'transcripts', f.name), header: `${d.name} ${m[1] ?? 'run'}` });
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
