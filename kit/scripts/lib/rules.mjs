// The hand-in rules: seatwork's table (.gate/handin.json) read on the lines a change adds, plus the Failing-test guard.
// The matcher is ported from sting9k/seatwork at f5373411227c, plugin/server/safety/handin.ts; NOTICE says what was taken.
//   scripts/rules                 lines added since the merge-base with origin/main, committed or not
//   scripts/rules --base <rev>    lines added since <rev>
//   scripts/rules --staged        lines the index adds (the pre-commit hook)
// Exit 0 clean, 1 on a block finding, 2 when it could not run.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE = 1024 * 1024;
const ALLOW = /gate-allow ([a-z-]+): (.{20,})/;
const ASSERTION =
  /\b(expect|assert\w*|should|require\.\w+|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|XCTAssert\w*|assertThat|verify)\s*[(.]|^\s*assert\s/;
const SECRET_SHAPES =
  /(AKIA[0-9A-Z]{16}|\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const SECRET_NAME =
  /(secret|token|passw(or)?d|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)\w*["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i;
const PLACEHOLDER =
  /example|sample|dummy|placeholder|changeme|your[_-]|xxx|fake|test|<|\$\{|process\.env|os\.environ|getenv/i;
const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)/;

const fail = (why) => {
  console.log(`rules: could not run: ${why}`);
  process.exit(2);
};

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

const top = (() => {
  try {
    return git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    return fail('not inside a git work tree');
  }
})();
const tablePath = join(top, '.gate/handin.json');
if (!existsSync(tablePath)) fail('.gate/handin.json is missing');
const table = JSON.parse(readFileSync(tablePath, 'utf8'));

const RULES = table.rules.map((r) => ({ ...r, test: new RegExp(r.pattern, r.flags ?? ''), where: r.path ? new RegExp(r.path) : null }));
// The kit's proof fixtures are bad on purpose; the hand-in rules do not read them.
const SKIP = [...table.skip, '^\\.gate/proofs/'].map((p) => new RegExp(p));
const TESTS = table.tests.map((p) => new RegExp(p));
const CHECK_CONFIG = table.checkConfig.map((p) => new RegExp(p));
const CHECK_KEYS = new RegExp(table.checkKeys);
const EXTENSIONS = new Map(Object.entries(table.languages).flatMap(([lang, exts]) => exts.map((e) => [e, lang])));
const isTestPath = (path) => TESTS.some((p) => p.test(path));

function parseArgs(argv) {
  const out = { staged: false, base: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--staged') out.staged = true;
    else if (argv[i] === '--base') out.base = argv[++i];
    else fail(`unknown argument ${argv[i]}`);
  }
  return out;
}

function defaultBase() {
  for (const ref of ['origin/main', 'origin/HEAD', 'main']) {
    try {
      return git(['merge-base', 'HEAD', ref], { cwd: top }).trim();
    } catch {}
  }
  return fail('no merge-base with origin/main; pass --base <rev>');
}

/** The tracked files' added and removed lines out of a unified diff with no context lines. */
function parseDiff(diff) {
  const changes = new Map();
  let current = null;
  let inHunk = false;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const path = DIFF_HEADER.exec(raw)?.[2];
      current = path && !SKIP.some((p) => p.test(path)) ? { path, added: [], removed: [], deleted: false } : null;
      if (current) changes.set(current.path, current);
      inHunk = false;
    } else if (!current) continue;
    else if (raw.startsWith('@@')) {
      const hunk = HUNK_HEADER.exec(raw);
      if (hunk) line = Number(hunk[1]);
      inHunk = true;
    } else if (!inHunk) {
      if (raw.startsWith('deleted file mode')) current.deleted = true;
    } else if (raw.startsWith('+')) current.added.push([line++, raw.slice(1)]);
    else if (raw.startsWith('-')) current.removed.push(raw.slice(1));
  }
  return changes;
}

const DIFF_FLAGS = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--no-renames'];

function readWorkTree(path) {
  try {
    const file = join(top, path);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE) return '';
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readIndex(path) {
  try {
    return git(['show', `:${path}`], { cwd: top });
  } catch {
    return '';
  }
}

/** The changes to read: the index against HEAD, or the work tree (with new untracked files) against a base. */
function changesOf({ staged, base }) {
  if (staged) {
    const changes = parseDiff(git([...DIFF_FLAGS, '--cached'], { cwd: top }));
    for (const change of changes.values()) change.text = () => readIndex(change.path);
    return [...changes.values()];
  }
  const changes = parseDiff(git([...DIFF_FLAGS, base, '--'], { cwd: top }));
  for (const change of changes.values()) change.text = () => readWorkTree(change.path);
  const fresh = git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], { cwd: top })
    .split('\0')
    .filter((path) => path && !SKIP.some((p) => p.test(path)) && !changes.has(path));
  for (const path of fresh) {
    const text = readWorkTree(path);
    const lines = text.includes('\0') ? [] : text.replace(/\n$/, '').split('\n');
    changes.set(path, { path, added: lines.map((l, i) => [i + 1, l]), removed: [], deleted: false, text: () => text });
  }
  return [...changes.values()];
}

