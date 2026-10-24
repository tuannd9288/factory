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
// Only the JSON ones give a machine proof: a JS or TS config can import files the gate does not protect, and the
// "knip" key of package.json cannot be protected line by line (tier would see only the changed line).
const JSON_CONFIGS = ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc'];
const CODE_CONFIGS = ['knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js'];

if (mode === 'config') {
  const base = rest[0];
  const at = (path) => spawnSync('git', ['cat-file', '-e', `${base}:${path}`], { stdio: 'ignore' }).status === 0;
  if (JSON_CONFIGS.some(at)) process.exit(0);
  if (CODE_CONFIGS.some(at)) fail([`a JS or TS knip config can import files the gate does not protect, so no deletion can be proved unused`]);
  let inPackage = false;
  if (at('package.json')) {
    try {
      inPackage = 'knip' in JSON.parse(git('show', `${base}:package.json`));
    } catch {}
  }
  if (inPackage) fail(['the knip config is in package.json; move it to knip.json for a machine proof']);
  fail([`knip has no config in this repository (none of ${JSON_CONFIGS.join(', ')} at the base), so no deletion can be proved unused`]);
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

// Reads a whole file once, line by line, lexing strings, comments, template literals and regex literals. A `/` after an
// identifier, number, `)`, `]` or `}` divides; after anything else, or a keyword such as `return`, it starts a regex. A regex
// that does not close on its line cannot be told from a division: that line and every later one is `taint`, and nothing
// removed from a tainted row is trusted. Per line:
//   start     { depth, block, template } at the start of the line: bracket depth, inside a block comment or a template
//   code      the line with comments cut out and strings kept; exec the same with the text of quoted strings emptied
//   comma0    a comma at depth 0
//   badTail   code after a statement ended on the line: after a `}` returns depth to 0 only `;` may follow, after a `;` at
//             depth 0 nothing may, after a `)` or `]` only what continues a signature (`{`, `=>`, `:`) or `;` (a string or
//             template counts as code)
const KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
function scanFile(text) {
  let depth = 0;
  let block = false;
  let template = false;
  let value = false; // the last significant token ends a value, so a following `/` divides; otherwise it starts a regex
  let taint = null; // the first line with a regex that does not close on its line: from there on nothing is trusted
  return text.split('\n').map((line, index) => {
    const row = { start: { depth, block, template }, code: '', exec: '', comma0: false, badTail: false, taint: null };
    const events = [];
    let bare = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (block) {
        if (c === '*' && line[i + 1] === '/') (block = false), i++;
      } else if (template) {
        row.code += c;
        row.exec += c;
        if (c === '\\') (row.code += line[i + 1] ?? ''), (row.exec += line[i + 1] ?? ''), i++;
        else if (c === '`') {
          template = false;
          if (row.start.template && depth === 0) events.push({ pos: bare.length, kind: 'brace' });
        }
      } else if (c === '/' && line[i + 1] === '/') break;
      else if (c === '/' && line[i + 1] === '*') (block = true), i++;
      else if (c === '/' && !value) {
        // A regex literal: up to the closing `/` outside a [...] class, honouring `\`, then its flags.
        let j = i + 1;
        let inClass = false;
        while (j < line.length && (inClass || line[j] !== '/')) {
          if (line[j] === '\\') j++;
          else if (line[j] === '[') inClass = true;
          else if (line[j] === ']') inClass = false;
          j++;
        }
        if (j >= line.length) {
          taint ??= { n: index + 1, text: line };
          break;
        }
        while (/[A-Za-z]/.test(line[j + 1] ?? '')) j++;
        row.code += line.slice(i, j + 1);
        row.exec += 'R';
        bare += 'S';
        i = j;
        value = true;
      } else if (c === '`') (template = true), (value = true), (row.code += c), (row.exec += c), (bare += 'S');
      else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        row.code += line.slice(i, j + 1);
        row.exec += c + c;
        bare += 'S';
        i = j;
        value = true;
      } else if (/\s/.test(c)) {
        row.code += c;
        row.exec += c;
        bare += c;
      } else if (/[\w$]/.test(c)) {
        let j = i;
        while (j + 1 < line.length && /[\w$]/.test(line[j + 1])) j++;
        const word = line.slice(i, j + 1);
        row.code += word;
        row.exec += word;
        bare += word;
        value = !KEYWORDS.has(word);
        i = j;
      } else {
        row.code += c;
        row.exec += c;
        bare += c;
        value = c === ')' || c === ']' || c === '}';
        if ('{(['.includes(c)) depth++;
        else if ('})]'.includes(c)) {
          if (--depth === 0) events.push({ pos: bare.length, kind: c === '}' ? 'brace' : 'paren' });
        } else if (c === ';' && depth === 0) events.push({ pos: bare.length, kind: 'semi' });
        else if (c === ',' && depth === 0) row.comma0 = true;
      }
    }
    const allowed = { brace: /^\s*;?\s*$/, semi: /^\s*$/, paren: /^\s*(?:;?\s*$|=>|:|\{)/ };
    row.badTail = events.some((e) => !allowed[e.kind].test(bare.slice(e.pos)));
    row.end = { depth, block, template };
    row.taint = taint;
    return row;
  });
}

