// The two kinds of stream the reader (#339, bin/lib/reader.mjs) reads, found under the runs folder (~/factory-runs, else $FACTORY_RUNS), and
// nothing else: a seat's stream, <run>/run-<tag>.jsonl (bin/lib/seat.mjs), and a Lead's transcript copy,
// <repo>-<team>/transcripts/<session>.jsonl (packs/pstack/bin/transcript-copy.mjs). A link is none.
import { readdirSync } from 'node:fs';
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
export function listStreams(runs) {
  const found = [];
  for (const d of entries(runs).filter((e) => e.isDirectory())) {
    for (const f of entries(join(runs, d.name)).filter((e) => e.isFile())) {
      const m = /^run-(.+)\.jsonl$/.exec(f.name);
      if (m) found.push({ key: `${d.name}/${f.name}`, file: join(runs, d.name, f.name), header: `${d.name} ${m[1]}` });
    }
    for (const f of entries(join(runs, d.name, 'transcripts')).filter((e) => e.isFile())) {
      const m = SESSION_COPY.exec(f.name);
      if (m) found.push({ key: `${d.name}/transcripts/${f.name}`, file: join(runs, d.name, 'transcripts', f.name), header: `${d.name} ${m[1]}` });
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}
