// The kit pull request's evidence: its files against the kit at one factory commit, over the whole inventory, with
// contents, modes and symlinks compared by git object, never by running anything the repository holds. It reads both
// sides with ls-tree and cat-file only. A managed file is one of five kinds: as in the kit (same mode, same blob);
// rendered (CODEOWNERS and AGENTS.md, which bin/onboard fills in, shown line by line, and .claude/settings.json, which
// it composes); kept (the repository had the path, and the pull request left its file as it was); updated (the base
// held a past blob of kit/<path>, or a past rendering of it, and the head holds the kit's now: only bin/kit-update's
// pull requests make one, and a file the kit dropped that the base held as a past blob is removed the same way);
// generated (.gate/kit-files, the sorted inventory, .gate/pack, the repository's choice of pack, and .gate/modules, its
// choice of modules). A module's files (bin/lib/module.mjs) are judged like the kit's but stricter: as in the module, or
// updated from a past blob of it, never kept as the repository's own; when the module is off they must be gone, and
// are removed only when the base held a past blob. A rendered path
// is the repository's own only when its base differs from the rendering at this factory commit (for AGENTS.md, with
// the own parts the base itself carries), so a base that already holds the kit's rendering is shown as rendered (#53). The pack is the one the head's .gate/pack
// names, read from packs/<name>/ in the factory commit: AGENTS.md is the kit's with the pack's section, then filled in
// (bin/lib/pack.mjs), and .claude/settings.json the kit's with the pack's keys. A missing or unknown pack fails the
// evidence, and the files built from it are not compared. Where the repository
// had its own AGENTS.md, CLAUDE.md or hook, the kit's file replaced it, and the evidence names the blob it had; the
// repository's own parts that --own put in AGENTS.md's last two sections are shown in full, every other line of it
// must be the kit's. A managed file that is none of these, one missing, or a path the pull request changes outside
// the inventory fails it. The result names the factory commit, the kit's tree, the repository's id, base and head, so
// it holds for those and nothing else. See bin/kit-evidence for the arguments.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LAYOUT, fill, parseOwn } from './own.mjs';
import { MODULES_FILE, mergedTree, parseModules } from './module.mjs';
import { NAME, PACK_FILE, composeAgents, composeSettings } from './pack.mjs';

export const INVENTORY = '.gate/kit-files';
export const SETTINGS = '.claude/settings.json';
export const FILLED = { '.github/CODEOWNERS': (v) => ['@OWNER', `@${v.human}`], 'AGENTS.md': (v) => ['<repo>', v.name] };
// What the kit replaces when the repository has its own (bin/onboard's REPLACE): its instructions and its hooks.
export const REPLACES = (path) => path === 'AGENTS.md' || path === 'CLAUDE.md' || path.startsWith('.githooks/');
const GIT_MS = 60_000;

export const git = (dir, args, encoding = 'utf8') => execFileSync('git', ['-C', dir, ...args], { encoding, maxBuffer: 64 << 20, timeout: GIT_MS });