// A comment above a removed declaration that changes how the code is read or built is not removable by a machine.
const PRAGMA = /@jsx|@ts-|\/\/\/|eslint|prettier|@flow|istanbul|c8\b|webpack|@vite|__PURE__|@license|@preserve|@refresh|sourceMappingURL|v8 ignore|@vitest|@jest|@babel|#__/i;
// What may follow `export ` when only that keyword goes: a declaration, never `{ a }`, `default` or `* from`.
const DECLARATION = /^(?:declare\b|(?:async\s+)?function\b|(?:abstract\s+)?class\b|const\b|let\b|var\b|enum\b|interface\b|type\b)/;
const startsClean = (row) => row.start.depth === 0 && !row.start.block && !row.start.template;
const endsClean = (row) => row.end.depth === 0 && !row.end.block && !row.end.template;
const declaresVariables = (code) => /^export\s+(?:declare\s+)?(?:const|let|var)\b/.test(code.trim());

// Whether removing this export declaration (its rows joined, strings emptied) may drop code that runs when the module
// loads: true unless it is a function, a type, an interface, a declare form, a name list, a variable initialised by an
// arrow, a function or a literal, a class with no call in its head, no decorator, no static member and no computed key,
// or an enum with no call. Fails closed: whatever is not recognised may run code.
function matching(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ('{(['.includes(text[i])) depth++;
    else if ('})]'.includes(text[i]) && --depth === 0) return i;
  }
  return -1;
}
function isFunctionInit(init) {
  if (/^(?:async\s+)?function\b/.test(init)) return true;
  const rest = init.replace(/^async\s+(?=[(\w$])/, '');
  if (rest[0] === '(') {
    const close = matching(rest, 0);
    return close > 0 && /^\s*(?::[^=]*)?=>/.test(rest.slice(close + 1));
  }
  return /^[A-Za-z_$][\w$]*\s*=>/.test(rest);
}
function variableRuns(rest) {
  const name = rest.match(/^(?:const|let|var)\s+[A-Za-z_$][\w$]*/);
  if (!name) return true;
  let depth = 0;
  let eq = -1;
  for (let i = name[0].length; i < rest.length && eq < 0; i++) {
    const c = rest[i];
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === '=' && depth === 0 && rest[i + 1] !== '>' && rest[i + 1] !== '=' && !'=!<>'.includes(rest[i - 1])) eq = i;
  }
  if (eq < 0) return false;
  const init = rest.slice(eq + 1).replace(/;\s*$/, '').trim();
  if (isFunctionInit(init)) return false;
  if (/\(|\bnew\b|\$\{|\bawait\b|\byield\b|\bimport\b|\+\+|--|\bdelete\b|\.\.\.|<[A-Za-z>/]/.test(init) || /[\w$)\]]\s*`/.test(init)) return true;
  return init.replace(/=>|===|!==|==|!=|<=|>=/g, '').includes('=');
}
function classRuns(text) {
  const open = text.indexOf('{');
  if (open < 0 || text.slice(0, open).includes('(') || text.includes('@')) return true;
  let depth = 0;
  let own = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if ('{(['.includes(c)) {
      if (depth === 1 && c === '[') return true;
      depth++;
      own += ' ';
    } else if ('})]'.includes(c)) {
      depth--;
      own += ' ';
    } else if (depth === 1) own += c;
  }
  return /\bstatic\b/.test(own);
}
function runsAtLoad(text) {
  const t = text.trim();
  if (/^export\s+declare\b/.test(t)) return false;
  const rest = t.replace(/^export\s+/, '');
  if (/^(?:async\s+)?function\b/.test(rest) || /^(?:type|interface)\b/.test(rest)) return false;
  if (/^(?:const\s+)?enum\b/.test(rest)) return /\(|\bnew\b|\$\{/.test(rest.slice(Math.max(0, rest.indexOf('{'))));
  if (/^(?:const|let|var)\b/.test(rest)) return variableRuns(rest);
  if (/^(?:abstract\s+)?class\b/.test(rest)) return classRuns(rest);
  if (rest.startsWith('{')) return /\bfrom\b/.test(rest);
  return true;
}

// Why a run of removed base lines (consecutive, none paid for by a keyword-only edit) is not whole top-level declarations
// of exports: null when it is, else the line to name and, for a default export, its reason. Names go to `names`.
// The run starts and ends at depth 0 outside any comment or template. Each line that starts at depth 0 is blank, a comment,
// or an export declaration with nothing after it; comments are allowed only directly above a declaration of the run, and
// none holds a pragma. A run with no declaration is not one.
function wholeExports(rows, texts, names) {
  if (!startsClean(rows[0]) || !endsClean(rows.at(-1))) return { line: texts[0] };
  let pending = [];
  let declarations = 0;
  for (const [i, row] of rows.entries()) {
    if (row.taint) return { line: texts[i], why: `removes a line after one the gate cannot read (line ${row.taint.n}: ${short(row.taint.text)})` };
    if (row.start.depth < 0) return { line: texts[i] };
    if (row.start.depth > 0 || row.start.template) {
      if (row.badTail) return { line: texts[i] };
      continue;
    }
    const code = row.code.trim();
    if (!code) {
      if (texts[i].trim()) pending.push(texts[i]);
      continue;
    }
    const declared = /^export(?![\w$])/.test(code) ? exported(code) : null;
    if (!declared?.length || (declaresVariables(code) && row.comma0)) return { line: texts[i] };
    if (declared.includes('default')) return { line: texts[i], why: 'removes a default export, which can never be proved unused' };
    let last = i;
    while (last + 1 < rows.length && !(rows[last].end.depth === 0 && !rows[last].end.block && !rows[last].end.template)) last++;
    if (runsAtLoad(rows.slice(i, last + 1).map((r) => r.exec.trim()).join('\n')))
      return { message: `removes ${declared[0]}, whose initialisation may run code at load; a pure deletion cannot prove it` };
    if (row.badTail) return { line: texts[i] };
    const pragma = pending.find((c) => PRAGMA.test(c));
    if (pragma) return { line: pragma };
    pending = [];
    declarations++;
    names.push(...declared);
  }
  if (pending.length) return { line: pending[0] };
  return declarations ? null : { line: texts[0] };
}

// The hunks of one modified file, with the base line each starts at.
function hunks(base, path) {
  const out = [];
  for (const line of git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', base, 'HEAD', '--', path).split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? /);
    if (h) out.push({ start: Number(h[1]), minus: [], plus: [] });
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
  const claim = (file, name, keyword) => {
    const known = exports.find((e) => e.file === file && e.name === name);
    if (known) known.keyword &&= keyword;
    else exports.push({ file, name, keyword });
  };
  for (const path of paths) {
    const kind = status.get(path);
    if (kind === 'D') {
      files.push(path);
    } else if (kind === 'A') {
      const first = git('show', `HEAD:${path}`).split('\n').find((l) => l.trim()) ?? '';
      added.push(`check 1: ${path} adds a source line: ${short(first)}`);
    } else if (kind === 'M') {
      const rows = scanFile(git('show', `${base}:${path}`));
      const stray = (line, why = 'removes a line that is not part of an unused export') => strays.push(`check 1: ${path} ${why}: ${short(line)}`);
      for (const { start, minus, plus } of hunks(base, path)) {
        anyExport ||= minus.some((m) => /^export(?![\w$])/.test(m.trim()));
        // Each added line must be a removed line less its leading `export `, one to one and in order, and the rest
        // must start with a declaration; that removed line must itself start at depth 0 outside a comment and a template.
        const paid = new Set();
        let cursor = 0;
        for (const p of plus) {
          const j = DECLARATION.test(p) ? minus.indexOf(`export ${p}`, cursor) : -1;
          if (j < 0) {
            added.push(`check 1: ${path} adds a source line: ${short(p)}`);
            continue;
          }
          cursor = j + 1;
          paid.add(j);
          const names = exported(minus[j]);
          const row = rows[start - 1 + j];
          if (row?.taint) stray(minus[j], `removes a line after one the gate cannot read (line ${row.taint.n}: ${short(row.taint.text)})`);
          else if (!names?.length || !row || !startsClean(row) || (declaresVariables(row.code) && row.comma0)) stray(minus[j]);
          else for (const name of names) claim(path, name, true);
        }
        for (let j = 0; j < minus.length; j++) {
          if (paid.has(j)) continue;
          let k = j;
          while (k + 1 < minus.length && !paid.has(k + 1)) k++;
          const names = [];
          const bad = wholeExports(rows.slice(start - 1 + j, start + k), minus.slice(j, k + 1), names);
          if (bad?.message) strays.push(`check 1: ${path} ${bad.message}`);
          else if (bad) stray(bad.line, bad.why);
          else for (const name of names) claim(path, name, false);
          j = k;
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
    if (!issues.some((i) => i?.file === file && ['exports', 'types'].some((key) => items(i, key).some((e) => e?.name === name && !e.namespace))))
      missing.push(`check 3: knip did not list ${name} of ${file} as unused at the base`);
  if (missing.length) fail(missing);
  process.exit(0);
}

console.log('usage: deletion.mjs config <base> | claims --base <rev> --sources <file> --out <file> | listed --claims <file> --report <file> --exit <code>');
process.exit(2);
