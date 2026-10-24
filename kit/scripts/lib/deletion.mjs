// The machine proof that a change only deletes unused code, for red-check (#17). Three checks, all needed:
//   1. the diff adds no source line (removing only a leading `export ` from a line adds none), and every line it removes
//      from a file that stays is that keyword or part of a removed run of whole top-level declarations of exports;
//   2. no tracked file at the head still names a removed file or a removed export;
//   3. knip, run at the base commit with the repository's own config, listed each removed file and export as unused.
//   node scripts/lib/deletion.mjs config <base>
//   node scripts/lib/deletion.mjs claims --base <rev> --sources <file> --out <claims.json>   checks 1 and 2
//   node scripts/lib/deletion.mjs listed --claims <claims.json> --report <knip.json> --exit <code> [--err <file>]   check 3
// Each prints "red-check: not a pure deletion: <check n>: <reason>" lines on failure and exits 1; exit 2 is a failure
// to run at all. Sources is the list of changed source paths (red-check sorts them with paths.mjs), one per line.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [mode, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const MAX_SHOWN = 5;
const fail = (lines) => {
  for (const line of lines.slice(0, MAX_SHOWN)) console.log(`red-check: not a pure deletion: ${line}`);
  if (lines.length > MAX_SHOWN) console.log(`red-check: not a pure deletion: ... and ${lines.length - MAX_SHOWN} more`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
const short = (text) => (text.trim().length > 120 ? `${text.trim().slice(0, 117)}...` : text.trim());

// The names knip 6.42.1 looks for, by default: https://knip.dev/overview/configuration#location
const CONFIG_FILES = ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc', 'knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js'];

if (mode === 'config') {
  const base = rest[0];
  const at = (path) => spawnSync('git', ['cat-file', '-e', `${base}:${path}`], { stdio: 'ignore' }).status === 0;
  let found = CONFIG_FILES.some(at);
  if (!found && at('package.json')) {
    try {
      found = 'knip' in JSON.parse(git('show', `${base}:package.json`));
    } catch {}
  }
  if (found) process.exit(0);
  fail([`knip has no config in this repository (none of ${CONFIG_FILES.join(', ')}, and no "knip" key in package.json, at the base), so no deletion can be proved unused`]);
}

// What an `export` line exports, as knip names it; null when the line cannot be read.
function exported(line) {
  const text = line.trim();
  if (!/^export(?![\w$])/.test(text)) return [];
  if (/^export\s+default(?![\w$])/.test(text)) return ['default'];
  let m = text.match(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const\s+enum|enum|const|let|var|type|interface|namespace|module)\s*([A-Za-z_$][\w$]*)/);
  if (m) return [m[1]];
  m = text.match(/^export\s+(?:type\s+)?\{([^}]*)\}/);
  if (m) {
    const names = m[1].split(',').map((part) => part.trim().replace(/^type\s+/, '')).filter(Boolean).map((part) => part.split(/\s+as\s+/).pop());
    return names.length ? names : null;
  }
  m = text.match(/^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/);
  return m ? [m[1]] : null;
}

// Walks removed lines with a rough strip of strings and comments (regex literals are not understood, so a surprise
// shows as an unbalanced hunk and fails closed). Returns each line's depth at its start, whether it began inside a
// block comment or template literal, and the stripped text; plus the final depth, the lowest depth, and the end state.
function scan(lines) {
  let depth = 0;
  let low = 0;
  let block = false;
  let template = false;
  const rows = lines.map((line) => {
    const row = { start: depth, inBlock: block, inTemplate: template, text: '' };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (block) {
        if (c === '*' && line[i + 1] === '/') (block = false), i++;
      } else if (template) {
        if (c === '\\') i++;
        else if (c === '`') template = false;
      } else if (c === '/' && line[i + 1] === '/') break;
      else if (c === '/' && line[i + 1] === '*') (block = true), i++;
      else if (c === '`') template = true;
      else if (c === '"' || c === "'") {
        for (i++; i < line.length && line[i] !== c; i++) if (line[i] === '\\') i++;
      } else {
        row.text += c;
        if ('{(['.includes(c)) depth++;
        else if ('})]'.includes(c)) low = Math.min(low, --depth);
      }
    }
    return row;
  });
  return { rows, depth, low, open: block || template };
}

// Why a block of removed lines (those no keyword-only edit paid for) is not whole top-level declarations of exports:
// null when it is, else the line to name. Every line at depth 0 must be an export declaration, a comment or a blank
// line; a line inside a declaration may be anything. Names of the exports declared go to `names`.
function wholeExports(lines, names) {
  const { rows, depth, low, open } = scan(lines);
  if (depth !== 0 || low < 0 || open) return lines[0];
  for (const [i, row] of rows.entries()) {
    const line = lines[i];
    const t = line.trim();
    if (row.start > 0 || row.inBlock || row.inTemplate || !t || t.startsWith('//') || t.startsWith('/*')) continue;
    const declared = exported(line);
    if (!declared?.length) return line;
    names.push(...declared);
  }
  return null;
}

// The removed and added lines of each hunk of one modified file.
function hunks(base, path) {
  const out = [];
  for (const line of git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', base, 'HEAD', '--', path).split('\n')) {
    if (line.startsWith('@@')) out.push({ minus: [], plus: [] });
    else if (out.length && line.startsWith('-')) out.at(-1).minus.push(line.slice(1));
    else if (out.length && line.startsWith('+')) out.at(-1).plus.push(line.slice(1));
  }
  return out;
}

