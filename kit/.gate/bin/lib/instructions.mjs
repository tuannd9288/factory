// A repository's instruction files, read the same way by .gate/bin/verify (the working tree) and .gate/bin/verify-trusted
// (the candidate's git objects, before main's protected files are laid over it). The kit owns one marked block at the
// start of the root AGENTS.md, after an optional title line; the repository owns every byte after it.
//   node instructions.mjs worktree [dir]   the working tree's AGENTS.md, CLAUDE.md and the kit files the block names
//   node instructions.mjs objects --repo <dir> --base <rev> [--head <rev>]
//                                          a candidate commit's files as git objects, against its base and the factory's main
//   node instructions.mjs compose --section <file> --name <repo> [--agents <file>]   the AGENTS.md onboard writes, on stdout
//   node instructions.mjs carrier <path>   the problems with a CLAUDE.md
//   node instructions.mjs section <file>   the kit's gate-section.md is one well-formed block within the kit's budget
// Exit 0 fine, 1 on a problem, 2 when something cannot be read.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- factory:gate:begin -->';
export const END = '<!-- factory:gate:end -->';

function fail(problem, message) {
  return Object.assign(new Error(message), { problem });
}

const blank = (line) => /^\s*$/.test(line);

/** The head of a text: its title line (line 1, a level-1 heading) and the blank lines after it, or just the blank
 * lines at its start; only a line that ends in a newline counts. Returns how many lines it takes. */
function headLines(lines) {
  const whole = lines.length - 1;
  let n = whole > 0 && /^# \S/.test(lines[0]) ? 1 : 0;
  while (n < whole && blank(lines[n])) n += 1;
  return n;
}

/** Where the block is: { ok: true, head, block, tail } with head + block + tail the text, or { ok: false, problem }:
 * missing, malformed, duplicate or not-at-start. A marker is a whole line; a code fence does not hide one. */
export function splitGate(text) {
  const lines = String(text).split('\n');
  const begins = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (line === BEGIN) begins.push(i);
    if (line === END) ends.push(i);
  });
  if (!begins.length && !ends.length) return { ok: false, problem: 'missing' };
  if (begins.length > 1 || ends.length > 1) return { ok: false, problem: 'duplicate' };
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { ok: false, problem: 'malformed' };
  const [b] = begins;
  const [e] = ends;
  const before = lines.slice(0, b);
  if (b && headLines([...before, '']) !== before.length) return { ok: false, problem: 'not-at-start' };
  const head = b ? `${before.join('\n')}\n` : '';
  const block = lines.slice(b, e + 1).join('\n') + (e + 1 < lines.length ? '\n' : '');
  const tail = lines.slice(e + 1).join('\n');
  return { ok: true, head, block, tail };
}

/** The text with the kit's block in it: right after the head, a blank line between the head and the block, one after.
 * A text that already starts with exactly this block comes back unchanged. Throws, with .problem, on CRLF, on a block
 * that is not this one, and on any other marker line. */
export function insertGate(text, block) {
  if (text.includes('\r')) throw fail('crlf', 'the file has CRLF line ends; the block would mix them (convert them first)');
  if (text.startsWith('﻿')) throw fail('bom', 'the file starts with a byte-order mark; the block must come first, so take the mark out first');
  const found = splitGate(text);
  if (found.ok) {
    if (found.block === block) return text;
    throw fail('altered', 'the file has a Gate block that is not the kit\'s');
  }
  if (found.problem !== 'missing') throw fail(found.problem, `the file has Gate markers and they are ${found.problem}`);
  const lines = text.split('\n');
  const n = headLines(lines);
  const head = n ? `${lines.slice(0, n).join('\n')}\n` : '';
  const rest = lines.slice(n).join('\n');
  const separator = head && !blank(lines[n - 1]) ? '\n' : '';
  return head + separator + block + (rest === '' ? '' : '\n') + rest;
}