const CODE = 0;
const STRING = 1;
const COMMENT = 2;
const TRIPLES = ['"""', "'''"];

/** For each character of a file: code, string or comment, by the language's own rules. */
function maskOf(language, text) {
  const length = text.length;
  const out = new Uint8Array(length);
  const paint = (from, to, kind) => {
    out.fill(kind, from, Math.min(to, length));
    return to;
  };
  const hash = ['python', 'ruby', 'shell', 'php'].includes(language);
  const slash = ['javascript', 'go', 'rust', 'java', 'c', 'php'].includes(language);
  const triples = language === 'python' || language === 'java';
  const ticks = language === 'javascript' || language === 'go';
  let i = 0;
  while (i < length) {
    const c = text[i];
    if (c !== '#' && c !== '/' && c !== '"' && c !== "'" && c !== '`') {
      i += 1;
      continue;
    }
    if ((hash && c === '#' && (language !== 'shell' || i === 0 || /\s/.test(text[i - 1]))) || (slash && c === '/' && text[i + 1] === '/')) {
      const end = text.indexOf('\n', i);
      i = paint(i, end < 0 ? length : end, COMMENT);
      continue;
    }
    if (slash && c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = paint(i, end < 0 ? length : end + 2, COMMENT);
      continue;
    }
    const triple = triples ? TRIPLES.find((q) => text.startsWith(q, i)) : undefined;
    if (triple) {
      const end = text.indexOf(triple, i + 3);
      i = paint(i, end < 0 ? length : end + 3, STRING);
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && ticks)) {
      if (c === "'" && language === 'rust' && !/^'(\\.|[^\\'])'/.test(text.slice(i, i + 4))) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' && c !== '`' ? 2 : 1;
      i = paint(i, j + 1, STRING);
      continue;
    }
    i += 1;
  }
  return out;
}

/** The file's text with only its code, its strings or its comments kept and all else turned to spaces. */
function layerOf(text, mask, layer) {
  const kind = layer === 'code' ? CODE : layer === 'string' ? STRING : COMMENT;
  let out = '';
  for (let k = 0; k < text.length; k += 1) out += mask[k] === kind ? text[k] : ' ';
  return out;
}

function lineStarts(text) {
  const out = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) out.push(at + 1);
  return out;
}

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

function languageOf(path) {
  const ext = /\.[^./]+$/.exec(path)?.[0] ?? '';
  return EXTENSIONS.get(ext) ?? (/(^|\/)(Makefile|Dockerfile)$/.test(path) ? 'shell' : null);
}

/** What the rules for a file's language and kind find on its added lines, and the secrets in them. */
function lineFindings(change, text, language, isTest) {
  const path = change.path;
  const rules = RULES.filter(
    (rule) =>
      (rule.languages.includes('*') || (language !== null && rule.languages.includes(language))) &&
      !(rule.files === 'test' && !isTest) &&
      !(rule.files === 'source' && isTest) &&
      (rule.where === null || rule.where.test(path)),
  );
  const masked = language !== null && text.length > 0 && change.added.length > 0 && rules.some((r) => r.in !== 'line');
  const mask = masked ? maskOf(language, text) : null;
  const starts = mask ? lineStarts(text) : [];
  const layers = new Map();
  // The part of an added line a rule reads; a line the file no longer holds is all code.
  const viewOf = (part, number, added) => {
    const at = starts[number - 1];
    if (!mask || at === undefined) return part === 'code' ? added : '';
    let kept = layers.get(part);
    if (kept === undefined) layers.set(part, (kept = layerOf(text, mask, part)));
    return kept.slice(at, at + added.length);
  };
  const out = [];
  for (const [number, added] of change.added) {
    for (const rule of rules) {
      const view = rule.in === 'line' ? added : viewOf(rule.in, number, added);
      if (rule.test.test(view)) out.push({ rule: rule.id, level: rule.level, path, line: number, text: added, hint: rule.hint });
    }
    const secret = SECRET_SHAPES.exec(added) ?? SECRET_NAME.exec(added);
    const value = secret?.[secret.length - 1] ?? secret?.[0];
    if (secret && value && !PLACEHOLDER.test(value) && (SECRET_SHAPES.test(added) || entropy(value) >= 3.5))
      out.push({
        rule: 'hardcoded-secret',
        level: 'block',
        path,
        line: number,
        text: added.replace(value, '***'),
        hint: 'Read the secret from the environment or a secret manager.',
      });
  }
  return out;
}

