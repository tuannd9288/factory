// The stub reviewer, for scratch repositories only: no model runs. It writes a result (see result.mjs) with one
// blocking finding per added line holding GATE-STUB-FINDING (review) or GATE-STUB-VERDICT (verdict), and judges no
// No-red claim, since only a reviewer can. On review, an added line holding GATE-STUB-RAISE <why> raises the change to
// tier 3: a marker anyone may write is safe, since a raise only sends the Human a change to read.
//   node scripts/lib/stub-reviewer.mjs <review|verdict> <base> <head>
import { execFileSync } from 'node:child_process';

const [job, base, head] = process.argv.slice(2);
const marker = job === 'verdict' ? 'GATE-STUB-VERDICT' : 'GATE-STUB-FINDING';
const added = (diff) => diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++ '));
const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', base, head], { encoding: 'utf8', maxBuffer: 64 << 20 });
const blocking = added(diff)
  .filter((l) => l.includes(marker))
  .slice(0, 5)
  .map((l, i) => ({ id: `stub-${i + 1}`, claim: l.slice(1).trim().slice(0, 160) }));
const raiseLine = job === 'review' ? added(diff).find((l) => l.includes('GATE-STUB-RAISE')) : undefined;
const why = raiseLine?.slice(raiseLine.indexOf('GATE-STUB-RAISE') + 'GATE-STUB-RAISE'.length).trim().slice(0, 500) || 'stub raise';
console.log(JSON.stringify({ reviewer: 'stub', job, base, head, blocking, noRed: 'unjudged', ...(raiseLine ? { raise: { tier: 3, why } } : {}) }));