/** Every entry of rev's tree under prefix, by path relative to it: { mode, oid }. */
export function tree(dir, rev, prefix = '') {
  const out = git(dir, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', rev, ...(prefix ? ['--', prefix] : [])]);
  const entries = new Map();
  for (const record of out.split('\0').filter(Boolean)) {
    const [meta, path] = record.split('\t');
    const [mode, , oid] = meta.split(' ');
    entries.set(prefix ? path.slice(prefix.length) : path, { mode, oid });
  }
  return entries;
}

/** What bin/onboard writes for a kit file it fills in: sed's s/from/to/, the first match on each line. */
export function render(path, text, { name, human }) {
  if (!FILLED[path]) return null;
  const [from, to] = FILLED[path]({ name, human });
  return text
    .split('\n')
    .map((line) => line.replace(from, () => to))
    .join('\n');
}

/** Whether text is the rendered kit file `to` with only its last two sections' bodies changed, the repository's own
 * parts from --own: ok, the line before which `to` and text agree, and each part's lines shown in full; or why not. */
function ownParts(path, to, text) {
  const kitLines = to.split('\n');
  const at = kitLines.indexOf(LAYOUT);
  const lines = text.split('\n');
  if (at < 0 || lines.slice(0, at).join('\n') !== kitLines.slice(0, at).join('\n')) return { ok: false };
  let own;
  try {
    own = parseOwn(lines.slice(at).join('\n'));
  } catch (error) {
    return { ok: false, why: `the repository's own parts: ${error.message}` };
  }
  const { text: want, layoutAt, factsAt } = fill(to, own);
  if (want !== text) return { ok: false };
  const shown = (from, body, name) => [
    `${path}:${from}${body.length > 1 ? `-${from + body.length - 1}` : ''}: the repository's own ${name} (${body.length} line${body.length > 1 ? 's' : ''}):`,
    ...body.map((l) => `  | ${l}`),
  ];
  return { ok: true, upTo: at, filled: [...shown(layoutAt, own.layout, 'Layout'), ...shown(factsAt, own.facts, 'Facts the code cannot tell')] };
}

/** The modules a tree's .gate/modules names: { names }, with a failure line in `why` when the file is not what onboard writes. */
function modulesIn(dir, files) {
  const file = files.get(MODULES_FILE);
  if (!file) return { names: [] };
  if (file.mode !== '100644') return { names: [], why: `differs: ${MODULES_FILE} (mode ${file.mode})` };
  const text = git(dir, ['cat-file', 'blob', file.oid]);
  try {
    if (text === '') throw new Error(`${MODULES_FILE}: empty; the file is absent when no module is on`);
    return { names: parseModules(text) };
  } catch (error) {
    return { names: [], why: `differs: ${error.message}` };
  }
}

/** The pack the head names, from the factory commit's tree: { name, pack } (pack null for `none`), or { why }. */
function packOf(factory, fac, repo, now) {
  const file = now.get(PACK_FILE);
  if (!file) return { why: `missing: ${PACK_FILE} (the repository names no pack)` };
  const text = git(repo, ['cat-file', 'blob', file.oid]);
  const name = text.trim();
  if (text !== `${name}\n`) return { why: `differs: ${PACK_FILE} (not a pack's name and a newline)` };
  if (name === 'none') return { name, pack: null };
  const names = [...tree(factory, fac, 'packs/').keys()].map((p) => p.split('/')[0]);
  const have = [...new Set(names)].sort();
  if (!NAME.test(name) || !have.includes(name)) return { why: `${PACK_FILE}: no pack ${name} in ${fac}/packs; there are: ${have.join(', ')}` };
  const blob = (file) => git(factory, ['cat-file', 'blob', `${fac}:packs/${name}/${file}`]);
  try {
    return { name, pack: { settings: blob('settings.json'), section: blob('AGENTS.md') } };
  } catch {
    return { why: `${PACK_FILE}: packs/${name}/ in ${fac.slice(0, 12)} lacks settings.json or AGENTS.md` };
  }
}

const pastCache = new Map();

/** Every blob the factory's history (from rev) held at exactly path: its blob after each commit that changed it. No
 * renames or copies are followed, so a blob that only ever lived at another path is not one of these; and the path is
 * literal, so a repository's file named `config?sh` does not glob onto the kit's `config.sh`. */
export function pastBlobs(factory, rev, path) {
  const key = `${factory}\0${rev}\0${path}`;
  if (!pastCache.has(key)) {
    const oids = new Set();
    for (const line of git(factory, ['--literal-pathspecs', 'log', '-m', '--raw', '--no-abbrev', '--format=', rev, '--', path]).split('\n')) {
      if (!line.startsWith(':')) continue;
      const after = line.slice(1).split('\t')[0].split(' ')[3];
      if (after && !/^0+$/.test(after)) oids.add(after);
    }
    pastCache.set(key, oids);
  }
  return pastCache.get(key);
}

/** The repository's own two sections out of an AGENTS.md: its text from the Layout line on, parsed with own.mjs. */
export function ownOf(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trimEnd() === LAYOUT);
  if (at < 0) throw new Error(`no section "${LAYOUT}"`);
  return parseOwn(lines.slice(at).join('\n'));
}

/** The pairs of kit file and pack file the factory had together: at this commit, then after each commit that changed
 * either. The pack's file is null before packs/<name>/ existed, and for the pack `none`. */
