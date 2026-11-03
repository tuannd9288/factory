// bin/lib/socket-hook.mjs <file> (#351): a hook of the factory repository's own Lead on the MacBook (`factory lead factory --here`), run as
// `node <this file> <file>`. On SessionStart it writes the path of the Lead's Claude Code inbox socket (CLAUDE_CODE_MESSAGING_SOCKET, a leading
// `uds:` dropped) to <file> by rename, and on SessionEnd, or with the variable unset or empty, it removes <file>, so `factory wake` posts to the
// Lead that runs and to none that is gone. It reads the hook's JSON on stdin for the event's name alone, and never reads, writes or sends CLAUDE_CODE_MESSAGING_TOKEN. It always exits 0.
// It imports only node: modules, as packs/pstack/bin/transcript-copy.mjs does, which records the same file for a pack Lead.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

function record(file, event) {
  if (!isAbsolute(file ?? '')) throw new Error('usage: socket-hook.mjs <file>, an absolute path');
  if (event !== 'SessionStart' && event !== 'SessionEnd') return;
  const path = (process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? '').replace(/^uds:/, '');
  if (event === 'SessionEnd' || !path) return void rmSync(file, { force: true });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${path}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

try {
  record(process.argv[2], JSON.parse(readFileSync(0, 'utf8'))?.hook_event_name);
} catch (e) {
  process.stderr.write(`socket-hook: ${e.message}\n`);
}
process.exitCode = 0;
