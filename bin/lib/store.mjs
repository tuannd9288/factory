// The daemon's store (#399): SQLite through node:sqlite (Stability 1.2, release candidate on Node 24.15 and later), at $FACTORY_STATE/factory.db.
// The pick is on effectiveness, on his word of 2026-11-04 14:28 +07, and the measurements are on #399. Settings are piggery's (v0.10.3,
// internal/store/store.go:117, 132-133): WAL, busy_timeout 5000, foreign keys, one connection, owned by the daemon. `synchronous` stays at its
// default (FULL). No client opens the database (store.go:2): the readers ask the daemon over its socket (bin/lib/daemon.mjs), and when it is down
// they say so. Migrations run one transaction a step, after a VACUUM INTO backup of an existing database that has a step to take, the last
// three backups kept (store.go:141-251). `meta.schema_version` is the version; a step is never edited once applied: add the next one.
// Slice 1 holds what the daemon newly owns:
//   offsets  how far the daemon has read into a file, by name ('sessions.jsonl': bytes). It is the daemon's own read position; what keeps a
//            seat from waking twice is the state file queue-seats.news, as before (bin/lib/news-wake.mjs).
//   posts    each seat end the daemon took: when it arrived (ms), the verb, the run and tag, the session, when its wake went out (woke_at, ms) or
//            why it did not (why), and the seq of the events line. Slice 4 measures a seat's end to its Lead's wake from this table.
// One module wraps node:sqlite, so a Node upgrade that changes it fails here, in the store's test.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** migrations[i] takes the database from version i to i+1. */
export const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE offsets (name TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE posts (
     id INTEGER PRIMARY KEY,
     arrived_at INTEGER NOT NULL,
     verb TEXT NOT NULL,
     run TEXT,
     tag TEXT,
     session TEXT,
     woke_at INTEGER,
     why TEXT,
     seq INTEGER
   );
   CREATE INDEX posts_run_tag ON posts (run, tag);`,
  `CREATE TABLE linear_events (
     event_key TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     issue_identifier TEXT NOT NULL,
     team_key TEXT NOT NULL,
     actor_id TEXT,
     time INTEGER NOT NULL
   );`,
];

const KEEP_BACKUPS = 3;
const BACKUP_NAME = /^pre-v(\d+)-(\d+)-(\d{4}-\d{2}-\d{2})\.db$/;

const pad = (n) => String(n).padStart(2, '0');
const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A consistent copy of the database (a file copy of a WAL database is not one) to dir/pre-v<from>-<to>-<date>.db, then all but the newest
 * KEEP_BACKUPS of that name pattern go. A failure stops the migration and names the path. */
function backup(db, dir, from, to, now) {
  const dst = join(dir, `pre-v${from}-${to}-${dateOf(now)}.db`);
  const tmp = `${dst}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rmSync(tmp, { force: true }); // VACUUM INTO needs a file that does not exist; a same-day retry replaces the old backup
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    chmodSync(tmp, 0o600);
    renameSync(tmp, dst);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new Error(`store: back up before migrating v${from} to v${to}, writing ${dst}: ${error.message}`);
  }
  const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n));
  const key = (n) => {
    const [, f, t, date] = BACKUP_NAME.exec(n);
    return { date, f: Number(f), t: Number(t) };
  };
  names.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x.date !== y.date ? (x.date < y.date ? 1 : -1) : x.t !== y.t ? y.t - x.t : y.f - x.f; // newest first
  });
  for (const n of names.slice(KEEP_BACKUPS)) rmSync(join(dir, n), { force: true });
}

/** Brings the database to the latest version, one transaction a step. `migrations` and `backupDir` are for tests. */
export function migrate(db, { migrations = MIGRATIONS, backupDir = null, now = Date.now() } = {}) {
  const hasMeta = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'").get().n === 1;
  let version = 0;
  if (hasMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    version = Number(row?.value);
    if (!Number.isInteger(version) || version < 1 || version > migrations.length) throw new Error(`store: unsupported schema version ${JSON.stringify(row?.value)}`);
    if (version < migrations.length && backupDir) backup(db, backupDir, version, migrations.length, now);
  }
  for (; version < migrations.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[version]);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(version + 1));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`store: migrate to v${version + 1}: ${error.message}`);
    }
  }
}

/** Opens (creating, mode 0600) the database at `file` with the settings above and brings it to the latest version. Returns the store. */
export function openStore(file, { migrations = MIGRATIONS, now = () => Date.now() } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  closeSync(openSync(file, 'a', 0o600));
  const db = new DatabaseSync(file);
  try {
    // busy_timeout first: switching to WAL needs a lock, and a database another opener holds should be waited for, not refused at once.
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    migrate(db, { migrations, backupDir: join(dirname(file), 'backups'), now: now() });
  } catch (error) {
    db.close();
    throw error;
  }
  const q = (sql) => db.prepare(sql);
  const getOffset = q('SELECT value FROM offsets WHERE name = ?');
  const setOffset = q('INSERT INTO offsets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const addPost = q('INSERT INTO posts (arrived_at, verb, run, tag, session) VALUES (?, ?, ?, ?, ?)');
  const settle = q('UPDATE posts SET woke_at = ?, why = ?, seq = ? WHERE id = ?');
  const allPosts = q('SELECT * FROM posts ORDER BY id');
  return {
    file,
    version: () => Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value),
    /** The bytes of `name` read so far, 0 when none. */
    offset: (name) => Number(getOffset.get(name)?.value ?? 0),
    setOffset: (name, value) => void setOffset.run(name, value, now()),
    /** Records a post that arrived (now, in ms, unless `at` says); returns its id. */
    post: ({ verb, run = null, tag = null, session = null, at = now() }) => Number(addPost.run(at, verb, run, tag, session).lastInsertRowid),
    /** Settles a post: `wokeAt` (ms) when its wake went out, else `why` it did not; `seq` is the events line it wrote, if any. */
    settle: (id, { wokeAt = null, why = null, seq = null }) => void settle.run(wokeAt, why, seq, id),
    posts: () => allPosts.all().map((r) => ({ ...r })),
    /** Linear's own ids deduplicate stream and catch-up; the cursor commits with the row. */
    linearEvent: ({ kind, id, issueIdentifier, teamKey, actorId = null, time }) => {
      const key = kind === 'commentCreated' ? id : `${id}:${time}`;
      db.exec('BEGIN IMMEDIATE');
      try {
        const added = q('INSERT OR IGNORE INTO linear_events VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(key, kind, id, issueIdentifier, teamKey, actorId, time).changes > 0;
        if (added) setOffset.run('linear', Math.max(time, Number(getOffset.get('linear')?.value ?? 0)), now());
        db.exec('COMMIT');
        return added;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    linearEvents: () => q('SELECT * FROM linear_events ORDER BY time, event_key').all().map((r) => ({ ...r })),
    /** What the connection runs with, as the settings above name them. */
    settings: () => ({
      journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      busy_timeout: Number(db.prepare('PRAGMA busy_timeout').get().timeout),
      foreign_keys: Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys),
      synchronous: Number(db.prepare('PRAGMA synchronous').get().synchronous),
    }),
    close: () => db.close(),
  };
}
