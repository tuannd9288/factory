// The doctor: reads one repository the factory has taken in, prints one line per check, green or red, and changes
// nothing. The Human's login runs it (Colly runs it from the MacBook, as bin/onboard-owner), so its code is made to be
// reviewed as code that only reads:
//   - every gh call goes through `get`, which refuses all but `gh api <path>` with no flag, `gh variable list`,
//     `gh pr list` and `gh pr checks`, and any -X, --method, -f, -F, --field, --raw-field or --input; a query is in the path;
//   - it runs only from a commit on the first-parent line of origin/main, with no uncommitted, untracked or ignored
//     file under bin/ or kit/, as bin/onboard asks of its clone;
//   - it prints no token, secret or variable value: the variable GATE_REVIEWER is read to choose the gate's ruleset,
//     as onboard-owner does, and its value is used and never shown;
//   - each line names what it read, and the end lists every gh call that ran.
// The repository's files come from git objects of a bare clone in the system's temporary folder, removed at the end:
// nothing the repository holds runs. DOCTOR_CLONE_URL (an absolute local folder, for tests) replaces the clone's URL.
// See bin/onboard-doctor for the arguments. Exit 0 when every line is green, 1 when any is red, 2 on a refusal.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BYTES, MAX_LINES, carrierProblems, countLines, entryIn, sizeProblems, splitGate } from '../../kit/.gate/bin/lib/instructions.mjs';
import { current, gateState, gh, identify, left, wanted } from './owner.mjs';

const factory = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WIDTH = 120;
const REGULAR = ['100644', '100755'];
const WRITES = /^(-X|--method|-f|-F|--field|--raw-field|--input)/;
const NOT_A_WRITE = [['variable', 'list'], ['pr', 'list'], ['pr', 'checks']];
const LABEL = 12;

class Refusal extends Error {}

/** The one way this command calls gh: a read. Every call is remembered, for the list at the end. */
const calls = new Set();
function get(args) {
  const plain = args[0] === 'api' ? args.length === 2 && !args[1].startsWith('-') : NOT_A_WRITE.some(([a, b]) => args[0] === a && args[1] === b);
  if (!plain || args.some((a) => WRITES.test(a))) throw new Error(`the doctor only reads: refused gh ${args.join(' ')}`);
  calls.add(`gh ${args.join(' ')}`);
  return gh(args);
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status === null) throw new Error(`git did not finish (${r.error?.message ?? 'killed'})`);
  return r;
}

/** What stops the run before any gh call: this clone not at a commit main recorded, or not as that commit holds it. */
function factoryProblem() {
  const dirty = git(['-C', factory, 'status', '--porcelain', '--ignored', '--untracked-files=all', '--', 'bin', 'kit']);
  if (dirty.status !== 0) return `cannot read the factory clone ${factory}: ${dirty.stderr.trim()}`;
  if (dirty.stdout.split('\n').some((l) => l && !l.endsWith('.DS_Store'))) return 'the factory clone has changes no commit holds (bin/ and kit/); it runs only from a commit on main';
  const head = git(['-C', factory, 'rev-parse', 'HEAD']);
  const line = git(['-C', factory, 'rev-list', '--first-parent', 'refs/remotes/origin/main']);
  if (head.status !== 0 || line.status !== 0 || !line.stdout.split('\n').includes(head.stdout.trim()))
    return `the factory's commit ${head.stdout.trim().slice(0, 7)} is not on its origin/main (its first-parent line); it runs only from a commit on main`;
  return null;
}

/** Where the repository is cloned from: its URL on GitHub, through gh's own credential helper, unless DOCTOR_CLONE_URL
 * names a local folder as an absolute path. Anything else that variable holds is a refusal and not a fallback. */
function cloneSource(slug) {
  const given = process.env.DOCTOR_CLONE_URL;
  if (given === undefined || given === '') return { url: `https://github.com/${slug}.git`, options: ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] };
  let folder = false;
  try {
    folder = isAbsolute(given) && statSync(given).isDirectory();
  } catch {
    folder = false;
  }
  if (!folder) throw new Refusal(`DOCTOR_CLONE_URL must be an absolute path to a local folder, and is only for tests; it is ${JSON.stringify(given)}`);
  return { url: given, options: [] };
}

const entryOf = (clone, rev, path) => entryIn(clone, rev, path);
const regular = (entry) => Boolean(entry) && REGULAR.includes(entry.mode);
const reasons = (list) => list.join('; ');

