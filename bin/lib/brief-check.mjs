// The check behind bin/brief-check (#90): a brief must carry what the relay it came from quotes and counts. It compares
// literally, with no list of exceptions and no model call: every span the relay puts in double quotes must appear in the
// brief, and so must every number. Which quotes are the Human's it does not judge, since that needs context; the rule
// covers the relay's quotes as a whole. Only the brief's own body counts: the template ends with a section that attaches
// Colly's message as data, and the brief is cut at that heading, or every brief would pass.
//
// Normalised, and nothing else: runs of whitespace become one space (and the ends are trimmed), and curly double quotes
// “ ” and single quotes ‘ ’ read as the straight " and '. Case, dashes, accents and punctuation are compared as written.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The heading the brief template (bin/brief-template.md) puts above Colly's attached message. */
export const ATTACHMENT_HEADING = "## Colly's message, attached as data";

const squeeze = (text) => text.replace(/\s+/g, ' ').trim();
const straight = (text) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** The brief's own body: everything above the first line that is the attachment heading. */
export function body(brief) {
  const lines = brief.split('\n');
  const at = lines.findIndex((line) => line.trimEnd() === ATTACHMENT_HEADING);
  return at < 0 ? brief : `${lines.slice(0, at).join('\n')}\n`;
}

/** The spans a text puts in double quotes, curly or straight, normalised, in order. An empty span is not a quote. */
export function quotes(text) {
  const spans = [];
  for (const m of text.matchAll(/“([^”]*)”|"([^"]*)"/g)) spans.push(squeeze(straight(m[1] ?? m[2])));
  return spans.filter(Boolean);
}

/** The numbers in a text: a maximal run of digits, with a decimal point or a thousands comma inside it. */
export function numbers(text) {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

/** What the relay holds that the brief's body lacks: `{ kind: 'quote' | 'number', value }`, each once, in the relay's order. */
export function missing(brief, relay) {
  const mine = body(brief);
  const haystack = squeeze(straight(mine));
  const have = new Set(numbers(mine));
  const found = [];
  for (const value of new Set(quotes(relay))) if (!haystack.includes(value)) found.push({ kind: 'quote', value });
  for (const value of new Set(numbers(relay))) if (!have.has(value)) found.push({ kind: 'number', value });
  return found;
}

/** What the script prints and its exit code for the two files' paths: 0 carries, 1 misses, 2 cannot run. */
export function check(argv) {
  if (argv.length !== 2) return { code: 2, out: '', err: 'usage: bin/brief-check <brief> <relay>\n' };
  let brief;
  let relay;
  try {
    [brief, relay] = argv.map((path) => readFileSync(path, 'utf8'));
  } catch (error) {
    return { code: 2, out: '', err: `brief-check: cannot read ${error.path ?? 'a file'}: ${error.code ?? error.message}\n` };
  }
  const found = missing(brief, relay);
  if (!found.length) return { code: 0, out: 'brief-check: the brief carries every quote and number of the relay\n', err: '' };
  const lines = found.map(({ kind, value }) => (kind === 'quote' ? `missing quote: "${value}"` : `missing number: ${value}`));
  return { code: 1, out: `${lines.join('\n')}\n`, err: '' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out, err } = check(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}
