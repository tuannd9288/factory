// The research eval's path check (#92): the runner does not stop a session from reading outside its folders; it reads the session's
// log after the run and lists every path in a tool input that lies outside them. A path it cannot place counts as outside.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// The fields that hold a path (a `pattern` or `glob` only when it is absolute or climbs with ".."), and the tool whose `command`
// is a shell command. Every tool's input is read, so that a note left by Write or Edit outside the folders counts too.
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'];
const PATTERN_FIELDS = ['pattern', 'glob'];
const UNPLACEABLE = /\$[A-Za-z_{(]|`/;
// Reading or writing the null device reaches no session's files.
const HARMLESS = new Set(['/dev/null']);

/** The real path of a path that need not exist: the real path of its deepest existing folder, and the rest as it is. */
const realOf = (path) => {
  let head = path;
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...rest);
};

/** Where a path sits, as an absolute real path, or null when it cannot be placed (a variable, a command substitution, another
 * user's home). A glob is placed at the folder before its first wildcard. */
export function place(raw, { cwd, home }) {
  if (UNPLACEABLE.test(raw)) return null;
  let p = raw;
  const wild = p.search(/[*?[{]/);
  if (wild >= 0) p = p.slice(0, p.lastIndexOf('/', wild) + 1) || '.';
  if (p === '~' || p.startsWith('~/')) p = join(home, p.slice(1));
  else if (p.startsWith('~')) return null;
  return realOf(resolve(cwd, p));
}

/** Every path the tool inputs of a session's log hold: [{ tool, path }], as the session wrote them. */
export function pathsOf(logText) {
  const out = [];
  for (const l of logText.split('\n')) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type !== 'assistant') continue;
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_use' || typeof c.input !== 'object' || c.input === null) continue;
      for (const f of PATH_FIELDS) if (typeof c.input[f] === 'string') out.push({ tool: c.name, path: c.input[f] });
      for (const f of PATTERN_FIELDS) if (typeof c.input[f] === 'string' && (c.input[f].startsWith('/') || c.input[f].includes('..'))) out.push({ tool: c.name, path: c.input[f] });
      if (typeof c.input.command === 'string') {
        // Split on whitespace, quotes and the shell's separators, so that `2>/dev/null` and `--dir=/x` give their paths.
        for (const t of c.input.command.split(/[\s;|&<>'"=,:]+/)) {
          if (UNPLACEABLE.test(t) || t.startsWith('/') || t.startsWith('~') || t.includes('..')) out.push({ tool: c.name, path: t });
        }
      }
    }
  }
  return out;
}

/** The paths of a log that lie outside the folders: [{ tool, path }]. `inside` are the folders the session was given. */
export function outsidePaths(logText, { cwd, inside, home }) {
  const roots = inside.map((d) => realOf(resolve(d)));
  return pathsOf(logText).filter(({ path }) => {
    if (HARMLESS.has(path)) return false;
    const at = place(path, { cwd, home });
    return at === null || !roots.some((r) => at === r || at.startsWith(`${r}/`));
  });
}