/** One line: the mark, the label, the result, and in brackets what it read. The result gives way to the reads. */
function format(ok, label, result, reads) {
  const head = `${ok ? 'ok' : 'RED'}`.padEnd(4) + label.padEnd(LABEL) + ' ';
  const tail = `  [${reads}]`;
  const room = Math.max(10, WIDTH - head.length - tail.length);
  const text = result.length > room ? `${result.slice(0, room - 1)}…` : result;
  return head + text.padEnd(room) + tail;
}

function checkSettings(ctx) {
  const reads = 'rulesets, env, collaborator, vars';
  const { slug, agent, branch, kitLanded, reviewer } = ctx;
  const want = wanted({ kitLanded: true, branch, reviewer });
  const names = new Set([...want.rulesets.map((r) => r.name), ...want.drop]);
  const undone = left(slug, agent, current(slug, agent, names, get), want);
  const problems = [...(kitLanded ? [] : [`the kit is not on ${branch}`]), ...undone];
  return { ok: !problems.length, result: problems.length ? reasons(problems) : 'every ruleset, the reviewer environment and the agents\' access as the kit\'s gate wants', reads };
}

function checkGateBlock(ctx) {
  const reads = 'AGENTS.md, .gate/gate-section.md';
  const agents = entryOf(ctx.clone, ctx.rev, 'AGENTS.md');
  const section = entryOf(ctx.clone, ctx.rev, '.gate/gate-section.md');
  if (!regular(agents)) return { ok: false, result: 'AGENTS.md is missing or not a regular file', reads };
  if (!regular(section)) return { ok: false, result: '.gate/gate-section.md is missing or not a regular file', reads };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(agents.bytes);
  } catch {
    return { ok: false, result: 'AGENTS.md is not valid UTF-8', reads };
  }
  const found = splitGate(text);
  if (!found.ok) return { ok: false, result: `the Gate block of AGENTS.md is ${found.problem}`, reads };
  if (found.block !== section.bytes.toString('utf8')) return { ok: false, result: 'the Gate block of AGENTS.md is not .gate/gate-section.md byte for byte', reads };
  return { ok: true, result: 'AGENTS.md holds .gate/gate-section.md, byte for byte', reads };
}

function checkVerify(ctx) {
  const reads = 'pr list, pr checks';
  const merged = ctx.mergedPrs().filter((p) => p.mergeCommit?.oid === ctx.head).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))[0];
  if (!merged) return { ok: false, result: `no merged pull request has ${ctx.head.slice(0, 7)}, the head of ${ctx.branch}, as its merge commit`, reads };
  let checks;
  try {
    checks = get(['pr', 'checks', String(merged.number), '--repo', ctx.slug, '--json', 'name,state']);
  } catch (error) {
    // gh exits non-zero while a check fails or is pending, and still prints them.
    const out = String(error.stdout ?? '').trim();
    if (!out.startsWith('[')) throw error;
    checks = JSON.parse(out);
  }
  const verify = (checks ?? []).filter((c) => c.name === 'verify');
  if (!verify.length) return { ok: false, result: `pull request #${merged.number} has no check verify`, reads };
  const bad = verify.find((c) => c.state !== 'SUCCESS');
  if (bad) return { ok: false, result: `pull request #${merged.number}: verify is ${String(bad.state).toLowerCase()}`, reads };
  return { ok: true, result: `pull request #${merged.number} merged ${ctx.head.slice(0, 7)}; its verify is a success`, reads };
}

function checkClaude(ctx) {
  const reads = 'CLAUDE.md';
  const problems = carrierProblems(entryOf(ctx.clone, ctx.rev, 'CLAUDE.md'));
  return { ok: !problems.length, result: problems.length ? reasons(problems) : 'CLAUDE.md reaches AGENTS.md', reads };
}

function checkSize(ctx) {
  const reads = 'AGENTS.md';
  const agents = entryOf(ctx.clone, ctx.rev, 'AGENTS.md');
  if (!regular(agents)) return { ok: false, result: 'AGENTS.md is missing or not a regular file', reads };
  const shape = `${countLines(agents.bytes)} lines (at most ${MAX_LINES}), ${agents.bytes.length} bytes (at most ${MAX_BYTES})`;
  return { ok: !sizeProblems(agents.bytes).length, result: shape, reads };
}

