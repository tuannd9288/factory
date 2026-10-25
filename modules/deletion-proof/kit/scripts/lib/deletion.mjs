// The deletion-proof module's machine proof (#71, step 1 of #17), laid only in a repository whose .gate/modules names it.
// red-check runs it for a source change with no test, from main's copy in CI. It reads no JavaScript. It passes a change
// whose only source change deletes whole files, when all three hold:
//   config  knip's config at the base is a JSON file of plain-data keys, and .gate/protected (at the base) names it, so a
//           tier-1 change cannot loosen what knip reports;
//   1       every changed source path is a deleted file, and no path anywhere changes type (a file becoming a link);
//   2       no tracked file at the head still names a deleted file, by its path or its basename;
//   3       knip 6.42.1, run at the base commit with that config after the repository's gate_prepare, listed each deleted
//           file as unused.
//   node scripts/lib/deletion.mjs prove --base <rev> --sources <file> --work <dir>   what red-check runs
//   node scripts/lib/deletion.mjs report --base <rev>   {"base","files":[...]}: what knip lists as unused at the base
// prove prints "red-check: not a pure deletion: <check>: <reason>" lines on a refusal and exits 1, or 2 when it could not
// run; report exits 4 when knip could not run. <file> lists the changed source paths, one per line (red-check sorts them
// with paths.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { globToRegex } from './policy.mjs';

const KNIP = 'knip@6.42.1';
const MAX_SHOWN = 5;
const short = (text) => (text.trim().length > 120 ? `${text.trim().slice(0, 117)}...` : text.trim());

/** A problem the proof reports: `exit` 1 is a refusal, 2 a failure to run. */
class Problem extends Error {
  constructor(lines, exit = 1) {
    super(lines.join('\n'));
    this.lines = lines;
    this.exit = exit;
  }
}

const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

/** Whether `path` exists in the tree of `rev`. A failure of git itself is not "absent" (#60): it stops the proof. */
function present(rev, path) {
  try {
    return git('ls-tree', '--name-only', rev, '--', path).trim() !== '';
  } catch (error) {
    throw new Problem([`red-check: could not read ${path} at the base: ${short(String(error.stderr || error.message))}`], 2);
  }
}

// The names knip 6.42.1 looks for, by default: https://knip.dev/overview/configuration#location
// Only the JSON ones give a machine proof: a JS or TS config can import files the gate does not protect, and the "knip" key
// of package.json cannot be protected line by line (tier would see only the changed line).
const JSON_CONFIGS = ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc'];
const CODE_CONFIGS = ['knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js'];

// The keys of a knip 6.42.1 JSON config that are plain data: globs, lists of names, rules (schema.json, and
// schema/configuration.js in the package). Every other key is refused: `preprocessor`, `preprocessorOptions`, `compilers`,
// `asyncCompilers` and each plugin's section (whose `config` is a tool's config file that may be JS or TS) name a file or a
// function knip loads and runs. A key not listed here is refused too, whatever it is.
const WORKSPACE_KEYS = new Set(['entry', 'project', 'paths', 'ignore', 'ignoreFiles', 'ignoreBinaries', 'ignoreGlobalBinaries', 'ignoreDependencies', 'ignoreMembers', 'ignoreUnresolved', 'ignoreExportsUsedInFile', 'ignoreIssues', 'includeEntryExports']);
const DATA_KEYS = new Set([...WORKSPACE_KEYS, '$schema', 'rules', 'cycles', 'ignoreWorkspaces', 'tags', 'include', 'exclude', 'treatConfigHintsAsErrors', 'treatTagHintsAsErrors', 'workspaces']);
const unknownKey = (value, allowed) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).find((k) => !allowed.has(k)) : undefined);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeKey = (config) => unknownKey(config, DATA_KEYS) ?? (isObject(config.workspaces) ? Object.values(config.workspaces).map((w) => unknownKey(w, WORKSPACE_KEYS)).find(Boolean) : undefined);