function renderStates(factory, fac, path, packName, packNow) {
  const file = path === 'AGENTS.md' ? 'AGENTS.md' : path === SETTINGS ? 'settings.json' : null;
  const packed = file && packName && packName !== 'none';
  const show = (rev, p) => {
    try {
      // The path is often absent from an older commit; git's own complaint about that is not output.
      return execFileSync('git', ['-C', factory, 'cat-file', 'blob', `${rev}:${p}`], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: GIT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const states = [{ kit: show(fac, `kit/${path}`), pack: packed ? packNow : null }];
  const paths = [`kit/${path}`, ...(packed ? [`packs/${packName}/${file}`] : [])];
  for (const rev of git(factory, ['--literal-pathspecs', 'log', '--format=%H', fac, '--', ...paths]).split('\n').filter(Boolean)) {
    const kit = show(rev, `kit/${path}`);
    if (kit !== null) states.push({ kit, pack: packed ? show(rev, `packs/${packName}/${file}`) : null });
  }
  return states;
}

/** Whether text is the rendering of a rendered kit file (CODEOWNERS, AGENTS.md with the repository's own parts it
 * carries, .claude/settings.json) at this factory commit ('now'), or what an older kit and its pack, as they stood
 * together at one factory commit, rendered ('past'), or neither (null). */
export function renderedAs({ factory, fac, path, text, name, human, pack, packName }) {
  const agents = path === 'AGENTS.md';
  const matches = ({ kit, pack: section }) => {
    try {
      if (path === SETTINGS) return composeSettings(kit, section) === text;
      const to = render(path, agents ? composeAgents(kit, section) : kit, { name, human });
      return text === to || (agents && ownParts(path, to, text).ok);
    } catch {
      return false;
    }
  };
  const [now, ...before] = renderStates(factory, fac, path, packName, path === SETTINGS ? pack?.settings ?? null : pack?.section ?? null);
  if (matches(now)) return 'now';
  return before.some(matches) ? 'past' : null;
}

export function evidence({ factory, commit, repo, base, head, slug, id, human }) {
  const name = slug.split('/')[1];
  const fac = git(factory, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const kitTree = git(factory, ['rev-parse', `${fac}:kit`]).trim();
  const headSha = git(repo, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const baseSha = git(repo, ['merge-base', base, headSha]).trim();
  const at = tree(repo, baseSha);
  const now = tree(repo, headSha);
  const blob = (dir, oid) => git(dir, ['cat-file', 'blob', oid]);
  const fails = [];
  const chosenModules = modulesIn(repo, now);
  if (chosenModules.why) fails.push(chosenModules.why);
  let names = chosenModules.names;
  let kit;
  try {
    kit = mergedTree(factory, fac, names);
  } catch (error) {
    fails.push(`${MODULES_FILE}: ${error.message}`);
    names = [];
    kit = mergedTree(factory, fac, []);
  }
  // The modules the base had on and the head does not: their files must be gone.
  const baseNames = modulesIn(repo, at).names;
  let off = new Map();
  try {
    off = new Map([...mergedTree(factory, fac, baseNames.filter((n) => !names.includes(n)))].filter(([, e]) => e.module));
  } catch {}
  for (const [path, e] of off) if (now.has(path)) fails.push(`left: ${path} (module ${e.module} is off, so its files go)`);
  const chosen = packOf(factory, fac, repo, now);
  if (chosen.why) fails.push(chosen.why);
  const rendered = [];
  const filled = new Set();
  const kept = [];
  const replaced = [];
  const updated = [];
  const removed = [];
  const was = (path, oid, why) => `${path} (was ${oid.slice(0, 12)}, ${why} at factory ${fac.slice(0, 7)})`;
  let exact = 0;
  for (const [path, want] of [...kit].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = now.get(path);
    const had = at.get(path);
    if (want.module) {
      // Stricter than a kit file: the module's, or updated from a past blob of it; never the repository's own.
      const asIs = (e) => e && e.mode === want.mode && e.oid === want.oid;
      if (!have) fails.push(`missing: ${path}`);
      else if (!asIs(have)) fails.push(`differs: ${path} (${have.mode !== want.mode ? `mode ${have.mode}, the module's ${want.mode}` : 'content'}, module ${want.module})`);
      else if (had && !asIs(had) && !pastBlobs(factory, fac, want.src).has(had.oid)) fails.push(`differs: ${path} (the repository's own, at a path module ${want.module} lays)`);
      else if (had && !asIs(had)) updated.push(was(path, had.oid, `module ${want.module}`));
      else exact++;
      continue;
    }
    let own = had && (had.mode !== want.mode || had.oid !== want.oid);
    let older = false;
    let as = null;
    // A path the kit renders never equals its raw blob, and a raw blob is not its rendering when a pack adds to it: the
    // base is the repository's own unless it is the rendering now, or one an older kit and pack made together.
    if (had && (FILLED[path] || path === SETTINGS) && !chosen.why && had.mode === want.mode) {
      as = renderedAs({ factory, fac, path, text: blob(repo, had.oid), name, human, pack: chosen.pack, packName: chosen.name });
      own = as !== 'now';
      older = as === 'past';
    }
    const same = own && have && have.mode === had.mode && have.oid === had.oid;
    // A file as an older kit had it, not the repository's own, when the pull request brings it to the kit's.
    if (own && !same && !older && !FILLED[path] && path !== SETTINGS) older = pastBlobs(factory, fac, want.src).has(had.oid);
    if (!have) fails.push(`missing: ${path}`);
    else if (same && REPLACES(path)) fails.push(`differs: ${path} (the repository's own, which the kit replaces)`);
    else if (same) kept.push(path);
    else if (own && !REPLACES(path) && !older) fails.push(`differs: ${path} (the repository's own, changed)`);
    else if (have.mode !== want.mode) fails.push(`differs: ${path} (mode ${have.mode}, the kit's ${want.mode})`);
    else if (path === SETTINGS || (path === 'AGENTS.md' && chosen.why)) {
      // Built from the kit and the pack; with no pack to build from, the failure above says why and nothing is compared.
      if (!chosen.why && blob(repo, have.oid) !== composeSettings(blob(factory, want.oid), chosen.pack?.settings ?? null)) fails.push(`differs: ${path} (content)`);
      else if (!chosen.why) {
        filled.add(path);
        if (own && older) updated.push(was(path, had.oid, 'kit'));
      }
    } else if (!FILLED[path] && have.oid !== want.oid) fails.push(`differs: ${path} (content)`);
    else if (!FILLED[path]) {
      exact++;
      if (own && older) updated.push(was(path, had.oid, 'kit'));
      else if (own) replaced.push(`${path} (was ${had.oid.slice(0, 12)})`);
    } else {
      const kitText = blob(factory, want.oid);
      const from = path === 'AGENTS.md' ? composeAgents(kitText, chosen.pack?.section ?? null) : kitText;
      const to = render(path, from, { name, human });
      const text = blob(repo, have.oid);
      const parts = text === to ? { ok: true } : ownParts(path, to, text);
      // Where the base is a rendering, the repository's own Layout and Facts are the base's: a pull request that rewrites
      // them is not the kit's, whatever it says (bin/kit-update never changes them).
      // A text with no Layout section has no own parts; one whose parts cannot be parsed is unreadable, and fails closed.
      const ownKey = (t) => {
        if (!t.split('\n').some((l) => l.trimEnd() === LAYOUT)) return 'none';
        try {
          return JSON.stringify(ownOf(t));
        } catch {
          return null;
        }
      };
      const checkOwn = path === 'AGENTS.md' && as !== null;
      const baseOwn = checkOwn ? ownKey(blob(repo, had.oid)) : undefined;
      const headOwn = checkOwn ? ownKey(text) : undefined;
      if (!parts.ok) fails.push(`differs: ${path} (${parts.why ?? 'content'})`);
      else if (checkOwn && (baseOwn === null || headOwn === null)) fails.push(`differs: ${path} (the repository's own parts cannot be read)`);
      else if (checkOwn && baseOwn !== headOwn) fails.push(`differs: ${path} (the repository's own Layout or Facts changed)`);
      else {
        filled.add(path);
        if (own && older) updated.push(was(path, had.oid, 'kit'));
        else if (own) replaced.push(`${path} (was ${had.oid.slice(0, 12)})`);
        const before = from.split('\n');
        to.split('\n').forEach((line, i) => i < (parts.upTo ?? Infinity) && line !== before[i] && rendered.push(`${path}:${i + 1}: \`${before[i]}\` → \`${line}\``));
        if (parts.filled) rendered.push(...parts.filled);
      }
    }
  }
  const list = [...new Set([...kit.keys(), INVENTORY, PACK_FILE, ...(names.length ? [MODULES_FILE] : [])])].sort((a, b) => (a < b ? -1 : 1));
  const inventory = now.get(INVENTORY);
  if (!inventory) fails.push(`missing: ${INVENTORY}`);
  else if (inventory.mode !== '100644' || blob(repo, inventory.oid) !== `${list.join('\n')}\n`) fails.push(`differs: ${INVENTORY} (not the kit's inventory)`);
  if (!chosen.why && now.get(PACK_FILE).mode !== '100644') fails.push(`differs: ${PACK_FILE} (mode ${now.get(PACK_FILE).mode})`);
  const listed = new Set(at.get(INVENTORY) ? blob(repo, at.get(INVENTORY).oid).split('\n').filter(Boolean) : []);
  const changed = git(repo, ['diff', '--name-only', '-z', '--no-renames', baseSha, headSha]).split('\0').filter(Boolean);
  for (const path of changed) {
    if (kit.has(path) || path === INVENTORY || path === PACK_FILE || path === MODULES_FILE) continue;
    const had = at.get(path);
    // A file the kit dropped may go when the base lists it as the kit's and holds a blob the kit once had at that path;
    // so may a module's, dropped by the module or with the module, from the places the base's modules laid it.
    const places = [`kit/${path}`, ...baseNames.map((n) => `modules/${n}/kit/${path}`)];
    if (had && listed.has(path) && !now.has(path) && places.some((p) => pastBlobs(factory, fac, p).has(had.oid))) removed.push(was(path, had.oid, off.has(path) ? `module ${off.get(path).module} is off` : 'no longer in the kit'));
    else fails.push(`extra: ${path} (not a kit file)`);
  }
  const lines = [
    `kit-evidence: ${fails.length ? 'FAIL' : 'PASS'}`,
    `factory commit: ${fac}, kit tree ${kitTree}`,
    `repository: ${slug} (id ${id})`,
    `base: ${baseSha}`,
    `head: ${headSha}`,
    `pack: ${chosen.name ?? 'unknown'}`,
    ...(names.length ? [`modules: ${names.join(', ')}`] : []),
    `managed files: ${kit.size + (kit.has(INVENTORY) ? 0 : 1) + 1 + (names.length ? 1 : 0)}: ${exact} as in the kit, ${filled.size} rendered, ${kept.length} kept, ${names.length ? 3 : 2} generated`,
  ];
  if (fails.length) lines.push('failures:', ...fails.map((f) => `  ${f}`));
  lines.push('rendered (bin/onboard fills these in):', ...(rendered.length ? rendered.map((l) => `  ${l}`) : ['  none']));
  lines.push("replaced (the repository's own at the base, now the kit's):", ...(replaced.length ? replaced.map((p) => `  ${p}`) : ['  none']));
  lines.push("kept (the repository's own, unchanged):", ...(kept.length ? kept.map((p) => `  ${p}`) : ['  none']));
  // Only bin/kit-update's pull requests make these two; a first onboarding's evidence has neither.
  if (updated.length) lines.push("updated (the base held an older kit or module file, or an older rendering, now the kit's):", ...updated.map((p) => `  ${p}`));
  if (removed.length) lines.push('removed (the base held an older kit or module file that is no longer laid):', ...removed.map((p) => `  ${p}`));
  return { pass: !fails.length, text: lines.join('\n') };
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
  const need = ['factory', 'commit', 'repo', 'base', 'head', 'slug', 'id'];
  if (need.some((k) => !opt[k]) || !/^[A-Za-z0-9_=-]+$/.test(opt.id) || !/^[\w.-]+\/[\w.-]+$/.test(opt.slug)) {
    console.error('usage: bin/kit-evidence --factory <dir> --commit <rev> --repo <dir> --base <rev> --head <rev> --slug <owner/name> --id <repository id> [--human <login>]');
    return 2;
  }
  const { pass, text } = evidence({ ...opt, human: opt.human ?? process.env.FACTORY_HUMAN ?? 'tuannd9288' });
  console.log(text);
  return pass ? 0 : 1;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`kit-evidence: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 2;
  }
}
