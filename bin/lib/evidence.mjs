// The kit pull request's evidence: its files against the kit at one factory commit, over the whole inventory, with
// contents, modes and symlinks compared by git object, never by running anything the repository holds. It reads both
// sides with ls-tree and cat-file only. A managed file is one of four kinds: as in the kit (same mode, same blob);
// rendered (CODEOWNERS and AGENTS.md, which bin/onboard fills in, shown line by line); kept (the repository had the
// path, and onboard left its file as it was); generated (.gate/kit-files, the sorted inventory). A managed file that is
// none of these, one missing, or a path the pull request changes outside the inventory fails it. The result names the
// factory commit, the kit's tree, the repository's id, base and head, so it holds for those and nothing else.
// See bin/kit-evidence for the arguments.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INVENTORY = '.gate/kit-files';
const FILLED = { '.github/CODEOWNERS': (v) => ['@OWNER', `@${v.human}`], 'AGENTS.md': (v) => ['<repo>', v.name] };
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
  const rendered = [];
  const filled = new Set();
  const kept = [];
  let exact = 0;
  for (const [path, want] of [...kit].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = now.get(path);
    const had = at.get(path);
    if (!have) fails.push(`missing: ${path}`);
    else if (had && have.mode === had.mode && have.oid === had.oid && (had.mode !== want.mode || had.oid !== want.oid)) kept.push(path);
    else if (had && (had.mode !== want.mode || had.oid !== want.oid)) fails.push(`differs: ${path} (the repository's own, changed)`);
    else if (have.mode !== want.mode) fails.push(`differs: ${path} (mode ${have.mode}, the kit's ${want.mode})`);
    else if (!FILLED[path]) have.oid === want.oid ? exact++ : fails.push(`differs: ${path} (content)`);
    else {
      const from = blob(factory, want.oid);
      const to = render(path, from, { name, human });
      if (blob(repo, have.oid) !== to) fails.push(`differs: ${path} (content)`);
      else {
        filled.add(path);
        const before = from.split('\n');
        to.split('\n').forEach((line, i) => line !== before[i] && rendered.push(`${path}:${i + 1}: \`${before[i]}\` → \`${line}\``));
      }
    }
  }
  const list = [...new Set([...kit.keys(), INVENTORY])].sort((a, b) => (a < b ? -1 : 1));
  const inventory = now.get(INVENTORY);
  if (!inventory) fails.push(`missing: ${INVENTORY}`);
  else if (inventory.mode !== '100644' || blob(repo, inventory.oid) !== `${list.join('\n')}\n`) fails.push(`differs: ${INVENTORY} (not the kit's inventory)`);
  const changed = git(repo, ['diff', '--name-only', '-z', '--no-renames', baseSha, headSha]).split('\0').filter(Boolean);
  for (const path of changed) if (!kit.has(path) && path !== INVENTORY) fails.push(`extra: ${path} (not a kit file)`);
  const lines = [
    `kit-evidence: ${fails.length ? 'FAIL' : 'PASS'}`,
    `factory commit: ${fac}, kit tree ${kitTree}`,
    `repository: ${slug} (id ${id})`,
    `base: ${baseSha}`,
    `head: ${headSha}`,
    `managed files: ${kit.size + (kit.has(INVENTORY) ? 0 : 1)}: ${exact} as in the kit, ${filled.size} rendered, ${kept.length} kept, 1 generated`,
  ];
  if (fails.length) lines.push('failures:', ...fails.map((f) => `  ${f}`));
  lines.push('rendered (bin/onboard fills these in):', ...(rendered.length ? rendered.map((l) => `  ${l}`) : ['  none']));
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
