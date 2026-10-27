// What bin/kit-update lays on an onboarded repository: for every path of kit/ at one factory commit, what the base
// (origin/main) holds against what the kit's history has held. Reads git objects of both sides (ls-tree, cat-file, log);
// it runs nothing the repository holds. bin/kit-evidence then proves the result against the same commit.
//   node bin/lib/kitupdate.mjs plan|lay --factory <dir> --commit <rev> --repo <dir> --base <rev> --name <repo name>
//     --human <login> --pack <name> [--modules <a,b>] [--out <dir>]
// `plan` only checks; `lay` also writes the files into the repository's working tree and, with --out, one list per
// kind (added, updated, kept, removed, dropped-kept; one path a line). Per path:
//   rendered (AGENTS.md, CODEOWNERS): added when missing; left alone when the base is this commit's
//     rendering (AGENTS.md with the own parts the base carries); rendered anew when the base is an older rendering of
//     the kit and pack; otherwise the repository's own: CODEOWNERS is kept, AGENTS.md is a conflict;
//   .claude/settings.json: added (the pack composes it) when missing; otherwise the base's bytes with the kit's deny lines it
//     lacks inserted as text (bin/lib/settings.mjs), every other byte kept, a shape the lines cannot be added to a conflict;
//   other: added when missing; left alone when it is the kit's; replaced by the kit's when it is a blob the kit's history
//     held; otherwise the repository's own: kept, but a conflict where the kit replaces whole (CLAUDE.md). The repository's own
//     scripts/ and .githooks/ files are not in kit/, so they are never read.
// A module's files (bin/lib/module.mjs) are laid with the kit's, from the modules --modules names, and are stricter:
// added, left alone or updated from a past module blob; the repository's own file at a module path is a conflict, never
// kept. The files of a module the base had on and --modules leaves out are removed, or a conflict when the repository
// changed one. A path of the base's .gate/kit-files that kit/ no longer has is removed when its blob is one the kit once held, and
// otherwise kept (dropped-kept). Exit 0, or 1 with the conflicts when the repository's own must be merged by hand.
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FACTS, LAYOUT, LIMIT, fill } from './own.mjs';
import { FILLED, INVENTORY, REPLACES, SETTINGS, denyOf, git, ownOf, pastBlobs, render, renderedAs, tree } from './evidence.mjs';
import { MODULES_FILE, baseModules, mergedTree, offFiles } from './module.mjs';
import { PACK_FILE, composeAgents, composeSettings } from './pack.mjs';
import { addDeny } from './settings.mjs';

const RENDERED = (path) => Boolean(FILLED[path]);

