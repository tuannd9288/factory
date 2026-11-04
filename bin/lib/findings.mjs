// The kinds of a reviewer's findings (#408): a reviewer seat names each finding's kind in its report, and the weekly digest lists
// every kind found on two or more merged pull requests of one repository, beside its enforcer issue. No model; no network (the
// digest passes in what GitHub says).

export const KIND_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';
export const KIND_MAX = 40;
const KIND = new RegExp(KIND_PATTERN);

/** Whether a string is a kind: kebab-case, at most KIND_MAX characters. The report schema asks for it; the digest reads only these. */
export const validKind = (k) => typeof k === 'string' && k.length <= KIND_MAX && KIND.test(k);

/** The findings of the reviewer records, one { repo, branch, kind } each. Every record counts, a resumed session's rounds
 * included, since a round's findings are its own (the cost, which is cumulative, is the one that counts by last record). A
 * record without `findings` (an older one) or without a repository and branch adds nothing, nor does a kind that is not valid. */
export function reviewerFindings(records) {
  const out = [];
  for (const r of records) {
    if (r.role !== 'reviewer' || !r.repo || !r.branch || !Array.isArray(r.structured?.findings)) continue;
    for (const f of r.structured.findings) if (validKind(f?.kind)) out.push({ repo: r.repo, branch: r.branch, kind: f.kind });
  }
  return out;
}

/** The kinds a repository's reviewers have used, the most found first, at most `max`. */
export function knownKinds(records, repo, max = 40) {
  const count = new Map();
  for (const f of reviewerFindings(records)) if (f.repo === repo) count.set(f.kind, (count.get(f.kind) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([kind]) => kind);
}

/** What a reviewer seat is told about kinds (bin/seat adds it to the session's system prompt). */
export function rolePrompt(kinds) {
  return [
    'Your report\'s `findings` lists each problem you found as { kind, claim, blocking }. `kind` is a short kebab-case slug for the sort of problem, not for this instance of it (for example subject-over-72 or edit-through-heredoc). When the same sort of problem has been found before, reuse its kind exactly.',
    kinds.length ? `Kinds already used in this repository: ${kinds.join(', ')}.` : 'No kind has been used in this repository yet.',
  ].join('\n');
}

/** Every kind that a reviewer found on two or more merged pull requests of one repository, with their numbers, to
 * { repo, kind, prs, enforcer }. mergedOf(repo, branch) is the number of the merged pull request from that branch, or null
 * (still open, closed, or none); it is asked only for a kind seen on two branches. enforcerOf(repo, kind) is { number, state }
 * of the issue whose body has the line `Kind: <kind>`, or null. A repository whose lookup throws gives one { repo, error } (the
 * error's first line) in place of its kinds, and the others are listed as usual. */
export function repeatedKinds(records, { mergedOf, enforcerOf }) {
  const branches = new Map();
  for (const f of reviewerFindings(records)) {
    const key = `${f.repo}\n${f.kind}`;
    branches.set(key, (branches.get(key) ?? new Set()).add(f.branch));
  }
  const out = [];
  const failed = new Map();
  for (const [key, set] of branches) {
    if (set.size < 2) continue;
    const [repo, kind] = key.split('\n');
    if (failed.has(repo)) continue;
    try {
      const prs = [...new Set([...set].map((b) => mergedOf(repo, b)).filter((p) => p !== null))].sort((a, b) => a - b);
      if (prs.length >= 2) out.push({ repo, kind, prs, enforcer: enforcerOf(repo, kind) });
    } catch (error) {
      failed.set(repo, String(error.stderr || error.message).trim().split('\n')[0]);
    }
  }
  return [...out.filter((f) => !failed.has(f.repo)), ...[...failed].map(([repo, error]) => ({ repo, error }))]
    .sort((a, b) => a.repo.localeCompare(b.repo) || (a.kind ?? '').localeCompare(b.kind ?? ''));
}

/** The kinds an issue body names, one for each line `Kind: <kind>`; the label and the kind may be wrapped in `*` or backticks. */
export const kindsOf = (body) => String(body ?? '').split(/\r?\n/).flatMap((line) => {
  const m = /^[ \t]*Kind:[ \t]*(\S+)[ \t]*$/.exec(line.replace(/[*`]/g, ''));
  return m && validKind(m[1]) ? [m[1]] : [];
});

/** kind -> { number, state } over issues { number, state, body }: an open issue before a closed one, then the lower number. */
export function enforcerIndex(issues) {
  const index = new Map();
  const better = (a, b) => (a.state === 'open') !== (b.state === 'open') ? a.state === 'open' : a.number < b.number;
  for (const i of issues) {
    for (const kind of kindsOf(i.body)) {
      const mine = { number: i.number, state: i.state };
      if (!index.has(kind) || better(mine, index.get(kind))) index.set(kind, mine);
    }
  }
  return index;
}

/** The digest's section: findings is repeatedKinds' list, or { error } when it could not be read. */
export function findingsSection(findings) {
  const head = ['## Findings seen on two merged pull requests', ''];
  if (findings.error) return [...head, `- ${findings.error}`];
  if (!findings.length) return [...head, '- None.'];
  if (findings.every((f) => f.error)) return [...head, `- The findings could not be read for any repository (${findings[0].error}).`];
  return [...head, ...findings.map((f) => f.error ? `- ${f.repo}: could not be read (${f.error})` : `- ${f.repo} \`${f.kind}\`: ${f.prs.map((n) => `#${n}`).join(', ')} — ${f.enforcer ? `enforcer #${f.enforcer.number} (${f.enforcer.state})` : 'no enforcer issue yet'}`)];
}
