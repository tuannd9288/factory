// The gate's risk score for Linear's Reviews (#379): one pull request comment, kept up to date, that carries a
// `linear:extension` block with the `riskScore` plugin (https://linear.app/docs/diffs). Linear reads it from GitHub;
// no Linear key and no Linear call are used. The tier is the gate's, never changed here.
//   node risk-score.mjs body --sha <40 hex> --tier <1|2|3>   the tier command's output on stdin; prints the comment
//   node risk-score.mjs find --login <login> [--body <text>] the comments (gh api --paginate --slurp) on stdin; prints the id of
//                                                            the gate's comment, then `same` when --body is what it holds; or
//                                                            nothing when there is none
// Levels: tier 1 is 1 (Low risk), tier 2 is 2 (Typical risk), tier 3 is 3 (High risk). Linear's level 4 (Very high risk) is not
// used: the gate has no fourth tier.
// The explanations are the reasons `tier` printed, cut to Linear's limits (1 to 8 strings, each 1 to 200 characters). A reason
// holds a changed path, which a pull request names, so it is untrusted text: control characters go, a long path is cut from its
// front, and `<`, `>` and `&` are written as \u escapes, which JSON reads back as they were and which keep `-->` out of the block.
// Text from the pull request's body, title, branch or comments is never an explanation, and the reviewer's own reason for a
// raise is not copied (it is a model's words about the pull request).
// Only a comment written by the job's own login counts as the gate's: a person's comment with the marker is ignored.
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- factory-gate:risk-score -->';
const LEVELS = { 1: 'Low', 2: 'Typical', 3: 'High' };
const SHOWN = 5;
const LIMIT = 200;

const clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

/** At most `room` characters, counted as code points and as UTF-16 units alike; a cut text loses its front (a path's end tells most). */
function fit(s, room) {
  if (Array.from(s).length <= room && s.length <= room) return s;
  let kept = Array.from(s).slice(-(room - 1));
  while (kept.join('').length > room - 1) kept = kept.slice(1);
  return `…${kept.join('')}`;
}

/** One reason of tier's output as an explanation: its path cut to fit, its closing parenthesis kept, no text from the diff. */
function explain(reason) {
  if (/^raised by the reviewer/.test(reason)) return 'raised by the reviewer';
  const key = /^(.*?) \(protected line: .*\)$/.exec(reason);
  const [, path, tail] = key ? [null, key[1], ' (protected line)'] : (/^(.*?)( \([^()]*\))$/.exec(reason) ?? [null, reason, '']);
  const room = Math.max(LIMIT - Math.max(tail.length, Array.from(tail).length), 2);
  const whole = `${fit(path, room)}${tail}`;
  return whole.length <= LIMIT ? whole : fit(`${path}${tail}`, LIMIT);
}

/** The explanations for the reasons that follow "tier N": 1 to 8 strings. */
export function explanations(reasons, tier) {
  const list = reasons.map(clean).filter(Boolean).map(explain).filter(Boolean);
  if (!list.length) return [tier === 1 ? 'No protected, load-bearing or dependency path is touched' : `The gate judged tier ${tier}`];
  if (list.length <= SHOWN + 1) return list;
  return [...list.slice(0, SHOWN), `and ${list.length - SHOWN} more`];
}

/** JSON for a comment: no `<`, `>` or `&` survives, so no `-->` can end the block, whatever a path holds. */
const json = (value) => JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The comment: the marker, one plain line, and the block. `out` is the output of `.gate/bin/tier`. */
export function body({ sha, tier, out }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('the head is not 40 hexadecimal characters');
  if (!LEVELS[tier]) throw new Error(`tier ${tier} has no level`);
  const reasons = String(out).split('\n').slice(1).filter((l) => /^\s+\S/.test(l));
  const block = { version: 1, plugins: [{ plugin: 'riskScore', sha, level: Number(tier), explanations: explanations(reasons, Number(tier)) }] };
  return `${MARKER}\nRisk for Linear's Reviews: tier ${tier} (${LEVELS[tier]}) at ${sha.slice(0, 7)}\n<!-- linear:extension ${json(block)} -->\n`;
}

/** The gate's own comment among `comments` (pages or a flat list), the first one if there are several. */
export function find(comments, login) {
  const all = comments.flat();
  return all.find((c) => c?.user?.login === login && typeof c.body === 'string' && c.body.startsWith(MARKER));
}

const same = (a, b) => a.replace(/\r\n/g, '\n').trimEnd() === b.replace(/\r\n/g, '\n').trimEnd();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (name) => rest[rest.indexOf(`--${name}`) + 1];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString('utf8');
  try {
    if (cmd === 'body') process.stdout.write(body({ sha: opt('sha'), tier: Number(opt('tier')), out: input }));
    else if (cmd === 'find') {
      const login = opt('login');
      if (!login) throw new Error('no login to tell the gate\'s comment by');
      const mine = find(JSON.parse(input), login);
      if (mine) process.stdout.write(`${mine.id}${opt('body') !== undefined && same(mine.body, opt('body')) ? ' same' : ''}\n`);
    } else throw new Error('usage: risk-score.mjs body --sha <sha> --tier <n> | find --login <login>');
  } catch (error) {
    console.log(`risk-score: ${error.message}`);
    process.exit(2);
  }
}
