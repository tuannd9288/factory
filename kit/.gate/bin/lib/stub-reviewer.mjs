// The stub reviewer, for scratch repositories only: no model runs. It writes a result (see result.mjs) with one
// blocking finding per added line holding the finding marker, and judges no No-red claim, since only a reviewer can. On
// review, an added line holding the raise marker and a reason raises the change to tier 3: a marker anyone may write is
// safe, since a raise only sends the Human a change to read.
// The markers (GATE, STUB and a word, joined by hyphens: FINDING, RAISE) are built from parts and never written out in this
// file, comments included: the stub reads the added lines of the change it judges, and a kit update that adds this file's
// lines would otherwise be blocked by the stub it carries.
//   node .gate/bin/lib/stub-reviewer.mjs review <base> <head>   (verdict reads review's result and calls no reviewer)
import { execFileSync } from 'node:child_process';

const [job, base, head] = process.argv.slice(2);
const marker = (word) => ['GATE', 'STUB', word].join('-');
const finding = marker('FINDING');
const raise = marker('RAISE');
const added = (diff) => diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++ '));
const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', base, head], { encoding: 'utf8', maxBuffer: 64 << 20 });
const blocking = added(diff)
  .filter((l) => l.includes(finding))
  .slice(0, 5)
  .map((l, i) => ({ id: `stub-${i + 1}`, claim: l.slice(1).trim().slice(0, 160) }));
const raiseLine = job === 'review' ? added(diff).find((l) => l.includes(raise)) : undefined;
const why = raiseLine?.slice(raiseLine.indexOf(raise) + raise.length).trim().slice(0, 500) || 'stub raise';
console.log(JSON.stringify({ reviewer: 'stub', job, base, head, blocking, noRed: 'unjudged', ...(raiseLine ? { raise: { tier: 3, why } } : {}) }));
