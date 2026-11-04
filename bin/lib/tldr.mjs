// The opening of a kit pull request's body (#386): `## TL;DR for the Human`, seven bullets in plain English, so the Human
// reads and approves a tier-3 pull request from that one section. The same seven bullets as
// kit/.github/pull_request_template.md; a decision for him is numbered in the last bullet, each with a recommendation.
//
//   node bin/lib/tldr.mjs onboard <name> < evidence
//   node bin/lib/tldr.mjs kit-update <name> <added> <updated> <removed> <kept> < evidence
//
// The evidence is bin/kit-evidence's output on stdin: its `settings` block is the gate's settings, which the bullets name in
// plain words (bin/lib/gate-settings.mjs prints the rows); a row that carries `CHANGED` is a change the pull request makes,
// and each is a decision for him. The caller stops when the text is empty (a failed call prints nothing here).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isHosted } from './gate-settings.mjs';

const NAMES = {
  'the reviewer': 'the reviewer',
  "main's runner": "the machine that runs the main branch's jobs",
  "the candidate's runner": 'the machine that checks each change',
  'the trusted runner': "the machine that holds the reviewer's key",
};
const NO_REVIEWER = 'none (review and verdict fail closed)';
const VALUE = /^(\[[^\]]*\]|none \(review and verdict fail closed\)|[^,\s]+)(?:, (.*))?$/;

const REVIEWS = { claude: "Claude's review", entire: "Entire's review (a separate service)", stub: 'a test stand-in, not a real review' };

/** A setting's value as the evidence prints it, in words. */
function plain(words, value) {
  if (value === NO_REVIEWER) return 'no reviewer (nothing merges by itself)';
  if (words === 'the reviewer') return REVIEWS[value] ?? value;
  try {
    const labels = JSON.parse(value);
    if (labels.length === 1 && labels[0] === 'ubuntu-latest') return "GitHub's own machines";
    if (isHosted(labels)) return `GitHub's own machines (${labels[0]})`;
    return `your own machine labelled ${labels.join(', ')}`;
  } catch {
    return value;
  }
}

/** The gate's settings as the evidence lists them: [{ name, value, raw, changed, from }] in words, or [] if none. `raw` is the
 * value as printed; `from` is what a changed setting was, or '' when the base held it in a form the kit does not use. */
export function settingsOf(evidence) {
  const lines = evidence.split('\n');
  const at = lines.findIndex((l) => l.startsWith('settings ('));
  if (at < 0) return [];
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  ')) break;
    const m = l.trim().match(/^(.+?) \([^)]*\): (.*)$/);
    const v = m?.[2].match(VALUE);
    const words = m?.[1];
    if (!v) {
      rows.push({ name: NAMES[words] ?? l.trim(), value: '', raw: '', changed: false, from: '' });
      continue;
    }
    const row = { name: NAMES[words] ?? words, value: plain(words, v[1]), raw: v[1], changed: false, from: '' };
    if (v[2]?.startsWith('CHANGED')) {
      row.changed = true;
      const was = v[2].match(/^CHANGED from (.*)$/)?.[1].match(VALUE);
      row.from = was ? plain(words, was[1]) : '';
    }
    rows.push(row);
  }
  return rows;
}

const say = (r) => (r.value ? `${r.name}: ${r.value}` : r.name);
const moved = (r) => `${r.name} moves from ${r.from} to ${r.value}`;
const count = (n) => `${n} ${n === 1 ? 'setting' : 'settings'}`;

/** One decision for each changed setting, and one for all those whose old value the factory cannot see (the base held them
 * in a form the kit does not use, so it cannot say whether they changed). */
function settingDecisions(changed) {
  const unseen = changed.filter((r) => !r.from);
  return [
    ...changed.filter((r) => r.from).map((r) => `${moved(r)}. Recommendation: approve once ${r.value} is what you want for ${r.name}.`),
    ...(unseen.length
      ? [`These settings move from the repository's own settings into the gate's files, with the values the update was given: ${unseen.map(say).join('; ')}. The factory cannot see the old values, so it cannot say whether they changed. Recommendation: approve once these are the values the repository used, or the ones you want.`]
      : []),
  ];
}

const section = (bullets) =>
  ['## TL;DR for the Human', ...Object.entries(bullets).map(([k, v]) => `- **${k}:** ${v}`)].join('\n');

const numbered = (items) => (items.length ? items.map((s, i) => `${i + 1}. ${s}`).join(' ') : 'none');

