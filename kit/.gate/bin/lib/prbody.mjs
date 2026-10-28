// The lines a pull request body carries: Issue, Claim, Team, Session, Cost. One line each, at the start of a line.
//   node .gate/bin/lib/prbody.mjs --team <body file>   exit 0 when Team: names a team, 1 when it does not, 2 when unreadable
// Team gates at `verify` (verify-trusted), Issue and Claim at `tier` (claim.mjs check); Session and Cost only inform and
// no check reads them. The body is data: only these shapes are taken from it, nothing is run.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;

/** The distinct values of one key, in the order written. */
function values(body, key) {
  const out = [];
  for (const m of String(body ?? '').matchAll(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'gm'))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The one value of a key, or why there is none: missing, twice (two different values), shape. */
function one(body, key, shape) {
  const all = values(body, key);
  if (all.length === 0) return { ok: false, why: 'missing' };
  if (all.length > 1) return { ok: false, why: 'twice' };
  return shape(all[0]) ? { ok: true, value: all[0] } : { ok: false, why: 'shape', value: all[0] };
}

export function team(body) {
  const r = one(body, 'Team', (v) => v.length <= 64 && NAME.test(v));
  return r.ok ? { ok: true, value: r.value } : r;
}

export function issue(body) {
  const r = one(body, 'Issue', (v) => v === 'none' || /^#[1-9]\d*$/.test(v));
  if (!r.ok) return r;
  return r.value === 'none' ? { ok: true, kind: 'none' } : { ok: true, kind: 'number', number: Number(r.value.slice(1)) };
}

export function claim(body) {
  const r = one(body, 'Claim', (v) => /^[0-9a-f]{40}$/.test(v));
  return r.ok ? { ok: true, sha: r.value } : r;
}

/** Whether `name` is a team name as Team: and the claim subjects write it. */
export const isTeam = (name) => typeof name === 'string' && name.length <= 64 && NAME.test(name);

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, file] = process.argv.slice(2);
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    console.log('prbody: the pull request body could not be read');
    process.exit(2);
  }
  if (flag !== '--team') {
    console.log('usage: prbody.mjs --team <body file>');
    process.exit(2);
  }
  const t = team(body);
  if (t.ok) console.log(`prbody: Team: ${t.value}`);
  else {
    const why = { missing: 'there is no line', twice: 'two different lines', shape: `"${String(t.value ?? '').slice(0, 40)}" is not a team name` }[t.why];
    console.log(`prbody: the pull request body needs one line "Team: <name>" (letters, digits, . _ -, at most one "/"): ${why}`);
    process.exit(1);
  }
}
