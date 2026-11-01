// The records bin/seat appends to sessions.jsonl in the state folder (#91). Apart from the ledger, which imports bin/seat's
// quota reader, so that bin/seat can read a record without a cycle (#286).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The records, none when the file is absent; a damaged line is skipped. */
export function readSessions(dir) {
  const file = join(dir, 'sessions.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}
