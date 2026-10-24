// The kit pull request's evidence: its files against the kit at one factory commit, over the whole inventory, with
// contents, modes and symlinks compared by git object, never by running anything the repository holds. It reads both
// sides with ls-tree and cat-file only. A managed file is one of four kinds: as in the kit (same mode, same blob);
// rendered (CODEOWNERS and AGENTS.md, which bin/onboard fills in, shown line by line, and .claude/settings.json, which
// it composes); kept (the repository had the path, and onboard left its file as it was); generated (.gate/kit-files,
// the sorted inventory, and .gate/pack, the repository's choice of pack). The pack is the one the head's .gate/pack
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
import { NAME, PACK_FILE, composeAgents, composeSettings } from './pack.mjs';

const INVENTORY = '.gate/kit-files';
const SETTINGS = '.claude/settings.json';
const FILLED = { '.github/CODEOWNERS': (v) => ['@OWNER', `@${v.human}`], 'AGENTS.md': (v) => ['<repo>', v.name] };
// What the kit replaces when the repository has its own (bin/onboard's REPLACE): its instructions and its hooks.
const REPLACES = (path) => path === 'AGENTS.md' || path === 'CLAUDE.md' || path.startsWith('.githooks/');
const GIT_MS = 60_000;

const git = (dir, args, encoding = 'utf8') => execFileSync('git', ['-C', dir, ...args], { encoding, maxBuffer: 64 << 20, timeout: GIT_MS });

/** Every entry of rev's tree under prefix, by path relative to it: { mode, oid }. */
function tree(dir, rev, prefix = '') {
  const out = git(dir, ['ls-tree', '-r', '-z', '--full-tree', rev, ...(prefix ? ['--', prefix] : [])]);
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

export function evidence({ factory, commit, repo, base, head, slug, id, human }) {
  const name = slug.split('/')[1];
  const fac = git(factory, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const kitTree = git(factory, ['rev-parse', `${fac}:kit`]).trim();
  const headSha = git(repo, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const baseSha = git(repo, ['merge-base', base, headSha]).trim();
  const kit = tree(factory, fac, 'kit/');
  const at = tree(repo, baseSha);
  const now = tree(repo, headSha);
  const blob = (dir, oid) => git(dir, ['cat-file', 'blob', oid]);
  const fails = [];
  const chosen = packOf(factory, fac, repo, now);
  if (chosen.why) fails.push(chosen.why);
  const rendered = [];
  const filled = new Set();
  const kept = [];
  const replaced = [];
  let exact = 0;
  for (const [path, want] of [...kit].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = now.get(path);
    const had = at.get(path);
    const own = had && (had.mode !== want.mode || had.oid !== want.oid);
    const same = own && have && have.mode === had.mode && have.oid === had.oid;
    if (!have) fails.push(`missing: ${path}`);
    else if (same && REPLACES(path)) fails.push(`differs: ${path} (the repository's own, which the kit replaces)`);
    else if (same) kept.push(path);
    else if (own && !REPLACES(path)) fails.push(`differs: ${path} (the repository's own, changed)`);
    else if (have.mode !== want.mode) fails.push(`differs: ${path} (mode ${have.mode}, the kit's ${want.mode})`);
    else if (path === SETTINGS || (path === 'AGENTS.md' && chosen.why)) {
      // Built from the kit and the pack; with no pack to build from, the failure above says why and nothing is compared.
      if (!chosen.why && blob(repo, have.oid) !== composeSettings(blob(factory, want.oid), chosen.pack?.settings ?? null)) fails.push(`differs: ${path} (content)`);
      else if (!chosen.why) filled.add(path);
    } else if (!FILLED[path] && have.oid !== want.oid) fails.push(`differs: ${path} (content)`);
    else if (!FILLED[path]) {
      exact++;
      if (own) replaced.push(`${path} (was ${had.oid.slice(0, 12)})`);
    } else {
      const kitText = blob(factory, want.oid);
      const from = path === 'AGENTS.md' ? composeAgents(kitText, chosen.pack?.section ?? null) : kitText;
      const to = render(path, from, { name, human });
      const text = blob(repo, have.oid);
      const parts = text === to ? { ok: true } : ownParts(path, to, text);
      if (!parts.ok) fails.push(`differs: ${path} (${parts.why ?? 'content'})`);
      else {
        filled.add(path);
        if (own) replaced.push(`${path} (was ${had.oid.slice(0, 12)})`);
        const before = from.split('\n');
        to.split('\n').forEach((line, i) => i < (parts.upTo ?? Infinity) && line !== before[i] && rendered.push(`${path}:${i + 1}: \`${before[i]}\` → \`${line}\``));
        if (parts.filled) rendered.push(...parts.filled);
      }
    }
  }
  const list = [...new Set([...kit.keys(), INVENTORY, PACK_FILE])].sort((a, b) => (a < b ? -1 : 1));
  const inventory = now.get(INVENTORY);
  if (!inventory) fails.push(`missing: ${INVENTORY}`);
  else if (inventory.mode !== '100644' || blob(repo, inventory.oid) !== `${list.join('\n')}\n`) fails.push(`differs: ${INVENTORY} (not the kit's inventory)`);
  if (!chosen.why && now.get(PACK_FILE).mode !== '100644') fails.push(`differs: ${PACK_FILE} (mode ${now.get(PACK_FILE).mode})`);
  const changed = git(repo, ['diff', '--name-only', '-z', '--no-renames', baseSha, headSha]).split('\0').filter(Boolean);
  for (const path of changed) if (!kit.has(path) && path !== INVENTORY && path !== PACK_FILE) fails.push(`extra: ${path} (not a kit file)`);
  const lines = [
    `kit-evidence: ${fails.length ? 'FAIL' : 'PASS'}`,
    `factory commit: ${fac}, kit tree ${kitTree}`,
    `repository: ${slug} (id ${id})`,
    `base: ${baseSha}`,
    `head: ${headSha}`,
    `pack: ${chosen.name ?? 'unknown'}`,
    `managed files: ${kit.size + (kit.has(INVENTORY) ? 0 : 1) + 1}: ${exact} as in the kit, ${filled.size} rendered, ${kept.length} kept, 2 generated`,
  ];
  if (fails.length) lines.push('failures:', ...fails.map((f) => `  ${f}`));
  lines.push('rendered (bin/onboard fills these in):', ...(rendered.length ? rendered.map((l) => `  ${l}`) : ['  none']));
  lines.push("replaced (the repository's own at the base, now the kit's):", ...(replaced.length ? replaced.map((p) => `  ${p}`) : ['  none']));
  lines.push("kept (the repository's own, unchanged):", ...(kept.length ? kept.map((p) => `  ${p}`) : ['  none']));
  return { pass: !fails.length, text: lines.join('\n') };
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
  const need = ['factory', 'commit', 'repo', 'base', 'head', 'slug', 'id'];
  if (need.some((k) => !opt[k]) || !/^\d+$/.test(opt.id) || !/^[\w.-]+\/[\w.-]+$/.test(opt.slug)) {
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
