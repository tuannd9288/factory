// What bin/kit-update lays on an onboarded repository: for every path of kit/ at one factory commit, what the base
// (origin/main) holds against what the kit's history has held. Reads git objects of both sides (ls-tree, cat-file, log);
// it runs nothing the repository holds. bin/kit-evidence then proves the result against the same commit.
//   node bin/lib/kitupdate.mjs plan|lay --factory <dir> --commit <rev> --repo <dir> --base <rev> --name <repo name>
//     --human <login> [--modules <a,b>] [--out <dir>] [--reviewer <name>] [--runner <json>] [--pr-runner <json>]
//     [--trusted-runner <json>]
// `plan` only checks; `lay` also writes the files into the repository's working tree and, with --out, one list per
// kind (added, updated, kept, removed, dropped-kept; one path a line). Per path:
//   .github/CODEOWNERS and the three gate workflows (rendered, bin/lib/gate-settings.mjs): added when missing; when the base
//     is a rendering of the kit, now or older, rendered anew with the gate's settings the base holds, each one an option names
//     taking its place (#335), and left alone when that changes nothing; otherwise the repository's own, and kept. A base
//     workflow that still reads a repository variable (the kit before #335) holds no setting, so its option must be given,
//     or that is a conflict; so are settings that break the runner rule;
//   .claude/settings.json: added as the kit's file when missing; otherwise the base's bytes with the kit's deny lines it
//     lacks inserted as text (bin/lib/settings.mjs), every other byte kept, a shape the lines cannot be added to a conflict;
//   other: added when missing; left alone when it is the kit's; replaced by the kit's when it is a blob the kit's history
//     held; otherwise the repository's own, and kept. The repository's own scripts/ and .githooks/ files are not in kit/, so
//     they are never read.
// AGENTS.md and CLAUDE.md are the repository's own. AGENTS.md has only its Gate block replaced, head and tail as they
// are; any text without a block, a block with malformed markers, or a result over 150 lines or 32 KiB is a
// conflict, and nothing is cut. CLAUDE.md is added as the one-line import where missing, and otherwise left as it is (a
// conflict when it does not reach AGENTS.md). .gitattributes is the repository's own too, and gets the same treatment for the
// kit's review-categories block (bin/lib/attributes.mjs): the block replaced, head and tail as they are; a text without one gets
// it at its start, none gets a file of the block alone; malformed markers, CRLF or a link are conflicts.
// .gate/kit-commit records the factory commit; the old .gate/pack is removed.
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
import { replaceBlock, insertBlock, splitBlock } from './attributes.mjs';
import { ATTRIBUTES, BLOCK_FILE, CONFIG, FILLED, INSTRUCTION_FILES, INVENTORY, KIT_COMMIT, SECTION, SETTINGS, blockFor, denyOf, git, pastBlobs, pastWithBlock, render, renderedAs, tree } from './evidence.mjs';
import { SETTINGS as GATE_SETTINGS, WORKFLOWS, describe, parseOptions, runnerProblems, valuesIn } from './gate-settings.mjs';
import { MODULES_FILE, baseModules, mergedTree, offFiles } from './module.mjs';
import { addDeny } from './settings.mjs';

const RENDERED = (path) => Boolean(FILLED[path]);

export function plan({ factory, commit, repo, base, name, human, modules, given = {} }) {
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
  // The gate's settings: each as an option gives it, else as the base's workflows hold it, else the kit's default.
  const baseValues = valuesIn(Object.fromEntries(WORKFLOWS.filter((p) => at.get(p)?.mode === '100644').map((p) => [p, text(repo, at.get(p).oid)])));
  const values = { ...baseValues, ...given };
  const from = Object.fromEntries(GATE_SETTINGS.map((s) => [s.key, given[s.key] !== undefined ? 'given' : baseValues[s.key] !== undefined ? "the base's" : "the kit's default"]));
  const rendering = (path, want) => render(path, text(factory, want.oid), { ...values, human });
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
      const was = text(repo, had.oid);
      const as = had.mode === want.mode ? renderedAs({ factory, fac, path, text: was, human }) : null;
      if (as === null) {
        out.keep.push(path);
        continue;
      }
      // A setting the base reads from a repository variable is in no file: its value comes only from its option.
      const lost = GATE_SETTINGS.filter((s) => s.file === path && given[s.key] === undefined && was.includes(`vars.${s.variable}`));
      for (const s of lost) out.conflicts.push(`${path}: the base reads the repository variable ${s.variable}, as the kit did before #335, so ${s.words} is in no file; name it with ${s.option} (the variable's value, gh variable list)`);
      if (lost.length) continue;
      if (to === was) out.same.push(path);
      else {
        out.update.push(path);
        out.writes.push({ path, mode: want.mode, text: to });
      }
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
  for (const problem of runnerProblems(values)) out.conflicts.push(`runners: ${problem} (kit/.gate/enforced-rules.md)`);
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
  return { ...out, fac, baseSha, kit, factory, settings: describe(values, from) };
}

