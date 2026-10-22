// A repository's own parts of its AGENTS.md: the two sections the kit's AGENTS.md ends with, Layout and Facts the code
// cannot tell, filled from a file the Human approved (bin/onboard --own <file>) when the kit replaces the repository's
// own instructions. The file holds exactly those two sections, in that order, each with a body and no # or ## heading
// in it, since a heading there would read as a section of the kit's rules. bin/kit-evidence reads the parts back out
// of the kit pull request's AGENTS.md with the same parser, so its check needs no copy of the file.
//   node bin/lib/own.mjs check <own file> <kit AGENTS.md>   exit 1, saying why, unless the file can fill the kit's
//   node bin/lib/own.mjs fill <own file> <AGENTS.md>        fills the two sections of AGENTS.md in place
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LAYOUT = '## Layout';
export const FACTS = '## Facts the code cannot tell';
export const LIMIT = 150;
const HEADING = /^#{1,2}(\s|$)/;

const linesOf = (text) => String(text).replace(/\r/g, '').replace(/\n$/, '').split('\n');
const trimmed = (lines) => {
  let from = 0;
  let to = lines.length;
  while (from < to && !lines[from].trim()) from += 1;
  while (to > from && !lines[to - 1].trim()) to -= 1;
  return lines.slice(from, to);
};

/** The bodies of the two sections, blank lines at their edges dropped; throws, saying why, on anything else. */
export function parseOwn(text) {
  const lines = linesOf(text);
  const at = (h) => lines.findIndex((l) => l.trimEnd() === h);
  const layout = at(LAYOUT);
  const facts = at(FACTS);
  if (layout < 0) throw new Error(`no section "${LAYOUT}"`);
  if (facts < 0) throw new Error(`no section "${FACTS}"`);
  if (facts < layout) throw new Error(`"${FACTS}" comes before "${LAYOUT}"`);
  if (trimmed(lines.slice(0, layout)).length) throw new Error(`text before "${LAYOUT}"`);
  const out = {};
  for (const [name, from, to] of [['Layout', layout + 1, facts], ['Facts the code cannot tell', facts + 1, lines.length]]) {
    const body = trimmed(lines.slice(from, to));
    if (!body.length) throw new Error(`the section "${name}" is empty`);
    const n = body.findIndex((l) => HEADING.test(l));
    if (n >= 0) throw new Error(`line ${n + 1} of ${name} is a heading (${body[n]}); a heading there would outrank the kit's rules`);
    out[name === 'Layout' ? 'layout' : 'facts'] = body;
  }
  return out;
}

/** Where the kit's AGENTS.md holds the two sections: it must end with them, Layout first. */
function sectionsOf(kit) {
  const lines = linesOf(kit);
  const layout = lines.indexOf(LAYOUT);
  const facts = lines.indexOf(FACTS);
  if (layout < 0 || facts < layout || lines.slice(facts + 1).some((l) => HEADING.test(l)) || lines.slice(layout + 1, facts).some((l) => HEADING.test(l)))
    throw new Error(`the kit's AGENTS.md does not end with "${LAYOUT}" and "${FACTS}"`);
  return { lines, layout, facts };
}

/** How many body lines the two sections can hold within LIMIT: the kit's lines without its two placeholder lines. */
export function budgetOf(kit) {
  const { lines, layout, facts } = sectionsOf(kit);
  return LIMIT - (lines.length - trimmed(lines.slice(layout + 1, facts)).length - trimmed(lines.slice(facts + 1)).length);
}

/** The kit's AGENTS.md (rendered or not) with the two sections' bodies replaced by own's; the line of each body's
 * first line, 1-based, comes with it. */
export function fill(kit, own) {
  const { lines, layout } = sectionsOf(kit);
  const head = lines.slice(0, layout + 1);
  const text = [...head, '', ...own.layout, '', FACTS, '', ...own.facts].join('\n');
  return { text: `${text}\n`, layoutAt: head.length + 2, factsAt: head.length + own.layout.length + 5 };
}

function main([verb, ownPath, target]) {
  if (!['check', 'fill'].includes(verb) || !ownPath || !target) {
    console.log('usage: node bin/lib/own.mjs check <own file> <kit AGENTS.md> | fill <own file> <AGENTS.md>');
    return 2;
  }
  let own;
  try {
    own = parseOwn(readFileSync(ownPath, 'utf8'));
  } catch (error) {
    console.log(`--own ${ownPath}: ${error.message}`);
    return 1;
  }
  const kit = readFileSync(target, 'utf8');
  if (verb === 'check') {
    const budget = budgetOf(kit);
    const n = own.layout.length + own.facts.length;
    if (n > budget) {
      console.log(`--own ${ownPath}: its two bodies are ${n} lines; the kit's AGENTS.md leaves room for ${budget} (at most ${LIMIT} lines)`);
      return 1;
    }
    return 0;
  }
  writeFileSync(target, fill(kit, own).text);
  return 0;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`own: ${error.message}`);
    process.exitCode = 2;
  }
}
