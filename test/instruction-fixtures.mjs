// Invented instruction files for the tests (#132). The factory and the scratch repository are public and the product
// repositories are private, so nothing here is copied from one: a rulebook is a count of made-up lines, cut or padded to
// the line and byte size a real one has. The five sizes are the numbers of the five product rulebooks, and nothing else of them.

/** The five rulebooks' lines, UTF-8 bytes and how their CLAUDE.md reaches AGENTS.md. */
export const FIVE = {
  A: { lines: 93, bytes: 20623, carrier: 'import' },
  B: { lines: 90, bytes: 4980, carrier: 'addendum' },
  C: { lines: 121, bytes: 6468, carrier: 'import' },
  D: { lines: 384, bytes: 24754, carrier: 'symlink' },
  E: { lines: 109, bytes: 6002, carrier: 'import' },
};

const RULE = 'Invented rule: the widget service rotates its log, keeps seven files and reports the count each night. ';

/** A text of exactly `lines` lines, each ending in a newline, and, when `bytes` is given, exactly that many bytes. Line 1
 * is a title; every tenth line after it is a heading. */
export function rulebook({ lines, bytes = null, title = true }) {
  const base = bytes === null ? 60 : Math.floor(bytes / lines);
  const extra = bytes === null ? 0 : bytes - base * lines;
  const out = [];
  for (let i = 0; i < lines; i += 1) {
    const width = base - 1 + (i < extra ? 1 : 0);
    const seed = i === 0 && title ? '# Invented rulebook ' : i % 10 === 1 ? `## Part ${Math.floor(i / 10) + 1} ` : `${i}. ${RULE}`;
    out.push(seed.repeat(Math.ceil(width / seed.length) || 1).slice(0, width));
  }
  return `${out.join('\n')}\n`;
}

/** What CLAUDE.md holds for a carrier kind: a file's text, or a link's target. */
export function carrierOf(kind) {
  if (kind === 'symlink') return { link: 'AGENTS.md' };
  if (kind === 'addendum') return { text: '@AGENTS.md\n\n## For Claude Code only\n\nUse plan mode before a change that touches more than one folder.\n' };
  return { text: '@AGENTS.md\n' };
}
