// The factory's 17 sublayers (#82), the one list the sublayer labels, the issue template and the check share. The codes
// and names are those of the map in AGENTS.md (test/sublayers-list.test.mjs fails when the two differ). A label is
// `sublayer-<code>` and its description is `<code> <name>`.
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
