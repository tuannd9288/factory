// What the queue's sweep keeps to report a move of a repository's merge switch (#333, #309): $FACTORY_STATE/queue-<owner>-<name>.position,
// beside the .switch file, holds the last position seen and the last move ({ from, to, at }, or null). The first sight of a repository
// writes its position and reports nothing; a file that cannot be read counts as none. A position read that differs from the file's is a
// move: the file takes the new position and the move, with `at` the time of the sweep. The alert only tells; nothing here changes a
// setting, and the condition the events build from the move is in bin/lib/events.mjs (switchMoves).
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { POSITIONS } from '../../kit/.gate/bin/lib/switch.mjs';
import { writeAtomic } from './files.mjs';

const fileOf = (state, repo) => join(state, `queue-${repo.replace('/', '-')}.position`);

const moveOf = (m) => (m && POSITIONS.includes(m.from) && POSITIONS.includes(m.to) && typeof m.at === 'string' && Number.isFinite(Date.parse(m.at)) ? { from: m.from, to: m.to, at: m.at } : null);

/** What the file holds: { position, move }, or null when there is none or it cannot be parsed. */
function keptOf(file) {
  try {
    const k = JSON.parse(readFileSync(file, 'utf8'));
    return POSITIONS.includes(k?.position) ? { position: k.position, move: moveOf(k.move) } : null;
  } catch {
    return null;
  }
}

/** Compares the position just read for `repo` with the file's and returns the last move ({ from, to, at }) or null. The file is
 * written only when the position or the move changed. */
export function watchSwitch({ state, repo, position, now = Date.now() }) {
  const file = fileOf(state, repo);
  const kept = keptOf(file);
  const move = kept && kept.position !== position ? { from: kept.position, to: position, at: new Date(now).toISOString() } : (kept?.move ?? null);
  if (!kept || kept.position !== position) {
    mkdirSync(state, { recursive: true });
    writeAtomic(file, `${JSON.stringify({ position, move })}\n`);
  }
  return move;
}

/** The switch as the sweep last saw it, for the digest (INN-40): { position, since }, `since` being the time of its last move, or with
 * none the time the file was written, which is the sweep's first sight of it, since the file changes only with the position or the
 * move. Null when there is no file or it cannot be read. */
export function switchSince(state, repo) {
  const file = fileOf(state, repo);
  const kept = keptOf(file);
  if (!kept) return null;
  try {
    return { position: kept.position, since: kept.move?.at ?? statSync(file).mtime.toISOString() };
  } catch {
    return null;
  }
}