const TIER = "Tier 3, so it waits for your approval. Before it was opened, the gate's full check passed and a separate program proved that the files are the kit at one factory version.";
const ONBOARD_TIER = `${TIER} The gate's own checks cannot run on this pull request until it merges, so no AI review runs on it.`;

/** The review clause follows the head's reviewer: none, a test stand-in, or a real review. */
function updateTier(rows) {
  const reviewer = rows.find((r) => r.name === NAMES['the reviewer'])?.raw;
  const clause = reviewer === undefined || reviewer === ''
    ? ''
    : reviewer === NO_REVIEWER
      ? ' No AI review runs until a reviewer is set.'
      : reviewer === 'stub'
        ? ' Only a test stand-in runs, not a real review.'
        : ' The independent AI review runs on this pull request.';
  return `${TIER} The automatic checks run on this pull request itself.${clause}`;
}

export function onboardTldr(name, evidence) {
  const rows = settingsOf(evidence);
  const settings = rows.map(say).join('; ');
  const changed = rows.filter((r) => r.changed);
  return section({
    'What you will see': `${name} gets the factory's gate: its pull requests show automatic checks, and a change to the gate or its rules waits for your approval.`,
    'What changes': `The factory's kit comes into ${name}: the gate, its hooks, the pull request template and the rules for agents.${settings ? ` The gate's settings: ${settings}.` : ''}`,
    'What it fixes': `The factory can take ${name}'s work.`,
    'Risk and how to undo': 'Until this pull request merges, the check named verify shows red; that is expected and does not block the merge. To undo it, revert this pull request.',
    Recommendation: `Approve, once the settings above are what you want and ${name}'s session has said which of its files are risky to change.`,
    'Tier and evidence': ONBOARD_TIER,
    'Decisions for you': numbered([
      `Which of ${name}'s files are risky to change: those that need an extra look, and those that need your approval? Recommendation: approve once ${name}'s session has said which files those are.`,
      ...settingDecisions(changed),
    ]),
  });
}

export function kitUpdateTldr(name, { added, updated, removed, kept }, evidence) {
  const rows = settingsOf(evidence);
  const changed = rows.filter((r) => r.changed);
  const stay = rows.filter((r) => !r.changed).map(say).join('; ');
  const files = (n) => `${n} ${n === 1 ? 'file' : 'files'}`;
  const touches = updated + removed;
  const moves = changed.filter((r) => r.from);
  const note = changed.length
    ? ` ${count(changed.length)} of the gate ${moves.length ? 'change' : "move into the gate's files"}, listed under Decisions for you.${stay ? ` These stay: ${stay}.` : ''}`
    : stay ? ` The gate's settings stay: ${stay}.` : '';
  return section({
    'What you will see': moves.length
      ? `${name}'s gate behaves differently: ${count(moves.length)} change, listed under Decisions for you. Its pull requests are otherwise judged as before, now with the newer kit.`
      : changed.length
        ? `${name}'s gate settings move into the gate's files, listed under Decisions for you. Its pull requests are judged as before, now with the newer kit.`
        : `Nothing new on screen: ${name}'s gate keeps judging its pull requests, now with the newer kit.`,
    'What changes': `The kit in ${name} moves to a newer factory version: ${files(added)} added, ${updated} updated, ${removed} removed; ${files(kept)} of the repository's own stay as they were.${note}`,
    'What it fixes': `${name} catches up with the factory's current gate and rules.`,
    'Risk and how to undo': `${touches ? `It changes ${files(touches)} the repository already has: ${updated} replaced by the kit's newer version, ${removed} removed because the kit dropped them.` : 'It changes no file the repository already has.'} To undo it, revert this pull request.`,
    Recommendation: changed.length
      ? 'Approve once the settings under Decisions for you are what you want; the evidence below shows the files are the kit at that factory version.'
      : 'Approve: the evidence below shows the files are the kit at that factory version.',
    'Tier and evidence': updateTier(rows),
    'Decisions for you': numbered(settingDecisions(changed)),
  });
}

function main([verb, name, ...nums]) {
  const evidence = readFileSync(0, 'utf8');
  if (verb === 'onboard' && name) return console.log(onboardTldr(name, evidence));
  if (verb === 'kit-update' && name && nums.length === 4 && nums.every((n) => /^\d+$/.test(n))) {
    const [added, updated, removed, kept] = nums.map(Number);
    return console.log(kitUpdateTldr(name, { added, updated, removed, kept }, evidence));
  }
  console.error('usage: node bin/lib/tldr.mjs onboard <name> | kit-update <name> <added> <updated> <removed> <kept>   (evidence on stdin)');
  process.exitCode = 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