/** The text with its block replaced by `block`; the head and the tail are not touched. */
export function replaceGate(text, block) {
  const found = splitGate(text);
  if (!found.ok) throw fail(found.problem, `the file's Gate block is ${found.problem}`);
  return found.head + block + found.tail;
}

const REGULAR = ['100644', '100755'];

/** The problems with CLAUDE.md as an entry { mode, bytes } (null when missing): a regular file whose first line is
 * exactly @AGENTS.md, or a symlink whose one-line relative target is the root AGENTS.md, as ./ and nothing else. */
export function carrierProblems(entry) {
  if (!entry) return ['CLAUDE.md is missing: it must start with the line @AGENTS.md, or be a relative symlink to AGENTS.md'];
  if (REGULAR.includes(entry.mode)) {
    const first = entry.bytes.toString('utf8').split('\n')[0];
    return first === '@AGENTS.md' ? [] : ['the first line of CLAUDE.md must be exactly @AGENTS.md (prose may follow it); a file of only the text AGENTS.md is not an import'];
  }
  if (entry.mode !== '120000') return [`CLAUDE.md is not a file or a symlink (mode ${entry.mode})`];
  const target = entry.bytes.toString('utf8');
  if (target === '') return ['CLAUDE.md is a symlink with an empty target'];
  if (/[\n\0]/.test(target)) return ['CLAUDE.md is a symlink whose target is not one line'];
  if (target.startsWith('/')) return [`CLAUDE.md links to an absolute path (${target}); the link must be relative`];
  const parts = target.split('/').filter((p) => p !== '.');
  if (parts.includes('..')) return [`CLAUDE.md links to ${target}, which goes up with ..; the link must be AGENTS.md at the root, with no .. in it`];
  if (parts.length === 1 && parts[0] === 'CLAUDE.md') return ['CLAUDE.md links to itself (a cycle)'];
  if (parts.length !== 1 || parts[0] !== 'AGENTS.md' || target.endsWith('/')) return [`CLAUDE.md links to ${target}; it must link to AGENTS.md at the root`];
  return [];
}

export const MAX_LINES = 150;
export const MAX_BYTES = 32768;

/** Lines of a text, the last one counted whether or not a newline ends it. */
export function countLines(text) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  const newlines = s.split('\n').length - 1;
  return newlines + (s.length > 0 && !s.endsWith('\n') ? 1 : 0);
}

/** The problems with the size of the composed AGENTS.md (a string or bytes): at most MAX_LINES lines and MAX_BYTES
 * UTF-8 bytes. The numbers of both are in the message; the kit never shortens a file. */
export function sizeProblems(text) {
  const lines = countLines(text);
  const bytes = Buffer.isBuffer(text) ? text.length : Buffer.byteLength(String(text));
  if (lines <= MAX_LINES && bytes <= MAX_BYTES) return [];
  return [`AGENTS.md has ${lines} lines (at most ${MAX_LINES}) and ${bytes} bytes (at most ${MAX_BYTES}): the kit does not shorten it; the repository does`];
}

/** Every kit file the Gate block names. The check wants each one a regular file; it reads no link of the repository's. */
export const REQUIRED = [
  '.gate/bin/setup',
  '.gate/bin/verify',
  '.gate/bin/red-check',
  '.gate/bin/tier',
  '.gate/bin/claim',
  '.gate/enforced-rules.md',
  '.gate/gate-section.md',
  '.claude/skills/gate-red/SKILL.md',
];

/** The kit's canonical block, as .gate/gate-section.md holds it: one well-formed block and nothing else. With
 * { budget: true } (the factory's own check) it also fits what leaves a repository room: 26 lines, 3072 bytes. */