// JSONC to a value: comments and trailing commas out, strings kept.
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) < 0 ? text.length : text.indexOf('*/', i + 2) + 1;
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The paths .gate/protected names at `base`: its path patterns as regexes (its `key` lines guard lines, not paths). */
function protectedAt(base) {
  if (!present(base, '.gate/protected')) return [];
  return git('show', `${base}:.gate/protected`)
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('#') && !/^key\s/.test(l))
    .map((l) => globToRegex(l.split(/\s+/)[0]));
}

/** Throws a Problem unless knip's config at the base is one the gate can trust. */
function checkConfig(base) {
  const found = JSON_CONFIGS.filter((file) => present(base, file));
  const guarded = protectedAt(base);
  for (const file of found) {
    if (!guarded.some((re) => re.test(file))) throw new Problem([`config: ${file} is not in .gate/protected, so a tier-1 change could loosen what knip reports; propose adding it`]);
    let config;
    try {
      config = parseJsonc(git('show', `${base}:${file}`));
    } catch {
      throw new Problem([`config: ${file} could not be read as JSON, so no deletion can be proved unused`]);
    }
    if (!isObject(config)) throw new Problem([`config: ${file} is not a JSON object, so no deletion can be proved unused`]);
    const key = codeKey(config);
    if (key) throw new Problem([`config: ${file} holds the key "${key}": a knip config key can load code the gate does not protect`]);
  }
  if (found.length) return;
  if (CODE_CONFIGS.some((file) => present(base, file))) throw new Problem(['config: a JS or TS knip config can import files the gate does not protect, so no deletion can be proved unused']);
  let inPackage = false;
  if (present(base, 'package.json')) {
    try {
      inPackage = 'knip' in JSON.parse(git('show', `${base}:package.json`));
    } catch {}
  }
  if (inPackage) throw new Problem(['config: the knip config is in package.json; move it to knip.json for a machine proof']);
  throw new Problem([`config: knip has no config in this repository (none of ${JSON_CONFIGS.join(', ')} at the base), so no deletion can be proved unused`]);
}

/** Check 1: the deleted files among the changed sources; a Problem for any other change, or a change of type anywhere. */
function checkDeleted(base, sources) {
  const parts = git('diff', '--name-status', '--no-renames', '-z', base, 'HEAD', '--').split('\0');
  const status = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) status.set(parts[i + 1], parts[i]);
  const named = { A: 'added', M: 'modified' };
  const lines = [];
  for (const [path, kind] of status) if (kind === 'T') lines.push(`check 1: ${path} changes type, not deleted whole`);
  for (const path of sources) {
    const kind = status.get(path);
    if (kind !== 'D' && kind !== 'T') lines.push(`check 1: ${path} is ${named[kind] ?? 'changed'}, not deleted whole; only whole-file deletions get a machine proof`);
  }
  if (lines.length) throw new Problem(lines);
  const files = sources.filter((path) => status.get(path) === 'D');
  if (!files.length) throw new Problem(['check 3: the change deletes no file, so knip has nothing to have listed']);
  return files;
}

/** The first tracked file at the head that holds `needle`, or undefined; git failing is a Problem of exit 2. */
function holder(needle) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'grep', '-l', '-F', '-e', needle, 'HEAD', '--', '.'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status === 1) return undefined;
  if (r.status !== 0) throw new Problem([`red-check: could not search the head for ${JSON.stringify(needle)}: ${short(r.stderr || 'git grep failed')}`], 2);
  return r.stdout.split('\n').filter(Boolean)[0]?.replace(/^HEAD:/, '');
}

/** Check 2: a Problem for each deleted file a tracked file at the head still names. */
function checkNamed(files) {
  const lines = [];
  for (const path of files) {
    for (const [needle, how] of [[path, ''], [basename(path), ` (as "${basename(path)}")`]]) {
      const hit = holder(needle);
      if (hit) {
        lines.push(`check 2: ${path} is still named in ${hit}${how}`);
        break;
      }
    }
  }
  if (lines.length) throw new Problem(lines);
}