function checkEvidence(ctx) {
  const reads = 'pr list, kit PR, kit-evidence';
  const kit = ctx.mergedPrs().filter((p) => p.headRefName?.startsWith('factory/kit') && p.mergeCommit?.oid).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))[0];
  if (!kit) return { ok: false, result: 'no merged pull request has a head branch starting factory/kit', reads };
  const oid = kit.mergeCommit.oid;
  const parents = git(['-C', ctx.clone, 'rev-list', '--parents', '-n', '1', oid]).stdout.trim().split(' ');
  if (parents.length !== 3) return { ok: false, result: `pull request #${kit.number}: ${oid.slice(0, 7)} is not a merge commit of a base and a head`, reads };
  const [, base, head] = parents;
  const commitFile = entryOf(ctx.clone, head, '.gate/kit-commit');
  const commit = regular(commitFile) ? /^([0-9a-f]{40})\n$/.exec(commitFile.bytes.toString('utf8'))?.[1] : undefined;
  if (!commit) return { ok: false, result: `pull request #${kit.number}: .gate/kit-commit at its head is not one factory commit`, reads };
  const r = spawnSync(join(factory, 'bin/kit-evidence'), ['--factory', factory, '--commit', commit, '--repo', ctx.clone, '--base', base, '--head', head, '--slug', ctx.slug, '--id', String(ctx.id)], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 300_000,
  });
  if (r.status === 0) return { ok: true, result: `pull request #${kit.number} carries the kit at factory ${commit.slice(0, 7)} (kit-evidence passes)`, reads };
  const failing = String(r.stdout ?? '').split('\n').filter((l) => /^(missing|differs|extra|left):/.test(l));
  const why = failing.length ? `${failing[0]}${failing.length > 1 ? ` (+${failing.length - 1})` : ''}` : `kit-evidence exit ${r.status ?? 'none'}: ${String(r.stderr ?? '').trim().split('\n')[0]}`;
  return { ok: false, result: `pull request #${kit.number} against factory ${commit.slice(0, 7)}: ${why}`, reads };
}

const CHECKS = [
  ['settings', checkSettings],
  ['gate-block', checkGateBlock],
  ['verify', checkVerify],
  ['claude-md', checkClaude],
  ['size', checkSize],
  ['kit-evidence', checkEvidence],
];

function main(argv) {
  const [slug] = argv;
  const i = argv.indexOf('--id');
  const id = i >= 0 ? argv[i + 1] : undefined;
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug ?? '') || !/^\d+$/.test(id ?? '') || argv.length !== 3) {
    console.error('usage: bin/onboard-doctor <owner/name> --id <repository id>');
    return 2;
  }
  const problem = factoryProblem();
  if (problem) {
    console.error(`onboard-doctor: ${problem}; nothing read`);
    return 2;
  }
  const agent = process.env.FACTORY_AGENT ?? 'tuan9288-agent';
  const who = identify('onboard-doctor', { slug, id, agent, read: get });
  if (who.refusal) {
    console.error(who.refusal);
    return 2;
  }
  const { login, repo } = who;
  const branch = repo.default_branch;
  const source = cloneSource(slug);
  const folder = mkdtempSync(join(tmpdir(), 'doctor-'));
  try {
    const clone = join(folder, 'repo.git');
    const cloned = git([...source.options, 'clone', '--quiet', '--bare', '--no-tags', source.url, clone]);
    if (cloned.status !== 0) throw new Refusal(`could not clone ${slug}: ${cloned.stderr.trim().split('\n')[0]}`);
    const rev = `refs/heads/${branch}`;
    const tip = git(['-C', clone, 'rev-parse', '--verify', rev]);
    if (tip.status !== 0) throw new Refusal(`the clone has no ${branch}, the default branch`);
    const head = tip.stdout.trim();
    const state = gateState(slug, branch, get);
    let merged;
    const ctx = {
      slug, id, agent, branch, clone, rev, head, ...state,
      mergedPrs: () => (merged ??= get(['pr', 'list', '--repo', slug, '--state', 'merged', '--base', branch, '--limit', '200', '--json', 'number,headRefName,mergeCommit,mergedAt']) ?? []),
    };
    console.log(`onboard-doctor: ${slug} (id ${repo.id}), ${branch} at ${head.slice(0, 7)}, read as ${login}, from factory ${git(['-C', factory, 'rev-parse', '--short', 'HEAD']).stdout.trim()}`);
    let red = 0;
    for (const [label, check] of CHECKS) {
      let r;
      try {
        r = check(ctx);
      } catch (error) {
        r = { ok: false, result: `could not read: ${String(error.stderr || error.message).trim().split('\n')[0]}`, reads: 'see the calls below' };
      }
      if (!r.ok) red += 1;
      console.log(format(r.ok, label, r.result, r.reads));
    }
    console.log(`onboard-doctor: ${red ? `${red} of ${CHECKS.length} red` : 'every check green'}; calls on ${login}'s gh login, every one a read:`);
    for (const c of calls) console.log(`  ${c}`);
    return red ? 1 : 0;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`onboard-doctor: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 2;
  }
}
