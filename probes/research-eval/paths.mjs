// The research eval's path check (#92): the runner does not stop a session from reading outside its folders; it reads the session's
// log after the run and lists every path in a tool input that lies outside them. A path it cannot place counts as outside.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// The fields that hold a path (a `pattern` or `glob` only when it is absolute or climbs with ".."), and the tool whose `command`
// is a shell command. Every tool's input is read, so that a note left by Write or Edit outside the folders counts too.
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'];
const PATTERN_FIELDS = ['pattern', 'glob'];
const UNPLACEABLE = /\$[A-Za-z_{(]|`/;
// A shell expansion in text that is not single-quoted: the word that holds it cannot be placed, so it counts as outside.
const EXPANSION = /[$`\\{}]/;

/** The commands of a shell command line, each a list of words { raw, text, plain }: `raw` as written, `text` with the quotes taken
 * off, `plain` when no unquoted or double-quoted part of it holds an expansion. Words split on whitespace and on `; | & < >` and
 * a newline outside quotes; single-quoted text is literal. */
export function wordsOf(command) {
  const commands = [[]];
  let word = null;
  let quote = null;
  const open = () => (word ??= { raw: '', text: '', open: '' });
  const end = () => {
    if (word) {
      commands.at(-1).push({ raw: word.raw, text: word.text, plain: !EXPANSION.test(word.open) });
      word = null;
    }
  };
  const chars = [...command];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '\\' && quote !== "'") {
      // A backslash escapes the next character: it opens no quote and ends no word. The word it is in is not plain.
      open();
      const next = chars[i + 1] ?? '';
      word.raw += ch + next;
      word.text += next;
      word.open += ch;
      i += 1;
    } else if (quote === "'") {
      word.raw += ch;
      if (ch === "'") {
        quote = null;
        word.open += '\0';
      } else word.text += ch;
    } else if (quote === '"') {
      word.raw += ch;
      if (ch === '"') quote = null;
      else {
        word.text += ch;
        word.open += ch;
      }
    } else if (ch === "'" || ch === '"') {
      open().raw += ch;
      quote = ch;
    } else if (/\s/.test(ch) || ';|&<>'.includes(ch)) {
      end();
      if (ch === '\n' || ';|&'.includes(ch)) commands.push([]);
    } else {
      open();
      word.raw += ch;
      word.text += ch;
      word.open += ch;
    }
  }
  end();
  return commands;
}
// Reading or writing the null device reaches no session's files.
const HARMLESS = new Set(['/dev/null']);

const present = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The real path of a path that need not exist: the real path of its deepest existing folder, and the rest as it is. A link
 * whose target is gone is followed all the same, since the target may come back. */
export const realOf = (path, depth = 0) => {
  let head = path;
  const rest = [];
  while (!present(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  let base = head;
  if (present(head)) {
    try {
      base = realpathSync(head);
    } catch {
      base = depth < 20 ? realOf(resolve(dirname(head), readlinkSync(head)), depth + 1) : head;
    }
  }
  return join(base, ...rest);
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
        for (const words of wordsOf(c.input.command)) {
          for (const word of words) {
            if (!word.plain) out.push({ tool: c.name, path: word.raw, unplaceable: true });
            // A plain word is also split on "=", "," and ":", so that `--dir=/x` gives its path.
            else for (const t of word.text.split(/[=,:]+/)) if (t.startsWith('/') || t.startsWith('~') || t.includes('..')) out.push({ tool: c.name, path: t });
          }
        }
      }
    }
  }
  return out;
}

/** The paths of a log that lie outside the folders: [{ tool, path }]. `inside` are the folders the session was given. */
export function outsidePaths(logText, { cwd, inside, home }) {
  const roots = inside.map((d) => realOf(resolve(d)));
  return pathsOf(logText).filter(({ path, unplaceable }) => {
    if (unplaceable) return true;
    if (HARMLESS.has(path)) return false;
    const at = place(path, { cwd, home });
    return at === null || !roots.some((r) => at === r || at.startsWith(`${r}/`));
  });
}