/** The files knip lists as unused at `base`, run in a detached worktree at `where` after the repository's gate_prepare. A
 * Problem (exit 1) says why it could not run. */
function knipFiles(base, where) {
  const top = git('rev-parse', '--show-toplevel').trim();
  git('worktree', 'add', '--detach', '--quiet', where, base);
  try {
    const prepared = spawnSync('bash', ['-c', '. .gate/config.sh && cd "$1" && gate_prepare "$1"', 'bash', where], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (prepared.status !== 0) {
      const last = `${prepared.stdout}${prepared.stderr}`.trim().split('\n').at(-1) ?? '';
      throw new Problem([`check 3: the base could not be prepared for knip${last ? `: ${last}` : ''}`]);
    }
    const knip = spawnSync('npx', ['--yes', KNIP, '--reporter', 'json'], { cwd: where, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = knip.status ?? 127;
    const err = (knip.stderr ?? '').trim().split('\n')[0] ?? '';
    if (code !== 0 && code !== 1) throw new Problem([`check 3: knip could not run (exit ${code})${err ? `: ${short(err)}` : ''}`]);
    // knip --reporter json: one line, { "issues": [{ "file", "files": [{ "name" }], ... }] }; an issue type's array is empty
    // when the file has none of it. https://knip.dev/features/reporters#json
    const out = (knip.stdout ?? '').trim();
    for (const candidate of [out, out.split('\n').filter(Boolean).at(-1) ?? '']) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed?.issues)) return new Set(parsed.issues.flatMap((i) => (Array.isArray(i?.files) ? i.files : []).map((f) => f?.name).filter((n) => typeof n === 'string' && n === i.file)));
      } catch {}
    }
    throw new Problem([`check 3: knip's JSON report could not be read${err ? ` (${short(err)})` : ''}`]);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', where], { stdio: 'ignore' });
  }
}

function resolveBase(rev) {
  try {
    return git('rev-parse', '--verify', `${rev}^{commit}`).trim();
  } catch {
    throw new Problem([`red-check: could not read the base ${rev}`], 2);
  }
}

function prove({ base: rev, sources, work }) {
  const base = resolveBase(rev);
  checkConfig(base);
  const files = checkDeleted(base, readFileSync(sources, 'utf8').split('\n').filter(Boolean));
  checkNamed(files);
  const listed = knipFiles(base, join(work, 'base'));
  const missing = files.filter((path) => !listed.has(path)).map((path) => `check 3: knip did not list ${path} as unused at the base`);
  if (missing.length) throw new Problem(missing);
  console.log('red-check: passed as a pure deletion: knip listed every deleted file at the base, and nothing names them');
}

function report({ base: rev }) {
  const base = resolveBase(rev);
  const dir = mkdtempSync(join(tmpdir(), 'deletion-proof-'));
  try {
    console.log(JSON.stringify({ base, files: [...knipFiles(base, join(dir, 'base'))].sort() }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [mode, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.flatMap((arg, i) => (arg.startsWith('--') ? [[arg.slice(2), rest[i + 1]]] : [])));
try {
  if (mode === 'prove' && opt.base && opt.sources && opt.work) prove(opt);
  else if (mode === 'report' && opt.base) report(opt);
  else {
    console.log('usage: deletion.mjs prove --base <rev> --sources <file> --work <dir> | report --base <rev>');
    process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof Problem)) throw error;
  if (mode === 'report') {
    for (const line of error.lines) console.log(`deletion-proof: ${line.replace(/^(red-check|check \d|config): /, '')}`);
    process.exitCode = 4;
  } else {
    for (const line of error.lines.slice(0, MAX_SHOWN)) console.log(line.startsWith('red-check:') ? line : `red-check: not a pure deletion: ${line}`);
    if (error.lines.length > MAX_SHOWN) console.log(`red-check: not a pure deletion: ... and ${error.lines.length - MAX_SHOWN} more`);
    process.exitCode = error.exit;
  }
}