export function sectionProblems(text, { budget = false } = {}) {
  const found = splitGate(text);
  if (!found.ok) return [`the Gate block is ${found.problem}`];
  if (found.head !== '' || found.tail !== '') return ['the file holds text outside the Gate block'];
  if (budget && (countLines(text) > 26 || Buffer.byteLength(text) > 3072)) return [`the Gate block has ${countLines(text)} lines and ${Buffer.byteLength(text)} bytes; at most 26 and 3072, so a repository keeps room under 150 lines and 32 KiB`];
  return [];
}

const GATE_MESSAGES = {
  missing: 'AGENTS.md has no Gate block: it starts with the kit\'s block, between the lines <!-- factory:gate:begin --> and <!-- factory:gate:end -->',
  malformed: 'the Gate markers in AGENTS.md are malformed: one begin line and one end line, in that order',
  duplicate: 'AGENTS.md has more than one Gate marker line; it has one block',
  'not-at-start': 'the Gate block is not at the start of AGENTS.md: only a title line and blank lines may come before it',
};
const regular = (entry) => Boolean(entry) && REGULAR.includes(entry.mode);

/** Every problem with a tree's instruction files, from entries { mode, bytes } (null when missing): `agents`, `claude`,
 * `targets` (path -> entry, for REQUIRED) and `expected`, the block's bytes the AGENTS.md must hold, or null when none is
 * known (the problem is reported elsewhere). */
export function check({ agents, claude, targets, expected }) {
  const out = [];
  if (!agents) out.push('AGENTS.md is missing');
  else if (!regular(agents)) out.push(`AGENTS.md is not a regular file (mode ${agents.mode}); a link or a folder there is refused`);
  else {
    let text = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(agents.bytes);
    } catch {
      out.push('AGENTS.md is not valid UTF-8');
    }
    if (text !== null && text.startsWith('\uFEFF')) out.push('AGENTS.md starts with a byte-order mark; the block must come first, so take the mark out');
    else if (text !== null) {
      const found = splitGate(text);
      if (!found.ok) out.push(GATE_MESSAGES[found.problem]);
      else if (expected !== null && found.block !== expected) out.push('the Gate block of AGENTS.md is not .gate/gate-section.md: the kit owns that block, so change the kit\'s file, not this copy');
      out.push(...sizeProblems(agents.bytes));
    }
  }
  if (expected !== null) out.push(...sectionProblems(expected).map((p) => `.gate/gate-section.md: ${p}`));
  out.push(...carrierProblems(claude));
  for (const path of REQUIRED) if (!regular(targets[path])) out.push(`${path} is missing or not a regular file: the Gate block names it`);
  return out;
}

