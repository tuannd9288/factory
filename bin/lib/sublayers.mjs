// The factory's 17 sublayers (#82), the one list the sublayer labels, the issue template and the check share. The codes
// and names are those of the map in AGENTS.md (test/sublayers-list.test.mjs fails when the two differ). A label is
// `sublayer-<code>` and its description is `<code> <name>`. Run as a script, it is bin/factory-sublayers, the check.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUBLAYERS = [
  ['0a', 'Environment'],
  ['0b', 'Tools & permissions'],
  ['0c', 'Model configuration'],
  ['0d', 'Harness & session'],
  ['1a', 'Issues'],
  ['1b', 'System of record'],
  ['1c', 'Orchestrator-workers'],
  ['1d', 'Monitoring'],
  ['1e', 'Surfaces'],
  ['2a', 'Context'],
  ['2b', 'Skills & plugins'],
  ['2c', 'Verification'],
  ['3a', 'Required status checks'],
  ['3b', 'Risk tiers'],
  ['3c', 'Merge & rollback'],
  ['4a', 'Observability & cost'],
  ['4b', 'Evals'],
].map(([code, name]) => ({ code, name, label: `sublayer-${code}`, description: `${code} ${name}` }));

/** The problems with a repository's labels: one line for each of the 17 that is missing or described otherwise. */
export function labelProblems(labels) {
  const byName = new Map(labels.map((l) => [l.name, l.description ?? '']));
  const out = [];
  for (const s of SUBLAYERS) {
    if (!byName.has(s.label)) out.push(`missing label: ${s.label} (${s.description})`);
    else if (byName.get(s.label) !== s.description) {
      out.push(`wrong description: ${s.label} has "${byName.get(s.label)}", want "${s.description}"`);
    }
  }
  return out;
}

/** One line for each sublayer-* label, in the repository or on an open issue, that is not one of the 17. */
export function strayProblems(labels, issues) {
  const listed = new Set(SUBLAYERS.map((s) => s.label));
  const names = [...labels, ...issues.flatMap((issue) => issue.labels)].map((l) => l.name);
  return [...new Set(names)].filter((n) => n.startsWith('sublayer-') && !listed.has(n)).sort().map((n) => `not on the list: ${n}`);
}

/** The problems with open issues: one line for each with none of the 17 labels, or with more than one. */
export function issueProblems(issues) {
  const listed = new Set(SUBLAYERS.map((s) => s.label));
  const out = [];
  for (const issue of issues) {
    const own = issue.labels.map((l) => l.name).filter((n) => listed.has(n));
    const head = `issue #${issue.number} (${issue.title})`;
    if (own.length === 0) out.push(`${head}: no sublayer label`);
    else if (own.length > 1) out.push(`${head}: ${own.length} sublayer labels (${own.join(', ')})`);
  }
  return out;
}

const ISSUE_LIMIT = 500;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const namedLabels = (v) => Array.isArray(v) && v.every((l) => isObject(l) && typeof l.name === 'string');

function gh(args, what, shape, valid) {
  const fail = (why) => new Error(`factory-sublayers: gh ${what} failed: ${why}`);
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw fail((r.error?.message ?? r.stderr ?? '').trim());
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw fail('its output is not JSON');
  }
  if (!valid(data)) throw fail(`its output is not a list of ${shape}`);
  return data;
}

/** The check: prints each problem and exits 1, prints one line and exits 0, or says gh failed and exits 2. */
export function main(argv) {
  let repo = 'tuannd9288/factory';
  if (argv.length === 2 && argv[0] === '--repo') repo = argv[1];
  else if (argv.length > 0) repo = '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    process.stderr.write('usage: factory-sublayers [--repo <owner/name>]\n');
    return 2;
  }
  let labels;
  let issues;
  try {
    labels = gh(['label', 'list', '-R', repo, '--limit', '200', '--json', 'name,description'], 'label list', 'labels', namedLabels);
    issues = gh(['issue', 'list', '-R', repo, '--state', 'open', '--limit', String(ISSUE_LIMIT), '--json', 'number,title,labels'],
      'issue list', 'issues', (v) => Array.isArray(v) && v.every((i) => isObject(i) && namedLabels(i.labels)));
    if (issues.length >= ISSUE_LIMIT) {
      throw new Error(`factory-sublayers: gh issue list returned ${issues.length} issues; the list may be cut at ${ISSUE_LIMIT}`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const problems = [...labelProblems(labels), ...issueProblems(issues), ...strayProblems(labels, issues)];
  if (problems.length) {
    process.stdout.write(`${problems.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`factory-sublayers: ${SUBLAYERS.length} labels and ${issues.length} open issues are in order\n`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