/** A test file that lost more assertions than it gained. */
function assertionsDropped(change) {
  if (!change.removed.length) return [];
  const removed = change.removed.filter((l) => ASSERTION.test(l)).length;
  const added = change.added.filter(([, l]) => ASSERTION.test(l)).length;
  if (removed <= added) return [];
  return [
    {
      rule: 'assertions-removed',
      level: 'block',
      path: change.path,
      line: 0,
      text: `${removed} assertions removed, ${added} added`,
      hint: 'A test that checks less hides breakage; keep the assertions or acknowledge why they went.',
    },
  ];
}

/** A change to what decides the checks: a runner, lint or CI file, or the check lines of a manifest. */
function checkConfigFindings(change) {
  const hint = 'This decides what the checks run or how strict they are; say in the PR why it changed.';
  const at = (line, text) => [{ rule: 'check-config', level: 'warn', path: change.path, line, text, hint }];
  if (CHECK_CONFIG.some((p) => p.test(change.path))) return at(change.added[0]?.[0] ?? 0, change.path);
  if (!/(^|\/)(package\.json|pyproject\.toml)$/.test(change.path)) return [];
  const added = change.added.find(([, line]) => CHECK_KEYS.test(line));
  if (added) return at(added[0], added[1].trim());
  const removed = change.removed.find((line) => CHECK_KEYS.test(line));
  return removed ? at(0, removed.trim()) : [];
}

function inspect(change) {
  const isTest = isTestPath(change.path);
  if (change.deleted)
    return isTest
      ? [{ rule: 'test-deleted', level: 'block', path: change.path, line: 0, text: change.path, hint: 'A test file was deleted; restore it or acknowledge why.' }]
      : [];
  const text = change.text();
  if (text.includes('\0')) return [];
  const language = languageOf(change.path);
  const out = lineFindings(change, text, language, isTest);
  if (isTest && language) out.push(...assertionsDropped(change));
  out.push(...checkConfigFindings(change));
  return out;
}

/** The test lines each `Failing-test:` commit since the base added, that a later commit or the index no longer holds. */
function failingTestFindings(base, staged) {
  let shas;
  try {
    shas = git(['log', '--format=%H', '--grep=^Failing-test:', `${base}..HEAD`], { cwd: top }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const sha of shas) {
    const changes = parseDiff(git([...DIFF_FLAGS.slice(0, 2), 'show', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--no-renames', sha], { cwd: top }));
    for (const change of changes.values()) {
      if (!isTestPath(change.path)) continue;
      const now = staged ? readIndex(change.path) : readWorkTree(change.path);
      const held = new Set(now.split('\n').map((l) => l.trim()));
      const lost = change.added.filter(([, l]) => l.trim() && !held.has(l.trim()));
      if (lost.length)
        out.push({
          rule: 'failing-test-edited',
          level: 'block',
          path: change.path,
          line: lost[0][0],
          text: lost[0][1],
          hint: `${lost.length} line(s) the failing test of ${sha.slice(0, 8)} added are gone; a test committed red stays as written.`,
        });
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
let base = args.base;
let changes;
try {
  if (!args.staged && !base) base = defaultBase();
  changes = changesOf({ staged: args.staged, base });
} catch (error) {
  fail(String(error.stderr || error.message).trim().split('\n')[0]);
}
const findings = changes.flatMap(inspect);
findings.push(...failingTestFindings(base ?? defaultBase(), args.staged));

let blocking = 0;
let warnings = 0;
let allowed = 0;
for (const f of findings) {
  const ack = ALLOW.exec(f.text);
  const level = f.level === 'block' && ack && ack[1] === f.rule ? 'allowed' : f.level;
  if (level === 'block') blocking += 1;
  else if (level === 'warn') warnings += 1;
  else allowed += 1;
  const shown = f.text.trim().slice(0, 120);
  console.log(`${f.path}:${f.line}: ${f.rule} (${level}) ${f.hint}${shown ? `\n    ${shown}` : ''}`);
}
console.log(`rules: ${blocking} blocking, ${warnings} warnings, ${allowed} allowed, in ${changes.length} changed files`);
process.exit(blocking ? 1 : 0);
