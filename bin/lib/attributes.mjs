// The kit's review categories in a repository's own .gitattributes (#380). The kit holds the lines in one file,
// kit/.gate/review-categories: one marked block, and nothing outside it. The repository's .gitattributes gets that block at
// its start, so its own lines come after it and win ("a later line wins"); bin/kit-update replaces the block and nothing
// else, and bin/kit-evidence judges it the way it judges the Gate block of AGENTS.md (bin/lib/evidence.mjs).
//   node bin/lib/attributes.mjs compose --block <file> [--attributes <file>]   the .gitattributes onboard writes, on stdout
// Exit 0 fine, 1 when the file cannot take the block (the reason on stderr), 2 for a usage error.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ATTRIBUTES = '.gitattributes';
export const BLOCK_FILE = '.gate/review-categories';
const BEGIN = '# factory:review-categories:begin';
const END = '# factory:review-categories:end';

const marks = (line, marker) => line === marker || line.startsWith(`${marker} `);
const blank = (line) => /^\s*$/.test(line);

function fail(problem, message) {
  return Object.assign(new Error(message), { problem });
}

/** Where the block is: { ok: true, head, block, tail } with head + block + tail the text, or { ok: false, problem }: missing,
 * duplicate, malformed or not-at-start (only blank lines may come before it). A marker is a whole line. */
export function splitBlock(text) {
  const lines = String(text).split('\n');
  const begins = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (marks(line, BEGIN)) begins.push(i);
    if (marks(line, END)) ends.push(i);
  });
  if (!begins.length && !ends.length) return { ok: false, problem: 'missing' };
  if (begins.length > 1 || ends.length > 1) return { ok: false, problem: 'duplicate' };
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { ok: false, problem: 'malformed' };
  const [b] = begins;
  const [e] = ends;
  if (lines.slice(0, b).some((line) => !blank(line))) return { ok: false, problem: 'not-at-start' };
  const head = b ? `${lines.slice(0, b).join('\n')}\n` : '';
  const block = lines.slice(b, e + 1).join('\n') + (e + 1 < lines.length ? '\n' : '');
  const tail = lines.slice(e + 1).join('\n');
  return { ok: true, head, block, tail };
}

/** The text with the kit's block at its start, a blank line between it and the repository's own lines. A text that already
 * holds exactly this block comes back unchanged. Throws, with .problem, on CRLF, a byte-order mark, a block that is not this
 * one and any other marker line. */
export function insertBlock(text, block) {
  if (text.includes('\r')) throw fail('crlf', 'the file has CRLF line ends; the block would mix them (convert them first)');
  if (text.startsWith('﻿')) throw fail('bom', 'the file starts with a byte-order mark; the block must come first, so take the mark out first');
  const found = splitBlock(text);
  if (found.ok) {
    if (found.block === block) return text;
    throw fail('altered', "the file has a review-categories block that is not the kit's");
  }
  if (found.problem !== 'missing') throw fail(found.problem, `the file has review-categories markers and they are ${found.problem}`);
  return text === '' ? block : `${block}\n${text}`;
}

/** The text with its block replaced by `block`; the head and the tail are not touched. Throws, with .problem, on CRLF, as
 * insertBlock does, and on a block that is missing, duplicate, malformed or not at the start. */
export function replaceBlock(text, block) {
  if (text.includes('\r')) throw fail('crlf', 'the file has CRLF line ends; the block would mix them (convert them first)');
  const found = splitBlock(text);
  if (!found.ok) throw fail(found.problem, `the file's review-categories block is ${found.problem}`);
  return found.head + block + found.tail;
}

function main([command, ...rest]) {
  const option = (key) => (rest.includes(key) ? rest[rest.indexOf(key) + 1] : undefined);
  if (command !== 'compose' || !option('--block')) {
    console.error('usage: attributes.mjs compose --block <file> [--attributes <file>]');
    return 2;
  }
  try {
    const block = readFileSync(option('--block'), 'utf8');
    let text = '';
    if (option('--attributes')) {
      if (!lstatSync(option('--attributes')).isFile()) throw fail('not-a-file', `${option('--attributes')} is not a regular file`);
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(option('--attributes')));
    }
    process.stdout.write(option('--attributes') ? insertBlock(text, block) : block);
    return 0;
  } catch (error) {
    console.error(error.problem ? error.message : `could not compose ${ATTRIBUTES}: ${error.message}`);
    return 1;
  }
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
