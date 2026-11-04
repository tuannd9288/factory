// The opening of a kit pull request's body (#386): `## TL;DR for the Human`, five bullets in plain English, so the Human
// reads and approves a tier-3 pull request from that summary. The same five bullets as kit/.github/pull_request_template.md.
//
//   node bin/lib/tldr.mjs onboard <name> < evidence
//   node bin/lib/tldr.mjs kit-update <name> <added> <updated> <removed> <kept> < evidence
//
// The evidence is bin/kit-evidence's output on stdin: its `settings` block is the gate's settings, which the bullets name.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The gate's settings as the evidence lists them, in words without the file that holds each: one string, or '' if none. */
export function settingsOf(evidence) {
  const lines = evidence.split('\n');
  const at = lines.findIndex((l) => l.startsWith('settings ('));
  if (at < 0) return '';
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  ')) break;
    rows.push(l.trim().replace(/ \([^)]*\)(?=:)/, ''));
  }
  return rows.join('; ');
}

const section = (bullets) =>
  ['## TL;DR for the Human', ...Object.entries(bullets).map(([k, v]) => `- **${k}:** ${v}`)].join('\n');

export function onboardTldr(name, evidence) {
  const settings = settingsOf(evidence);
  return section({
    'What you will see': `${name} gets the factory's gate: its pull requests show automatic checks, and a change to the gate or its rules waits for your approval.`,
    'What changes': `The factory's kit comes into ${name}: the gate, its hooks, the pull request template and the rules for agents.${settings ? ` The gate's settings: ${settings}.` : ''}`,
    'What it fixes': `The factory can take ${name}'s work.`,
    Risk: 'Until this pull request merges, the check named verify shows red; that is expected and does not block the merge. To undo it, revert this pull request.',
    Recommendation: "Approve, once the settings above are what you want.",
  });
}

export function kitUpdateTldr(name, { added, updated, removed, kept }, evidence) {
  const settings = settingsOf(evidence);
  const files = (n) => `${n} ${n === 1 ? 'file' : 'files'}`;
  const touches = updated + removed;
  return section({
    'What you will see': `Nothing new on screen: ${name}'s gate keeps judging its pull requests, now with the newer kit.`,
    'What changes': `The kit in ${name} moves to a newer factory version: ${files(added)} added, ${updated} updated, ${removed} removed; ${files(kept)} of the repository's own stay as they were.${settings ? ` The gate's settings stay: ${settings}.` : ''}`,
    'What it fixes': `${name} catches up with the factory's current gate and rules.`,
    Risk: `${touches ? `It changes ${files(touches)} the repository already has: ${updated} replaced by the kit's newer version, ${removed} removed because the kit dropped them.` : 'It changes no file the repository already has.'} To undo it, revert this pull request.`,
    Recommendation: 'Approve: the evidence below shows the files are the kit at that factory version.',
  });
}

function main([verb, name, ...nums]) {
  const evidence = readFileSync(0, 'utf8');
  if (verb === 'onboard' && name) return console.log(onboardTldr(name, evidence));
  if (verb === 'kit-update' && name && nums.length === 4 && nums.every((n) => /^\d+$/.test(n))) {
    const [added, updated, removed, kept] = nums.map(Number);
    return console.log(kitUpdateTldr(name, { added, updated, removed, kept }, evidence));
  }
  console.log('usage: node bin/lib/tldr.mjs onboard <name> | kit-update <name> <added> <updated> <removed> <kept>   (evidence on stdin)');
  process.exitCode = 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