/** An entry { mode, bytes } for a path of a working tree, as git would hold it; null when there is none. */
function entryAt(root, path) {
  let st;
  try {
    st = lstatSync(join(root, path));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (st.isSymbolicLink()) return { mode: '120000', bytes: Buffer.from(readlinkSync(join(root, path))) };
  if (st.isDirectory()) return { mode: '040000', bytes: Buffer.alloc(0) };
  if (!st.isFile()) return { mode: '000000', bytes: Buffer.alloc(0) };
  return { mode: st.mode & 0o111 ? '100755' : '100644', bytes: readFileSync(join(root, path)) };
}

/** The problems with the instruction files of a working tree, the block judged against the tree's own
 * .gate/gate-section.md. Whether that copy is the kit's is for verify-trusted, which reads the candidate's objects. */
export function checkWorktree(root) {
  const section = entryAt(root, '.gate/gate-section.md');
  return check({
    agents: entryAt(root, 'AGENTS.md'),
    claude: entryAt(root, 'CLAUDE.md'),
    targets: Object.fromEntries(REQUIRED.map((path) => [path, entryAt(root, path)])),
    expected: regular(section) ? section.bytes.toString('utf8') : null,
  });
}

// --- The candidate of a pull request, as git objects --------------------------------------------------------------------
// verify-trusted lays main's AGENTS.md, CLAUDE.md and .gate/ files over the candidate before main's checks run, so those
// checks see main's bytes. This reads the candidate's own commit with ls-tree and cat-file, never its checkout.

/** The factory whose main vouches for a kit update. Only an environment main's workflow does not set changes it. */
export const FACTORY_URL = 'https://github.com/tuannd9288/factory.git';
const SECTION = '.gate/gate-section.md';
const KIT_COMMIT = '.gate/kit-commit';
const COMMIT_LINE = /^([0-9a-f]{40})\n$/;

function git(args, options = {}) {
  const r = spawnSync('git', args, { maxBuffer: 1 << 28, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options });
  if (r.error || r.status === null) throw new Error(`git did not finish (${r.error?.message ?? 'killed'})`);
  return r;
}

/** An entry { mode, bytes } for a path at a revision of a repository, from its objects; null when there is none. A
 * folder or a submodule has no bytes. */
export function entryIn(repo, rev, path) {
  const ls = git(['--literal-pathspecs', '-C', repo, 'ls-tree', '-z', rev, '--', path]);
  if (ls.status !== 0) throw new Error(`could not read ${path} at ${rev}: ${String(ls.stderr).trim()}`);
  // A tree can list one name twice (git fsck calls it duplicateEntries): ls-tree lists both, a checkout writes the last. Two
  // readers of one tree must not read two files, so a name listed twice is a problem and not a choice.
  const records = ls.stdout.toString('utf8').split('\0').filter(Boolean).filter((r) => r.split('\t')[1] === path);
  if (records.length > 1) throw Object.assign(new Error(`${path} has more than one entry in the tree of ${rev}; a checkout and this check would read two files`), { treeProblem: true });
  if (!records.length) return null;
  const [meta] = records[0].split('\t');
  const [mode, type, oid] = meta.split(' ');
  if (type !== 'blob') return { mode, bytes: Buffer.alloc(0) };
  const cat = git(['-C', repo, 'cat-file', 'blob', oid]);
  if (cat.status !== 0) throw new Error(`could not read ${path} at ${rev}: ${String(cat.stderr).trim()}`);
  return { mode, bytes: cat.stdout };
}

/** The factory's main, fetched into a throwaway bare repository: { dir, done }; throws when it cannot be fetched. */
function fetchFactory(url) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-factory-'));
  const done = () => rmSync(dir, { recursive: true, force: true });
  // git() throws when a run is killed (a timeout): the folder goes then too, not only when git exits non-zero.
  try {
    for (const args of [['init', '--bare', '-q', dir], ['-C', dir, 'fetch', '--quiet', '--no-tags', url, 'main:refs/heads/main']]) {
      const r = git(args);
      if (r.status !== 0) throw new Error(`could not fetch the factory's main from ${url}: ${String(r.stderr).trim().split('\n')[0]}`);
    }
  } catch (error) {
    done();
    throw error;
  }
  return { dir, done };
}

/** Where the factory's main is fetched from: the public factory, unless GATE_FACTORY_URL names a local folder, as an
 * absolute path. That variable is for tests. Anything else it holds (a URL, a file:// URL, a relative path, a path that is
 * no folder) is a problem and not a fallback; unset or empty is the public factory. */
function factoryLocation(env = process.env) {
  const given = env.GATE_FACTORY_URL;
  if (given === undefined || given === '') return { url: FACTORY_URL };
  let folder = false;
  try {
    folder = isAbsolute(given) && statSync(given).isDirectory();
  } catch {
    folder = false;
  }
  return folder ? { url: given } : { problem: `GATE_FACTORY_URL must be an absolute path to a local folder, and is only for tests; it is ${JSON.stringify(given)}` };
}

const isAncestor = (dir, older, newer) => git(['-C', dir, 'merge-base', '--is-ancestor', older, newer]).status === 0;

/** Whether a commit is on the first-parent line of the factory's main. A commit that main reaches only through a merge's
 * second parent (an intermediate commit of a pull request, rewritten before it merged) is not: only what main itself
 * recorded, one merge or commit at a time, vouches for a block. A walk that fails is "no". */
