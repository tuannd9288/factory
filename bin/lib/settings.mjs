// The kit's deny lines added to a repository's own .claude/settings.json, as text: the file is parsed only to learn what
// is missing and where the deny array sits, and the new lines are inserted at that place, so every other byte stays.
// The shapes it takes are the pig repositories': a multi-line deny array, a one-line one, no `permissions` key.
// Anything else (comments, CRLF, a permissions object without deny, a one-line file) is refused with a message.
//   node bin/lib/settings.mjs add <repository settings.json> <kit settings.json>   rewrites the first in place
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A JSON text as a tree with offsets: { type, start, end, members: Map(key -> node), items: [node] }. Throws on bad JSON. */
function scan(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1;
  };
  const value = () => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      const members = new Map();
      i += 1;
      ws();
      if (text[i] === '}') i += 1;
      else
        for (;;) {
          ws();
          const key = JSON.parse(text.slice(i, (i = stringEnd(i))));
          ws();
          if (text[i++] !== ':') throw new Error('expected :');
          members.set(key, value());
          ws();
          if (text[i] === ',') i += 1;
          else if (text[i++] === '}') break;
          else throw new Error('expected , or }');
        }
      return { type: 'object', start, end: i, members };
    }
    if (c === '[') {
      const items = [];
      i += 1;
      ws();
      if (text[i] === ']') i += 1;
      else
        for (;;) {
          items.push(value());
          ws();
          if (text[i] === ',') i += 1;
          else if (text[i++] === ']') break;
          else throw new Error('expected , or ]');
        }
      return { type: 'array', start, end: i, items };
    }
    if (c === '"') {
      i = stringEnd(i);
      return { type: 'string', start, end: i, text: JSON.parse(text.slice(start, i)) };
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new Error('bad value');
    i += m[0].length;
    return { type: 'other', start, end: i };
  };
  const stringEnd = (from) => {
    let j = from + 1;
    while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  const root = value();
  ws();
  if (i !== text.length) throw new Error('text after the value');
  return root;
}

const lineIndent = (text, at) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))[0];

/** `text` with the lines of `wanted` it lacks added to permissions.deny: { text, added, ranges } (ranges: [from, to) of
 * the new text, what was inserted). */
export function addDeny(input, wanted) {
  let text = input;
  if (Buffer.isBuffer(input)) {
    text = input.toString('utf8');
    // Decoding replaces a byte that is not UTF-8, and writing the string back would change it: refuse before that.
    if (!Buffer.from(text, 'utf8').equals(input)) throw new Error('the file is not UTF-8, so the lines cannot be added without changing other bytes; add them by hand');
  }
  if (text.startsWith('\uFEFF')) throw new Error('the file starts with a byte order mark; add the deny lines by hand');
  if (text.includes('\r')) throw new Error('the file has CRLF line ends (CRLF is refused: the new lines would mix them)');
  let root;
  try {
    JSON.parse(text);
    root = scan(text);
  } catch {
    throw new Error('the file is not plain JSON (a comment or a trailing comma?); add the deny lines by hand');
  }
  if (root.type !== 'object') throw new Error('the file is not a JSON object');
  const quote = (s) => JSON.stringify(s);
  let perms = root.members.get('permissions');
  if (!perms) {
    if (!root.members.size) throw new Error('the file is an empty object; add the deny lines by hand');
    if (!text.slice(root.start, root.end).includes('\n')) throw new Error('the file is the object on one line; add the deny lines by hand');
    const unit = lineIndent(text, [...root.members.values()][0].start);
    const inner = unit + unit;
    const last = [...root.members.values()].at(-1).end;
    const add = `,\n${unit}"permissions": {\n${inner}"deny": [\n${wanted.map((w) => `${inner}${unit}${quote(w)}`).join(',\n')}\n${inner}]\n${unit}}`;
    return { text: text.slice(0, last) + add + text.slice(last), added: [...wanted], ranges: [[last, last + add.length]] };
  }
  const deny = perms.type === 'object' ? perms.members.get('deny') : null;
  if (!deny || deny.type !== 'array' || deny.items.some((x) => x.type !== 'string')) throw new Error('"permissions" has no "deny" array of strings; add the deny lines by hand');
  const have = new Set(deny.items.map((x) => x.text));
  const missing = wanted.filter((w) => !have.has(w));
  if (!missing.length) return { text, added: [], ranges: [] };
  if (!deny.items.length) {
    // After the `[`, so whatever sits between the brackets stays.
    const add = missing.map(quote).join(', ');
    return { text: text.slice(0, deny.start + 1) + add + text.slice(deny.start + 1), added: missing, ranges: [[deny.start + 1, deny.start + 1 + add.length]] };
  }
  const last = deny.items.at(-1);
  const oneLine = !text.slice(deny.start, deny.end).includes('\n');
  const sep = oneLine ? ', ' : `,\n${lineIndent(text, last.start)}`;
  const add = missing.map((w) => `${sep}${quote(w)}`).join('');
  return { text: text.slice(0, last.end) + add + text.slice(last.end), added: missing, ranges: [[last.end, last.end + add.length]] };
}

function main([verb, file, kit]) {
  if (verb !== 'add' || !file || !kit) {
    console.log('usage: node bin/lib/settings.mjs add <repository settings.json> <kit settings.json>');
    return 2;
  }
  try {
    const wanted = JSON.parse(readFileSync(kit, 'utf8')).permissions.deny;
    const out = addDeny(readFileSync(file), wanted);
    if (out.added.length) writeFileSync(file, out.text);
    console.log(`settings: added ${out.added.length} deny line${out.added.length === 1 ? '' : 's'} to ${file}`);
    return 0;
  } catch (error) {
    console.log(`settings: ${file}: ${error.message}`);
    return 2;
  }
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