// Tracked files of the head that hold a string; `whole` reads it as a whole word. Skips the file named by `except`.
function holders(needle, { whole = false, except = null } = {}) {
  const args = ['grep', '-l', '-F', ...(whole ? ['-w'] : []), '-e', needle, 'HEAD', '--', '.', ...(except ? [`:(exclude,literal)${except}`] : [])];
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status === 1) return [];
  if (r.status !== 0) {
    console.log(`red-check: could not search the head for ${JSON.stringify(needle)}: ${short(r.stderr || 'git grep failed')}`);
    process.exit(2);
  }
  return r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^HEAD:/, ''));
}

if (mode === 'claims') {
  const base = opt('--base');
  const paths = readFileSync(opt('--sources'), 'utf8').split('\n').filter(Boolean);
  const status = new Map();
  for (const entry of git('diff', '--name-status', '--no-renames', '-z', base, 'HEAD', '--').split('\0').reduce((acc, part, i, all) => (i % 2 === 0 && part ? [...acc, [part, all[i + 1]]] : acc), []))
    status.set(entry[1], entry[0]);

  const added = [];
  const files = [];
  const exports = [];
  const strays = [];
  let anyExport = false;
  for (const path of paths) {
    const kind = status.get(path);
    if (kind === 'D') {
      files.push(path);
    } else if (kind === 'A') {
      const first = git('show', `HEAD:${path}`).split('\n').find((l) => l.trim()) ?? '';
      added.push(`check 1: ${path} adds a source line: ${short(first)}`);
    } else if (kind === 'M') {
      for (const { minus, plus } of hunks(base, path)) {
        // An added line is allowed when it is a removed line less its leading `export `; each removed line pays for one.
        const unpaid = [...minus];
        const kept = [];
        for (const p of plus) {
          const i = unpaid.indexOf(`export ${p}`);
          if (i >= 0) {
            const names = exported(unpaid[i]);
            if (names?.length) kept.push(...names);
            else strays.push(`check 1: ${path} removes a line that is not part of an unused export: ${short(unpaid[i])}`);
            unpaid.splice(i, 1);
          } else added.push(`check 1: ${path} adds a source line: ${short(p)}`);
        }
        anyExport ||= minus.some((m) => /^export(?![\w$])/.test(m.trim()));
        const names = [];
        const stray = unpaid.length ? wholeExports(unpaid, names) : null;
        if (stray !== null) strays.push(`check 1: ${path} removes a line that is not part of an unused export: ${short(stray)}`);
        for (const [list, keyword] of [[kept, true], [names, false]])
          for (const name of list) {
            const known = exports.find((e) => e.file === path && e.name === name);
            if (known) known.keyword &&= keyword;
            else exports.push({ file: path, name, keyword });
          }
      }
    }
  }
  if (added.length) fail(added);
  if (!files.length && !anyExport) fail(['check 3: the change removes no file and no export, so knip has nothing to have listed']);
  if (strays.length) fail(strays);

  const named = [];
  for (const path of files) {
    for (const [needle, how] of [[path, ''], [basename(path), ` (as "${basename(path)}")`]]) {
      const hit = holders(needle)[0];
      if (hit) {
        named.push(`check 2: ${path} is still named in ${hit}${how}`);
        break;
      }
    }
  }
  for (const { file, name, keyword } of exports) {
    // Only a keyword-only removal leaves the declaration in its file, where the name stays; a whole removal must not.
    const hit = holders(name, { whole: true, except: keyword ? file : null })[0];
    if (hit) named.push(`check 2: ${name}, exported by ${file}, is still named in ${hit}`);
  }
  if (named.length) fail(named);
  writeFileSync(opt('--out'), JSON.stringify({ files, exports }));
  process.exit(0);
}

if (mode === 'listed') {
  const claims = JSON.parse(readFileSync(opt('--claims'), 'utf8'));
  const code = Number(opt('--exit'));
  let err = '';
  try {
    err = readFileSync(opt('--err') ?? '/dev/null', 'utf8').trim().split('\n')[0] ?? '';
  } catch {}
  if (code !== 0 && code !== 1) fail([`check 3: knip could not run (exit ${code})${err ? `: ${short(err)}` : ''}`]);
  // knip --reporter json: one line, { "issues": [{ "file", "files": [{ "name" }], "exports": [{ "name", ... }], "types": [...], ... }] };
  // an issue type's array is empty when the file has none of it. https://knip.dev/features/reporters#json
  const text = readFileSync(opt('--report'), 'utf8').trim();
  let issues;
  for (const candidate of [text, text.split('\n').filter(Boolean).at(-1) ?? '']) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed?.issues)) {
        issues = parsed.issues;
        break;
      }
    } catch {}
  }
  if (!issues) fail([`check 3: knip's JSON report could not be read${err ? ` (${short(err)})` : ''}`]);
  const items = (issue, key) => (Array.isArray(issue?.[key]) ? issue[key] : []);
  const missing = [];
  for (const path of claims.files)
    if (!issues.some((i) => i?.file === path && items(i, 'files').some((f) => f?.name === path))) missing.push(`check 3: knip did not list ${path} as unused at the base`);
  for (const { file, name } of claims.exports)
    if (!issues.some((i) => i?.file === file && ['exports', 'types'].some((key) => items(i, key).some((e) => e?.name === name))))
      missing.push(`check 3: knip did not list ${name} of ${file} as unused at the base`);
  if (missing.length) fail(missing);
  process.exit(0);
}

console.log('usage: deletion.mjs config <base> | claims --base <rev> --sources <file> --out <file> | listed --claims <file> --report <file> --exit <code>');
process.exit(2);