function onFirstParent(dir, key) {
  const r = git(['-C', dir, 'rev-list', '--first-parent', 'refs/heads/main']);
  return r.status === 0 && String(r.stdout).split('\n').includes(key);
}

/** The problems with a candidate commit's instruction files, judged against its base. An ordinary pull request leaves the
 * block, .gate/gate-section.md and .gate/kit-commit as the base has them. A kit update changes them, and the factory's
 * own main must vouch: the commit .gate/kit-commit names is on it, and its kit/.gate/gate-section.md is the candidate's
 * block and file. An update changes nothing else of AGENTS.md or CLAUDE.md. */
export function objectProblems(options) {
  try {
    return judgeObjects(options);
  } catch (error) {
    if (error.treeProblem) return [error.message];
    throw error;
  }
}

function judgeObjects({ repo, base, head = 'HEAD', location = factoryLocation() }) {
  const read = (rev) => ({ agents: entryIn(repo, rev, 'AGENTS.md'), claude: entryIn(repo, rev, 'CLAUDE.md'), section: entryIn(repo, rev, SECTION), commit: entryIn(repo, rev, KIT_COMMIT) });
  const b = read(base);
  const c = read(head);
  if (!regular(b.section)) return [`the base has no ${SECTION}, so this pull request's Gate block cannot be judged`];
  const targets = Object.fromEntries(REQUIRED.map((path) => [path, entryIn(repo, head, path)]));
  const text = (entry) => entry.bytes.toString('utf8');
  const same = (x, y) => (!x && !y) || Boolean(x && y && x.mode === y.mode && x.bytes.equals(y.bytes));
  const expectedByBase = text(b.section);
  const split = regular(c.agents) ? splitGate(text(c.agents)) : { ok: false };
  const block = split.ok ? split.block : null;
  if (same(c.section, b.section) && same(c.commit, b.commit) && (block === null || block === expectedByBase)) {
    return check({ agents: c.agents, claude: c.claude, targets, expected: expectedByBase });
  }
  const problems = [];
  const key = regular(c.commit) ? COMMIT_LINE.exec(text(c.commit))?.[1] : undefined;
  if (!key) problems.push(`${KIT_COMMIT} must be one full factory commit (40 lowercase hex characters) and a newline: this pull request changes the Gate block, its file or that commit`);
  else {
    let factory = null;
    if (location.problem) problems.push(`could not fetch the factory's main: ${location.problem}: a kit update cannot be judged`);
    else {
      try {
        factory = fetchFactory(location.url);
      } catch (error) {
        problems.push(`${error.message}: a kit update cannot be judged`);
      }
    }
    if (factory) {
      try {
        if (!onFirstParent(factory.dir, key)) problems.push(`${KIT_COMMIT} names ${key.slice(0, 7)}, which is not on the factory's main (its first-parent line)`);
        else {
          const vouched = git(['-C', factory.dir, 'cat-file', 'blob', `${key}:kit/${SECTION}`]);
          if (vouched.status !== 0) problems.push(`the factory commit ${key.slice(0, 7)} holds no kit/${SECTION}`);
          else if (!regular(c.section) || text(c.section) !== String(vouched.stdout) || block !== String(vouched.stdout)) {
            problems.push(`the Gate block and ${SECTION} are not the kit's at factory commit ${key.slice(0, 7)}: only the factory's own file can replace the base's block`);
          }
          const was = regular(b.commit) ? COMMIT_LINE.exec(text(b.commit))?.[1] : undefined;
          if (was && !isAncestor(factory.dir, was, key)) problems.push(`${KIT_COMMIT} goes back: ${key.slice(0, 7)} is older than the base's ${was.slice(0, 7)}`);
        }
      } finally {
        factory.done();
      }
    }
  }
  const was = regular(b.agents) ? splitGate(text(b.agents)) : { ok: false };
  if (!was.ok) problems.push(`the base's AGENTS.md has no valid Gate block (${was.problem ?? 'missing'}), so its tail cannot be compared`);
  else if (split.ok && (was.head !== split.head || was.tail !== split.tail)) {
    problems.push('a pull request that changes the Gate block leaves the head and the tail of AGENTS.md as the base has them (the tail is the repository\'s); they differ');
  }
  if (!same(c.claude, b.claude)) problems.push('a pull request that changes the Gate block leaves CLAUDE.md as the base has it; it differs');
  // The block is judged by the factory above; what check() adds is the rest: shape, size, carrier, targets.
  return [...problems, ...check({ agents: c.agents, claude: c.claude, targets, expected: null })];
}

