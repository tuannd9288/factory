// One lock that the kernel frees when its holder dies (FAC-83): an exclusive transaction through node:sqlite on <path>.db, taken with no wait.
// SQLite's lock is the kernel's advisory file lock, which the kernel drops when the process ends, however it ends, and SQLite refuses a second
// connection in the same process too, a worker thread's included. So no pid, start time or age decides whether a holder is gone, and nothing is
// renamed or put back: two holders cannot both take it. piggery (internal/server/lock_unix.go:18 at 67c083e) and agent-orchestrator
// (backend/internal/datadirlock/flock_unix.go:17 at 9dc1c14) take flock for the same reason; Node has no flock, and node:sqlite is already
// loaded for bin/lib/store.mjs. Beside it, <path> holds a note of the holder, { pid, start, token }, for people and log lines only: nothing
// decides anything from it, and a note a dead holder left is written over by the next.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_BUSY = 5;
const busy = (error) => error?.errcode === SQLITE_BUSY || /database is locked/.test(String(error?.message));
// The open locks: a connection that nothing references can be collected, which closes it and frees the lock while its holder still runs.
const open = new Set();

/** Takes the lock at path and returns { pid, start, token, release() }, or null while another holder has it. */
export function takeLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(`${path}.db`, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (busy(error)) return null;
    throw error;
  }
  open.add(db);
  const note = { pid: process.pid, start: new Date(Date.now() - process.uptime() * 1000).toISOString(), token: randomBytes(8).toString('hex') };
  const release = () => {
    if (!open.delete(db)) return;
    if (holderOf(path)?.token === note.token) rmSync(path, { force: true });
    db.exec('ROLLBACK');
    db.close();
  };
  try {
    // What is there is a dead holder's note, or the directory an older lock used: the lock is ours, so nobody holds it.
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, JSON.stringify(note));
  } catch (error) {
    release();
    throw error;
  }
  return { ...note, release };
}

/** The holder the note at path records, or null when there is none (no note, a torn or foreign file). For showing, never for deciding. */
export function holderOf(path) {
  try {
    const h = JSON.parse(readFileSync(path, 'utf8'));
    return typeof h?.pid === 'number' && h.token ? h : null;
  } catch {
    return null;
  }
}

/** Whether a holder has the lock at path now, one in this process included. It takes and drops the lock to find out, so a holder that starts at
 * that instant is refused and tries again at its next turn. */
export function isHeld(path) {
  if (!existsSync(`${path}.db`)) return false;
  const db = new DatabaseSync(`${path}.db`, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
    db.exec('ROLLBACK');
    return false;
  } catch (error) {
    if (busy(error)) return true;
    throw error;
  } finally {
    db.close();
  }
}
