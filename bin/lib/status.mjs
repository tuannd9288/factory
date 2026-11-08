// The steps' markers in the state folder (FAC-85, fix 12), which Colly's status line (bin/lib/colly-status.mjs, queueOf) and the weekly
// digest (bin/lib/ledger.mjs, queueState) read:
//   <name>.failed  left by a step that failed, and removed by its next clean run
//   <name>.ok      the time of a clean run
// A marker's first line is an ISO time, then, for a failure, what went wrong: its first line, redacted (bin/lib/redact.mjs), at most 200
// characters. A failure may name more below it, one redacted line each (the worktrees a sweep kept). A repository's marker is
// `queue-<owner>-<name>`, the name the sweep gives a repository's state files. A marker that cannot be written says so on stderr with what it
// would have said, so a step that failed and could not record it still leaves a trace in its log. It imports only node: modules and two
// leaves, files.mjs and redact.mjs.
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './files.mjs';
import { redact } from './redact.mjs';

/** A repository's marker name: `queue-<owner>-<name>`. */
export const repoMarker = (repo) => `queue-${repo.replace('/', '-')}`;

/** What one line of a marker says: the first line of `text`, redacted, at most 200 characters. */
export const markerLine = (text) => redact(String(text ?? '').split('\n')[0]).slice(0, 200);

function leave(state, file, text) {
  try {
    mkdirSync(state, { recursive: true });
    writeAtomic(join(state, file), text);
  } catch (error) {
    process.stderr.write(`status: ${join(state, file)} could not be written (${error.code ?? error.message}); it would say: ${text.split('\n')[0]}\n`);
  }
}

/** Leaves `<name>.failed`: the time and the first line of `why`, then one line for each of `more`. */
export function markFailed(state, name, why, { now = Date.now(), more = [] } = {}) {
  leave(state, `${name}.failed`, `${new Date(now).toISOString()} ${markerLine(why)}\n${more.map((line) => `${markerLine(line)}\n`).join('')}`);
}

/** Leaves `<name>.ok`: the time of a clean run. */
export function markOk(state, name, { now = Date.now() } = {}) {
  leave(state, `${name}.ok`, `${new Date(now).toISOString()}\n`);
}

/** Removes `<name>.failed`, as a step's clean run does. */
export const clearFailed = (state, name) => rmSync(join(state, `${name}.failed`), { force: true });

/** The markers in the state folder, sorted by file name: { file, name, kind ('failed' or 'ok'), line }, `line` being the file's first line,
 * trimmed ('' when it cannot be read). null when there is no folder. */
export function readMarkers(state) {
  let names;
  try {
    names = readdirSync(state).sort();
  } catch {
    return null;
  }
  return names.flatMap((file) => {
    const m = /^([^.].*)\.(failed|ok)$/.exec(file);
    if (!m) return [];
    let line = '';
    try {
      line = readFileSync(join(state, file), 'utf8').split('\n')[0].trim();
    } catch {
      // gone between the listing and the read, or unreadable
    }
    return [{ file, name: m[1], kind: m[2], line }];
  });
}
