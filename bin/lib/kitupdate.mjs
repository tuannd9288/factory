// What bin/kit-update lays on an onboarded repository: for every path of kit/ at one factory commit, what the base
// (origin/main) holds against what the kit's history has held. Reads git objects of both sides (ls-tree, cat-file, log);
// it runs nothing the repository holds. bin/kit-evidence then proves the result against the same commit.
//   node bin/lib/kitupdate.mjs plan|lay --factory <dir> --commit <rev> --repo <dir> --base <rev> --name <repo name>
//     --human <login> [--modules <a,b>] [--out <dir>]
// `plan` only checks; `lay` also writes the files into the repository's working tree and, with --out, one list per
// kind (added, updated, kept, removed, dropped-kept; one path a line). Per path:
//   .github/CODEOWNERS (rendered): added when missing; left alone when the base is this commit's rendering; rendered anew
//     when the base is an older rendering of the kit; otherwise the repository's own, and kept;
//   .claude/settings.json: added as the kit's file when missing; otherwise the base's bytes with the kit's deny lines it
//     lacks inserted as text (bin/lib/settings.mjs), every other byte kept, a shape the lines cannot be added to a conflict;
//   other: added when missing; left alone when it is the kit's; replaced by the kit's when it is a blob the kit's history
//     held; otherwise the repository's own, and kept. The repository's own scripts/ and .githooks/ files are not in kit/, so
//     they are never read.
// AGENTS.md and CLAUDE.md are the repository's own. AGENTS.md has only its Gate block replaced, head and tail as they
// are; the old kit's composition (bin/lib/legacy.mjs) gets the block in place of its head and keeps every byte from
// `## Layout` on; any other text without a block, a block with malformed markers, or a result over 150 lines or 32 KiB is a
// conflict, and nothing is cut. CLAUDE.md is added as the one-line import where missing, and otherwise left as it is (a
// conflict when it does not reach AGENTS.md). .gate/kit-commit records the factory commit; the old .gate/pack is removed.
// A module's files (bin/lib/module.mjs) are laid with the kit's, from the modules --modules names, and are stricter:
// added, left alone or updated from a past module blob; the repository's own file at a module path is a conflict, never
// kept. The files of a module the base had on and --modules leaves out are removed, or a conflict when the repository
// changed one. A path of the base's .gate/kit-files that kit/ no longer has is removed when its blob is one the kit once held, and
// otherwise kept (dropped-kept). Exit 0, or 1 with the conflicts when the repository's own must be merged by hand.
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carrierProblems, replaceGate, sizeProblems, splitGate } from '../../kit/.gate/bin/lib/instructions.mjs';
import { legacyCompose } from './legacy.mjs';
import { CONFIG, FILLED, INSTRUCTION_FILES, INVENTORY, KIT_COMMIT, SECTION, SETTINGS, blockFor, denyOf, git, pastBlobs, pastWithBlock, render, renderedAs, tree } from './evidence.mjs';
import { MODULES_FILE, baseModules, mergedTree, offFiles } from './module.mjs';
import { addDeny } from './settings.mjs';

const RENDERED = (path) => Boolean(FILLED[path]);