/** The repository's own instruction files and the commit the kit comes from. AGENTS.md: its block replaced; CLAUDE.md: left as it is; .gate/kit-commit: the factory commit; the old .gate/pack: removed. */
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
    let to = null;
    if (found.ok) to = replaceGate(baseText, section);
    else if (found.problem !== 'missing') out.conflicts.push(`AGENTS.md: its Gate markers are ${found.problem}; merge it by hand (one begin line and one end line, the block first)`);
    else out.conflicts.push("AGENTS.md: it has no Gate block, so the kit cannot tell where its own text begins; merge it by hand (put the kit's block at its start)");
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
  attributes({ out, at, repo, factory, kit, text });
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

/** The repository's own .gitattributes: the kit's review-categories block replaced, the head and the tail kept; a text with no
 * block gets the block at its start (a repository onboarded before the block existed); none gets a file of the block alone. */
function attributes({ out, at, repo, factory, kit, text }) {
  const blockEntry = kit.get(BLOCK_FILE);
  // A factory commit from before the block has no lines for .gitattributes: it is left as it is.
  if (!blockEntry) return;
  const block = text(factory, blockEntry.oid);
  const had = at.get(ATTRIBUTES);
  if (!had) {
    out.add.push(ATTRIBUTES);
    out.writes.push({ path: ATTRIBUTES, mode: '100644', text: block });
    return;
  }
  if (!['100644', '100755'].includes(had.mode)) {
    out.conflicts.push(`${ATTRIBUTES}: it is not a regular file (mode ${had.mode}); merge it by hand`);
    return;
  }
  const baseText = text(repo, had.oid);
  const found = splitBlock(baseText);
  let to;
  try {
    if (found.ok) to = replaceBlock(baseText, block);
    else if (found.problem === 'missing') to = insertBlock(baseText, block);
    else {
      out.conflicts.push(`${ATTRIBUTES}: its review-categories markers are ${found.problem}; merge it by hand (one begin line and one end line, the block first)`);
      return;
    }
  } catch (error) {
    out.conflicts.push(`${ATTRIBUTES}: ${error.message}; merge it by hand`);
    return;
  }
  if (to === baseText) out.same.push(ATTRIBUTES);
  else {
    out.update.push(ATTRIBUTES);
    out.writes.push({ path: ATTRIBUTES, mode: had.mode, text: to });
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
  const settings = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (GATE_SETTINGS.some((s) => s.option === rest[i])) settings.push(rest[i], rest[i + 1]);
    else opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  }
  const { values: given, problem } = parseOptions(settings);
  if (problem || !['plan', 'lay'].includes(verb) || ['factory', 'commit', 'repo', 'base', 'name', 'human'].some((k) => !opt[k])) {
    if (problem) console.error(`kit-update: ${problem}`);
    console.error('usage: node bin/lib/kitupdate.mjs plan|lay --factory <dir> --commit <rev> --repo <dir> --base <rev> --name <name> --human <login> [--modules <a,b>] [--out <dir>] [--reviewer <name>] [--runner <json>] [--pr-runner <json>] [--trusted-runner <json>]');
    return 2;
  }
  const result = plan({ ...opt, given });
  if (result.conflicts.length) {
    console.log("kit-update: the kit cannot be laid as the base stands; for each line, merge the repository's own file by hand (or put its own parts where the kit keeps them), or give the option the line names, then run again:");
    for (const c of result.conflicts) console.log(`  ${c}`);
    return 1;
  }
  console.log("kit-update: the gate's settings this update lays (#335):");
  for (const line of result.settings) console.log(`  ${line}`);
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