/** The AGENTS.md bin/onboard writes: the repository's own text with the kit's block put in (or, with none, a title and
 * the block), within the limits. Throws, with .problem, when it cannot; nothing is cut or rewritten. */
export function composeAgents(text, section, name) {
  const out = text === null ? `# ${name}\n\n${section}` : insertGate(text, section);
  const size = sizeProblems(out);
  if (size.length) throw fail('size', size[0]);
  return out;
}

function main([command, ...rest]) {
  if (command === 'compose') {
    const option = (key) => (rest.includes(key) ? rest[rest.indexOf(key) + 1] : undefined);
    if (!option('--section') || !option('--name')) {
      console.log('usage: instructions.mjs compose --section <file> --name <repo name> [--agents <file>]');
      return 2;
    }
    try {
      const section = readFileSync(option('--section'), 'utf8');
      let text = null;
      if (option('--agents')) {
        const entry = entryAt(dirname(resolve(option('--agents'))), basename(option('--agents')));
        if (!regular(entry)) throw fail('not-a-file', `${option('--agents')} is not a regular file`);
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.bytes);
      }
      process.stdout.write(composeAgents(text, section, option('--name')));
      return 0;
    } catch (error) {
      // On stderr: the composed text is on stdout, and the caller keeps the two apart.
      console.error(error.problem ? error.message : `could not compose AGENTS.md: ${error.message}`);
      return 1;
    }
  }
  if (command === 'carrier' && rest.length === 1) {
    const problems = carrierProblems(entryAt(dirname(resolve(rest[0])), basename(rest[0])));
    for (const p of problems) console.log(p);
    return problems.length ? 1 : 0;
  }
  if (command === 'objects') {
    const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
    if (!option('--repo') || !option('--base')) {
      console.log('usage: instructions.mjs objects --repo <dir> --base <rev> [--head <rev>]');
      return 2;
    }
    let problems;
    try {
      problems = objectProblems({ repo: option('--repo'), base: option('--base'), head: option('--head') ?? 'HEAD' });
    } catch (error) {
      console.log(`instructions: ${error.message}`);
      return 2;
    }
    for (const p of problems) console.log(p);
    return problems.length ? 1 : 0;
  }
  if (command === 'worktree' && rest.length <= 1) {
    let problems;
    try {
      problems = checkWorktree(rest[0] ?? '.');
    } catch (error) {
      console.log(`instructions: ${error.message}`);
      return 2;
    }
    for (const p of problems) console.log(p);
    return problems.length ? 1 : 0;
  }
  if (command === 'section' && rest.length === 1) {
    let text;
    try {
      text = readFileSync(rest[0], 'utf8');
    } catch (error) {
      console.log(`instructions: could not read ${rest[0]}: ${error.code ?? error.message}`);
      return 2;
    }
    const problems = sectionProblems(text, { budget: true });
    for (const p of problems) console.log(`instructions: ${p}`);
    return problems.length ? 1 : 0;
  }
  console.log('usage: instructions.mjs worktree [dir] | objects ... | compose ... | carrier <path> | section <file>');
  return 2;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