export function plan({ factory, commit, repo, base, name, human, modules }) {
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
  const out = { add: [], update: [], same: [], keep: [], remove: [], droppedKept: [], conflicts: lost, writes: [], removes: [] };
  const rendering = (path, want) => render(path, text(factory, want.oid), { name, human });
  for (const [path, want] of [...kit].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const had = at.get(path);
    if (path === SETTINGS && had) {
      // The repository's own file: the base's bytes with the kit's deny lines it lacks inserted as text, every other byte kept.
      const ownBytes = git(repo, ['cat-file', 'blob', had.oid], 'buffer');
      let to;
      try {
        to = addDeny(ownBytes, denyOf(text(factory, want.oid))).text;
      } catch (error) {
        out.conflicts.push(`${path}: ${error.message}`);
        continue;
      }
      if (to === ownBytes.toString('utf8')) out.same.push(path);
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
      const as = had.mode === want.mode ? renderedAs({ factory, fac, path, text: text(repo, had.oid), name, human }) : null;
      if (as === 'now') out.same.push(path);
      else if (as === 'past') {
        out.update.push(path);
        out.writes.push({ path, mode: want.mode, text: to });
      } else out.keep.push(path);
      continue;
    }
    if (!had) {
      out.add.push(path);
      out.writes.push({ path, mode: want.mode, oid: want.oid });
    } else if (had.mode === want.mode && had.oid === want.oid) out.same.push(path);
    else if (pastBlobs(factory, fac, want.src).has(had.oid)) {
      out.update.push(path);
      out.writes.push({ path, mode: want.mode, oid: want.oid });
    } else if (path === CONFIG && pastWithBlock(factory, fac, want.src, text(repo, had.oid), blockFor(repo, at))) {
      // An older kit text with the adapter block after it: laid anew, with the block.
      out.update.push(path);
      out.writes.push({ path, mode: want.mode, text: text(factory, want.oid) + blockFor(repo, at) });
    } else if (want.module) out.conflicts.push(`${path}: the repository's own, at a path module ${want.module} lays; a module's file is never kept`);
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
  instructions({ out, at, repo, factory, fac, name, kit, text });
  // What the base lists as the kit's that kit/ no longer has.
  const listed = at.get(INVENTORY) ? text(repo, at.get(INVENTORY).oid).split('\n').filter(Boolean) : [];
  for (const path of listed) {
    const had = at.get(path);
    if (kit.has(path) || off.has(path) || path === INVENTORY || path === KIT_COMMIT || path === '.gate/pack' || path === MODULES_FILE || INSTRUCTION_FILES.includes(path) || !had) continue;
    if ([`kit/${path}`, ...baseNames.map((n) => `modules/${n}/kit/${path}`)].some((p) => pastBlobs(factory, fac, p).has(had.oid))) {
      out.remove.push(path);
      out.removes.push(path);
    } else out.droppedKept.push(path);
  }
  return { ...out, fac, baseSha, kit, factory };
}

/** The repository's own instruction files and the commit the kit comes from. AGENTS.md: its block replaced, or put in place of
 * the old kit's head; CLAUDE.md: left as it is; .gate/kit-commit: the factory commit; the old .gate/pack: removed. */
function instructions({ out, at, repo, factory, fac, name, kit, text }) {
  const sectionEntry = kit.get(SECTION);
  if (!sectionEntry) {
    out.conflicts.push(`${SECTION}: the kit at ${fac.slice(0, 7)} has none`);
    return;
  }
  const section = text(factory, sectionEntry.oid);
  const hadA = at.get('AGENTS.md');
  if (!hadA) {
    out.add.push('AGENTS.md');
    out.writes.push({ path: 'AGENTS.md', mode: '100644', text: `# ${name}\n\n${section}` });
  } else if (!['100644', '100755'].includes(hadA.mode)) out.conflicts.push(`AGENTS.md: it is not a regular file (mode ${hadA.mode}); merge it by hand`);
  else {
    const baseText = text(repo, hadA.oid);
    const found = splitGate(baseText);
    const packFile = at.get('.gate/pack');
    let to = null;
    if (found.ok) to = replaceGate(baseText, section);
    else if (found.problem !== 'missing') out.conflicts.push(`AGENTS.md: its Gate markers are ${found.problem}; merge it by hand (one begin line and one end line, the block first)`);
    else {
      const legacy = legacyCompose({ factory, fac, baseText, name, packName: packFile ? text(repo, packFile.oid).trim() : 'pstack', section });
      if (legacy) to = legacy.text;
      else out.conflicts.push("AGENTS.md: it has no Gate block and is not the old kit's composition, so the kit cannot tell where its own text begins; merge it by hand (put the kit's block at its start)");
    }
    if (to !== null) {
      const size = sizeProblems(to);
      if (size.length) out.conflicts.push(`AGENTS.md: ${size[0]}`);
      else if (to === baseText) out.same.push('AGENTS.md');
      else {
        out.update.push('AGENTS.md');
        out.writes.push({ path: 'AGENTS.md', mode: hadA.mode, text: to });
      }
    }
  }
  const hadC = at.get('CLAUDE.md');
  if (!hadC) {
    out.add.push('CLAUDE.md');
    out.writes.push({ path: 'CLAUDE.md', mode: '100644', text: '@AGENTS.md\n' });
  } else {
    const bytes = ['100644', '100755', '120000'].includes(hadC.mode) ? git(repo, ['cat-file', 'blob', hadC.oid], 'buffer') : Buffer.alloc(0);
    for (const problem of carrierProblems({ mode: hadC.mode, bytes })) out.conflicts.push(`CLAUDE.md: ${problem}`);
  }
  const hadK = at.get(KIT_COMMIT);
  const commitText = `${fac}\n`;
  if (!hadK) {
    out.add.push(KIT_COMMIT);
    out.writes.push({ path: KIT_COMMIT, mode: '100644', text: commitText });
  } else if (hadK.mode !== '100644' || text(repo, hadK.oid) !== commitText) {
    out.update.push(KIT_COMMIT);
    out.writes.push({ path: KIT_COMMIT, mode: '100644', text: commitText });
  }
  const hadP = at.get('.gate/pack');
  if (hadP) {
    if (/^[a-z][a-z0-9-]*\n$/.test(text(repo, hadP.oid))) {
      out.remove.push('.gate/pack');
      out.removes.push('.gate/pack');
    } else out.droppedKept.push('.gate/pack');
  }
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
  if (!['plan', 'lay'].includes(verb) || ['factory', 'commit', 'repo', 'base', 'name', 'human'].some((k) => !opt[k])) {
    console.error('usage: node bin/lib/kitupdate.mjs plan|lay --factory <dir> --commit <rev> --repo <dir> --base <rev> --name <name> --human <login> [--modules <a,b>] [--out <dir>]');
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
