// packs/pstack/bin/transcript-copy.mjs <dest> (#185): a hook of the pstack Lead, run as `node <this file> <dest>`.
// On Stop and SessionEnd it reads the hook's JSON on stdin and copies the transcript_path it names, and nothing else, to <dest>/<basename>, so the Lead
// reads its own earlier transcripts from a folder outside every profile (the deny list hides ~/.agent-profiles). The source must
// be an absolute path to a regular file, not a symlink, under $CLAUDE_CONFIG_DIR/projects/. It always exits 0: a Stop hook that
// exits 2 makes the session go on.
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

// The hook also tells `factory top` what the Lead is doing (#286): every event it runs for writes <dest>/../state.json,
// { event, type, at }, by rename. Only SessionStart, UserPromptSubmit and Notification stop there; the others (Stop, SessionEnd) copy.
const STATE_ONLY = new Set(['SessionStart', 'UserPromptSubmit', 'Notification']);

function note(dest, input) {
  if (typeof input?.hook_event_name !== 'string') return;
  const file = join(dirname(dest), 'state.json');
  const tmp = `${file}.tmp-${process.pid}`;
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(tmp, `${JSON.stringify({ event: input.hook_event_name, type: input.notification_type ?? null, at: new Date().toISOString() })}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function copy(dest) {
  if (!dest) throw new Error('usage: transcript-copy.mjs <dest>');
  const config = process.env.CLAUDE_CONFIG_DIR;
  if (!config || !isAbsolute(config)) throw new Error('CLAUDE_CONFIG_DIR is not an absolute path');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  note(dest, input);
  if (STATE_ONLY.has(input?.hook_event_name)) return;
  const source = input.transcript_path;
  if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('transcript_path is not an absolute path');
  const st = lstatSync(source);
  if (!st.isFile()) throw new Error(`${source} is not a regular file (a symlink counts as none)`);
  const projects = join(realpathSync(config), 'projects') + sep;
  if (!realpathSync(source).startsWith(projects)) throw new Error(`${source} is not under ${projects}`);

  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  const target = join(dest, basename(source));
  try {
    const have = lstatSync(target);
    if (have.isFile() && have.size === st.size && Math.abs(have.mtimeMs - st.mtimeMs) < 1) return;
  } catch {
    // No copy yet.
  }
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o600);
    utimesSync(tmp, st.atimeMs / 1000, st.mtimeMs / 1000);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

try {
  copy(process.argv[2]);
} catch (e) {
  process.stderr.write(`transcript-copy: ${e.message}\n`);
}
process.exitCode = 0;
