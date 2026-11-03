// The wake of a Lead (#351): one line written into the Lead's Claude Code inbox socket, so a message for it reaches it with no keys typed
// into its pane. The message itself is a comment on the issue; the line only says to re-read it and carries no content and no authority.
// The Lead's hook records the socket's path in a file at every start (packs/pstack/bin/transcript-copy.mjs; bin/lib/socket-hook.mjs for the
// factory repository's own Lead), since the path changes on every restart. The line is piggery's form (internal/cli/mcp.go, `nudge`, MIT):
// one JSON object { type: "user", message: { content } } and a newline, with no `priority` (it would abort a running tool) and no auth
// line: the token Claude Code exports (CLAUDE_CODE_MESSAGING_TOKEN) is never read here. Claude Code drops identical repeats, so each line
// names a number that differs on every post.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POST_TIMEOUT_MS = 3000;

let counter = 0;

/** The line to post for a new comment on `repo`#`issue`. The number in it is the time in ms and a counter of this process. */
export function wakeLine(repo, issue, now = Date.now()) {
  counter += 1;
  const content = `[factory] wake #${now}-${counter}: new comment on ${repo}#${issue}; re-read the issue.`;
  return `${JSON.stringify({ type: 'user', message: { content } })}\n`;
}

/** The path a hook recorded in `file`, without a leading `uds:`, or null when there is no such file or it is empty. */
export function recordedPath(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return text.trim().replace(/^uds:/, '') || null;
}

/** Posts `line` to the socket whose path `file` records. Resolves { posted: true } or { posted: false, why }: no file (nothing recorded, or
 * the socket is gone), not an absolute path, not a socket (a symlink counts as none), not ours (another user's), refused (nothing listens
 * there), timed out. */
export function post(file, line, { timeoutMs = POST_TIMEOUT_MS } = {}) {
  const no = (why) => Promise.resolve({ posted: false, why });
  const path = recordedPath(file);
  if (path === null) return no('no file');
  if (!isAbsolute(path)) return no('not an absolute path');
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return no('no file');
  }
  if (!st.isSocket()) return no('not a socket');
  if (st.uid !== process.getuid?.()) return no('not ours');
  return new Promise((done) => {
    let over = false;
    const finish = (r) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      socket.destroy();
      done(r);
    };
    const socket = createConnection(path);
    const timer = setTimeout(() => finish({ posted: false, why: 'timed out' }), timeoutMs);
    socket.on('error', () => finish({ posted: false, why: 'refused' }));
    socket.on('connect', () => socket.end(line, () => finish({ posted: true })));
  });
}

/** The same post for a caller that cannot wait for a promise (the sweep): a node process of its own runs `post` and prints its result. */
export function postSync(file, line, { timeoutMs = POST_TIMEOUT_MS } = {}) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), file, String(timeoutMs)], { input: line, encoding: 'utf8', timeout: timeoutMs + 5000, killSignal: 'SIGKILL' });
  try {
    const out = JSON.parse(r.stdout);
    if (typeof out?.posted === 'boolean') return out;
  } catch {
    // no answer
  }
  return { posted: false, why: r.error?.code === 'ETIMEDOUT' ? 'timed out' : 'failed' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await post(process.argv[2] ?? '', readFileSync(0, 'utf8'), { timeoutMs: Number(process.argv[3]) || POST_TIMEOUT_MS });
  process.stdout.write(JSON.stringify(r));
}
