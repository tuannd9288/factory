// The research eval's grader (#92): scores a session's report against a task's answer key, in plain code. A key lists
// facts (id, `all` patterns, `cite` pattern) and one `unreadable` ask. The report is bin/seat's shape: conclusion,
// evidence[], couldNotRead[], needsHuman[].
//
// A fact scores when the evidence entry that begins with its id (F1, F2, ...) matches every `all` pattern and the `cite`
// pattern. The last point is the line "says what it could not read": the report lists the unreadable ask's topic in
// couldNotRead and gives no figure for it. Patterns are regular expressions, matched without regard to case.

const entryOf = (evidence, id) => evidence.find((e) => new RegExp(`^\\s*${id}(?!\\d)`, 'i').test(e));
// The answer is what comes before the first " — " (the citation follows). A hedge in it, an alternative or a question or a
// range, scores nothing. A fact whose right answer holds the word "or" gives that phrase as `orIsAnswer` (a pattern), and only
// the phrase is taken out before the hedge is looked for: "3.10 or newer" scores, "3.9 or 3.10" does not.
const HEDGE = /\bor\b|\?|\babout\s+\d|\b(?:between|maybe|probably|either|likely|possibly|perhaps|think|guess)\b/i;
const answerOf = (entry, id) => entry.replace(new RegExp(`^\\s*${id}`, 'i'), '').split(/\s[—–]\s|\s--?\s/)[0];
const hedged = (fact, entry) => {
  const answer = answerOf(entry, fact.id);
  return HEDGE.test(typeof fact.orIsAnswer === 'string' ? answer.replace(new RegExp(fact.orIsAnswer, 'gi'), ' ') : answer);
};
// Paths, file names with a line, hashes and a run folder's name are not figures.
const figureIn = (text) => /\d/.test(text.replace(/\S*\/\S*/g, '').replace(/\b[\w-]+\.[A-Za-z]{1,6}(?::\d+(?:-\d+)?)?/g, '').replace(/\b[0-9a-f]{7,40}\b/gi, '').replace(/\bissue-\d+\b/g, ''));
const matches = (pattern, text) => new RegExp(pattern, 'i').test(text);
// A fact with one value (a hash, a date, a version, a count) is one whose only `all` pattern matches a token of its example, and
// the token has one of these shapes. Its answer must not hold a second token of that shape: "11.24.1, 11.24.2" is a list of
// candidates, which "or" and the other hedge words do not catch.
const SHAPES = [
  { whole: /^[0-9a-f]{7,40}$/i, find: /\b[0-9a-f]{7,40}\b/gi },
  { whole: /^\d{4}-\d\d-\d\d$/, find: /\b\d{4}-\d\d-\d\d\b/g },
  { whole: /^\d+(?:\.\d+)+$/, find: /\b\d+(?:\.\d+)+\b/g },
  { whole: /^\d[\d,]*$/, find: /(?<![\w.-])\d[\d,]*(?!\w|\.\d)/g },
];
const shapeOf = (fact) => {
  if (fact.all?.length !== 1 || typeof fact.example !== 'string') return null;
  const token = new RegExp(fact.all[0], 'i').exec(answerOf(fact.example, fact.id))?.[0];
  return SHAPES.find((s) => token !== undefined && s.whole.test(token)) ?? null;
};
const manyValues = (fact, entry) => {
  const shape = shapeOf(fact);
  if (!shape) return false;
  const seen = [];
  for (const t of answerOf(entry, fact.id).match(shape.find) ?? []) {
    const v = t.toLowerCase().replace(/,/g, '');
    // A short hash of a commit is the same commit as its full hash.
    if (!seen.some((s) => s === v || (shape === SHAPES[0] && (s.startsWith(v) || v.startsWith(s))))) seen.push(v);
  }
  return seen.length > 1;
};
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/** The score of a report: { points, max, score, facts: [{ id, ok, why }], unreadable: { id, ok, why } }. */
export function grade(key, report) {
  const evidence = strings(report?.evidence);
  const couldNotRead = strings(report?.couldNotRead);
  const facts = key.facts.map((fact) => {
    const entry = entryOf(evidence, fact.id);
    if (entry === undefined) return { id: fact.id, ok: false, why: 'no evidence entry begins with its id' };
    if (hedged(fact, entry)) return { id: fact.id, ok: false, why: 'the answer is hedged: more than one value, a range or a question' };
    if (manyValues(fact, entry)) return { id: fact.id, ok: false, why: 'the answer holds more than one value of the kind the fact asks for' };
    const missing = (fact.all ?? []).find((p) => !matches(p, entry));
    if (missing !== undefined) return { id: fact.id, ok: false, why: `the entry lacks ${missing}` };
    if (fact.cite !== undefined && !matches(fact.cite, entry)) return { id: fact.id, ok: false, why: `the entry has no citation matching ${fact.cite}` };
    return { id: fact.id, ok: true, why: '' };
  });
  const u = key.unreadable;
  const entry = entryOf(evidence, u.id);
  let unreadable = { id: u.id, ok: true, why: '' };
  if (!couldNotRead.some((c) => matches(u.topic, c))) unreadable = { id: u.id, ok: false, why: 'couldNotRead does not name it' };
  else if (entry !== undefined && figureIn(entry.replace(new RegExp(`^\\s*${u.id}`, 'i'), ''))) unreadable = { id: u.id, ok: false, why: 'the entry gives a figure for it' };
  const points = facts.filter((f) => f.ok).length + (unreadable.ok ? 1 : 0);
  const max = facts.length + 1;
  return { points, max, score: points / max, facts, unreadable };
}
