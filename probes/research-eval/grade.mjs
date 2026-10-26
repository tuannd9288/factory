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
const HEDGE = /\bor\b|\?|\bbetween\b|\bmaybe\b|\bprobably\b|\beither\b/i;
const answerOf = (entry, id) => entry.replace(new RegExp(`^\\s*${id}`, 'i'), '').split(/\s[—–]\s|\s--?\s/)[0];
const hedged = (fact, entry) => {
  const answer = answerOf(entry, fact.id);
  return HEDGE.test(typeof fact.orIsAnswer === 'string' ? answer.replace(new RegExp(fact.orIsAnswer, 'gi'), ' ') : answer);
};
// Paths, file names with a line, hashes and a run folder's name are not figures.
const figureIn = (text) => /\d/.test(text.replace(/\S*\/\S*/g, '').replace(/\b[\w-]+\.[A-Za-z]{1,6}(?::\d+(?:-\d+)?)?/g, '').replace(/\b[0-9a-f]{7,40}\b/gi, '').replace(/\bissue-\d+\b/g, ''));
const matches = (pattern, text) => new RegExp(pattern, 'i').test(text);
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/** The score of a report: { points, max, score, facts: [{ id, ok, why }], unreadable: { id, ok, why } }. */
export function grade(key, report) {
  const evidence = strings(report?.evidence);
  const couldNotRead = strings(report?.couldNotRead);
  const facts = key.facts.map((fact) => {
    const entry = entryOf(evidence, fact.id);
    if (entry === undefined) return { id: fact.id, ok: false, why: 'no evidence entry begins with its id' };
    if (hedged(fact, entry)) return { id: fact.id, ok: false, why: 'the answer is hedged: more than one value, a range or a question' };
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