export function plan({ factory, commit, repo, base, name, human, pack: packName, modules }) {
  const fac = git(factory, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const baseSha = git(repo, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const names = modules ? modules.split(',') : [];
  const kit = mergedTree(factory, fac, names);
  const at = tree(repo, baseSha);
  const text = (dir, oid) => git(dir, ['cat-file', 'blob', oid]);
  const baseNames = baseModules(at.get(MODULES_FILE) ? text(repo, at.get(MODULES_FILE).oid) : null);
  // The files of a module the base had on and the update turns off; a base that names a module the factory lacks stops it.
  let off = new Map();
  const lost = [];
  try {
    off = offFiles(factory, fac, baseNames, names);
  } catch (error) {
    lost.push(error.message);
  }
  const pack = packName === 'none' ? null : { settings: text(factory, git(factory, ['rev-parse', `${fac}:packs/${packName}/settings.json`]).trim()), section: text(factory, git(factory, ['rev-parse', `${fac}:packs/${packName}/AGENTS.md`]).trim()) };
  const out = { add: [], update: [], same: [], keep: [], remove: [], droppedKept: [], conflicts: lost, writes: [], removes: [] };
  const rendering = (path, want) => {
    const kitText = text(factory, want.oid);
    if (path === SETTINGS) return composeSettings(kitText, pack?.settings ?? null);
    return render(path, path === 'AGENTS.md' ? composeAgents(kitText, pack?.section ?? null) : kitText, { name, human });
  };
  for (const [path, want] of [...kit].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const had = at.get(path);
    if (path === SETTINGS) {
      // The repository's own file: its bytes with the kit's deny lines it lacks inserted as text. With none, the pack composes it.
      if (!had) {
        out.add.push(path);
        out.writes.push({ path, mode: want.mode, text: rendering(path, want) });
        continue;
      }
      const own = text(repo, had.oid);
      let to;
      try {
        to = addDeny(own, denyOf(text(factory, want.oid))).text;
      } catch (error) {
        out.conflicts.push(`${path}: ${error.message}`);
        continue;
      }
      if (to === own) out.same.push(path);
      else {
        out.update.push(path);
        out.writes.push({ path, mode: had.mode, text: to });
      }
      continue;
    }
    if (RENDERED(path)) {
      const to = rendering(path, want);
      if (!had) {
        out.add.push(path);
        out.writes.push({ path, mode: want.mode, text: to });
        continue;
      }
      const as = had.mode === want.mode ? renderedAs({ factory, fac, path, text: text(repo, had.oid), name, human, pack, packName }) : null;
      if (as === 'now') out.same.push(path);
      else if (as === 'past') {
        let final = to;
        if (path === 'AGENTS.md') {
          let own;
          try {
            own = ownOf(text(repo, had.oid));
          } catch (error) {
            out.conflicts.push(`${path}: the repository's ${error.message.startsWith('no section') ? `AGENTS.md has no "${LAYOUT}" section` : `own sections cannot be read (${error.message})`}; merge it by hand (put its own parts under "${LAYOUT}" and "${FACTS}")`);
            continue;
          }
          final = fill(to, own).text;
          if (final.split('\n').length - 1 > LIMIT) {
            out.conflicts.push(`${path}: with the repository's own parts it would have ${final.split('\n').length - 1} lines; at most ${LIMIT}`);
            continue;
          }
        }
        out.update.push(path);
        out.writes.push({ path, mode: want.mode, text: final });
      } else if (path === 'AGENTS.md') out.conflicts.push(`${path}: the repository's own text, not the kit's with its Layout and Facts sections (${LAYOUT}, ${FACTS})`);
      else out.keep.push(path);
      continue;
    }
    if (!had) {
      out.add.push(path);
      out.writes.push({ path, mode: want.mode, oid: want.oid });
    } else if (had.mode === want.mode && had.oid === want.oid) out.same.push(path);
    else if (pastBlobs(factory, fac, want.src).has(had.oid)) {
      out.update.push(path);
      out.writes.push({ path, mode: want.mode, oid: want.oid });
    } else if (want.module) out.conflicts.push(`${path}: the repository's own, at a path module ${want.module} lays; a module's file is never kept`);
    else if (REPLACES(path)) out.conflicts.push(`${path}: the repository's own, which the kit replaces whole`);
    else out.keep.push(path);
  }
  for (const [path, e] of off) {
    const had = at.get(path);
    if (!had) continue;
    if (pastBlobs(factory, fac, e.src).has(had.oid)) {
      out.remove.push(path);
      out.removes.push(path);
    } else out.conflicts.push(`${path}: the repository's own, which module ${e.module} laid and is now off; a module's file is never kept`);
  }
  // What the base lists as the kit's that kit/ no longer has.
  const listed = at.get(INVENTORY) ? text(repo, at.get(INVENTORY).oid).split('\n').filter(Boolean) : [];
  for (const path of listed) {
    const had = at.get(path);
    if (kit.has(path) || off.has(path) || path === INVENTORY || path === PACK_FILE || path === MODULES_FILE || !had) continue;
    if ([`kit/${path}`, ...baseNames.map((n) => `modules/${n}/kit/${path}`)].some((p) => pastBlobs(factory, fac, p).has(had.oid))) {
      out.remove.push(path);
      out.removes.push(path);
    } else out.droppedKept.push(path);
  }
  return { ...out, fac, baseSha, kit, factory };
}

/** Writes a plan's files into the working tree of repo: a link the repository holds there is removed first, since a
 * write would go through it. */
export function lay(result, repo) {
  const put = (path, mode, data) => {
    const target = join(repo, path);
    rmSync(target, { force: true });
    mkdirSync(dirname(target), { recursive: true });
    if (mode === '120000') symlinkSync(String(data), target);
    else {
      writeFileSync(target, data);
      chmodSync(target, mode === '100755' ? 0o755 : 0o644);
    }
  };
  for (const w of result.writes) put(w.path, w.mode, w.oid ? git(result.factory, ['cat-file', 'blob', w.oid], 'buffer') : w.text);
  for (const path of result.removes) rmSync(join(repo, path), { force: true });
}

function main(argv) {
  const [verb, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (!['plan', 'lay'].includes(verb) || ['factory', 'commit', 'repo', 'base', 'name', 'human', 'pack'].some((k) => !opt[k])) {
    console.error('usage: node bin/lib/kitupdate.mjs plan|lay --factory <dir> --commit <rev> --repo <dir> --base <rev> --name <name> --human <login> --pack <name> [--modules <a,b>] [--out <dir>]');
    return 2;
  }
  const result = plan(opt);
  if (result.conflicts.length) {
    console.log("kit-update: these files are the repository's own and the kit cannot take them over; merge them by hand (or put the repository's own parts where the kit keeps them), then run again:");
    for (const c of result.conflicts) console.log(`  ${c}`);
    return 1;
  }
  if (verb === 'lay') {
    lay(result, opt.repo);
    if (opt.out) {
      mkdirSync(opt.out, { recursive: true });
      for (const [file, list] of [['added', result.add], ['updated', result.update], ['kept', result.keep], ['removed', result.remove], ['dropped-kept', result.droppedKept]]) writeFileSync(join(opt.out, file), list.map((p) => `${p}\n`).join(''));
    }
  }
  return 0;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`kit-update: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 2;
  }
}
