// The kit pull request's evidence: its files against the kit at one factory commit, over the whole inventory, with
// contents, modes and symlinks compared by git object, never by running anything the repository holds. It reads both
// sides with ls-tree and cat-file only. A managed file is one of these kinds: as in the kit (same mode, same blob);
// rendered (.github/CODEOWNERS and the three gate workflows, which bin/onboard fills in with the owner and the gate's settings,
// bin/lib/gate-settings.mjs, shown line by line); kept (the repository had the path, and the
// pull request left its file as it was); updated (the base held a past blob of kit/<path>, or a past rendering of it, and
// the head holds the kit's now: only bin/kit-update's pull requests make one, and a file the kit dropped that the base held
// as a past blob is removed the same way); generated (.gate/kit-files, the sorted inventory; .gate/kit-commit, the factory
// commit); merged (a .claude/settings.json the base had is the base's
// bytes with the kit's deny lines inserted as text, bin/lib/settings.mjs, and nothing else; with none at the base it is the
// kit's file as it is); adapter (.gate/config.sh is the kit's text, or with the lines bin/lib/adapter.mjs writes for the
// files the head holds); untouched (the repository's own scripts/ and .githooks/ files, which the kit does not ship, are in
// the head as in the base).
//
// AGENTS.md and CLAUDE.md are the repository's own and no kit file. AGENTS.md is the base's text with the kit's Gate block
// put in (a title line and the block where the base had none; with --own, any text the repository prepared, shown in full),
// or, where the base had a block, the base's head and tail with the block of the kit at this factory commit.
// .gitattributes is the repository's own too: the base's text with the kit's review-categories block (kit/.gate/review-categories,
// bin/lib/attributes.mjs) at its start, or only the block where there was none; a base with a block keeps its head and tail.
// CLAUDE.md is the base's, byte for byte and mode, or the one-line import where there was none. A managed file that is none
// of these, one missing, or a path the pull request changes outside the inventory fails it. The result names the factory
// commit, the kit's tree, the repository's id, base and head, so it holds for those and nothing else. See bin/kit-evidence
// for the arguments.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { carrierProblems, insertGate, sizeProblems, splitGate } from '../../kit/.gate/bin/lib/instructions.mjs';
import { HOOK, NATIVE, adapterBlock } from './adapter.mjs';
import { ATTRIBUTES, BLOCK_FILE, insertBlock, splitBlock } from './attributes.mjs';
import { DEFAULTS, FILLED, SETTINGS as GATE_SETTINGS, WORKFLOWS, describe, render, runnerProblems, shown, valuesIn, valuesOf } from './gate-settings.mjs';
import { addDeny } from './settings.mjs';

export const INVENTORY = '.gate/kit-files';
export const SETTINGS = '.claude/settings.json';
export const CONFIG = '.gate/config.sh';
export { FILLED, render };
export const KIT_COMMIT = '.gate/kit-commit';
export const SECTION = '.gate/gate-section.md';
export { ATTRIBUTES, BLOCK_FILE };
// The repository's own, which the kit puts its block in or leaves alone: no kit file, and never in the inventory.
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
export const UNTOUCHED = (path) => path.startsWith('scripts/') || path.startsWith('.githooks/');
// The kit's deny lines, out of the kit's settings.json text.
export const denyOf = (kitSettings) => JSON.parse(kitSettings).permissions.deny;
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

/** The kit's files at a factory commit: path → { mode, oid, src }, `src` being the path in the factory (kit/<path>), where the
 * file's history lives. */
export function kitFiles(factory, fac) {
  return new Map([...tree(factory, fac, 'kit/')].map(([path, e]) => [path, { ...e, src: `kit/${path}` }]));
}

/** The blob at rev:path in the factory, or null; git's complaint about an absent path is not output. */
export function showQuiet(factory, rev, path) {
  try {
    return execFileSync('git', ['-C', factory, 'cat-file', 'blob', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: GIT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const pastCache = new Map();

/** The adapter lines for the files a tree holds: bin/lib/adapter.mjs's block, "" when the repository has no scripts/verify. */
export function blockFor(repo, files) {
  const hook = files.get(HOOK);
  return adapterBlock({ native: files.has(NATIVE), hookText: hook ? git(repo, ['cat-file', 'blob', hook.oid]) : null });
}

/** Whether text is a kit text the factory once held at src, followed by the adapter block. */
export function pastWithBlock(factory, fac, src, text, block) {
  return block !== '' && [...pastBlobs(factory, fac, src)].some((oid) => git(factory, ['cat-file', 'blob', oid]) + block === text);
}

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

/** A file the kit fills in (CODEOWNERS, the gate workflows) as the kit rendered it, with the settings the text itself holds:
 * 'now' when it is the rendering of the kit at this factory commit, 'past' when it is one an older commit rendered, or null
 * (the repository's own). */
export function renderedAs({ factory, fac, path, text, human }) {
  const states = [showQuiet(factory, fac, `kit/${path}`)];
  for (const rev of git(factory, ['--literal-pathspecs', 'log', '--format=%H', fac, '--', `kit/${path}`]).split('\n').filter(Boolean)) states.push(showQuiet(factory, rev, `kit/${path}`));
  const values = { human, ...valuesOf(path, text) };
  const matches = (kit) => kit !== null && render(path, kit, values) === text;
  const [now, ...before] = states;
  if (matches(now)) return 'now';
  return before.some(matches) ? 'past' : null;
}

/** The failures of the head's AGENTS.md against the base's and the kit's block, and the repository's own text a --own file
 * brought, to show in full. The head is the repository's own text with the block put in (instructions.mjs), the block is
 * the kit's at the factory commit, and the composed file is within the limits. What the base was decides what else:
 *   - a base with a block: the head and the tail are the base's, only the block is the kit's;
 *   - no AGENTS.md: a title line and the block;
 *   - another text: that text with the block inserted, or with --own anything the repository prepared. */
function judgeAgents({ text, baseText, section, name, own }) {
  const found = splitGate(text);
  if (!found.ok) return { fails: [`the Gate block is ${found.problem}`] };
  if (found.block !== section) return { fails: ["the Gate block is not the kit's at this factory commit"] };
  const size = sizeProblems(text);
  if (size.length) return { fails: size };
  if (baseText === null) return text === `# ${name}\n\n${section}` ? { fails: [] } : { fails: ['the repository had none: a title line and the block, nothing else'] };
  const base = splitGate(baseText);
  if (base.ok) {
    return base.head === found.head && base.tail === found.tail ? { fails: [] } : { fails: ["a change of the block leaves the head and the tail as the base has them; they differ (the tail is the repository's)"] };
  }
  if (base.problem !== 'missing') return { fails: [`the base's Gate markers are ${base.problem}`] };
  const shown = [...found.head.split('\n').slice(0, -1), ...found.tail.split('\n')];
  if (own) return { fails: [], shown };
  try {
    return text === insertGate(baseText, section) ? { fails: [] } : { fails: ["not the repository's own text with the kit's block inserted"] };
  } catch (error) {
    return { fails: [`the base cannot take the block: ${error.message}`] };
  }
}

/** The failures of the head's .gitattributes against the base's and the kit's block: the block is the kit's file at the
 * factory commit, and outside it the text is the base's (the head and the tail as they were), or, where the base had no
 * block, the base's text with the block inserted; where the base had none, the block alone. */
function judgeAttributes({ text, baseText, block }) {
  const found = splitBlock(text);
  if (!found.ok) return [`the review-categories block is ${found.problem}`];
  if (found.block !== block) return ["the review-categories block is not the kit's at this factory commit"];
  if (baseText === null) return text === block ? [] : ['the repository had none: the block, nothing else'];
  const base = splitBlock(baseText);
  if (base.ok) return base.head === found.head && base.tail === found.tail ? [] : ["a change of the block leaves the head and the tail as the base has them; they differ (the rest is the repository's)"];
  if (base.problem !== 'missing') return [`the base's review-categories markers are ${base.problem}`];
  try {
    return text === insertBlock(baseText, block) ? [] : ["not the repository's own lines with the kit's block inserted at the start"];
  } catch (error) {
    return [`the base cannot take the block: ${error.message}`];
  }
}

export function evidence({ factory, commit, repo, base, head, slug, id, human, own = false }) {
  const name = slug.split('/')[1];
  const fac = git(factory, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const kitTree = git(factory, ['rev-parse', `${fac}:kit`]).trim();
  const headSha = git(repo, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const baseSha = git(repo, ['merge-base', base, headSha]).trim();
  const at = tree(repo, baseSha);
  const now = tree(repo, headSha);
  const blob = (dir, oid) => git(dir, ['cat-file', 'blob', oid]);
  const fails = [];
  const kit = kitFiles(factory, fac);
  const rendered = [];
  const filled = new Set();
  const kept = [];
  const updated = [];
  const removed = [];
  const merged = [];
  const adapted = [];
  const was = (path, oid, why) => `${path} (was ${oid.slice(0, 12)}, ${why} at factory ${fac.slice(0, 7)})`;
  let exact = 0;
  for (const [path, want] of [...kit].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = now.get(path);
    const had = at.get(path);
    if (path === SETTINGS && had) {
      // The repository's own file: its bytes with the kit's deny lines inserted as text, and nothing else changed.
      let expected;
      try {
        expected = addDeny(git(repo, ['cat-file', 'blob', had.oid], 'buffer'), denyOf(blob(factory, want.oid))).text;
      } catch (error) {
        fails.push(`differs: ${path} (${error.message})`);
        continue;
      }
      if (!have) fails.push(`missing: ${path}`);
      else if (have.mode !== had.mode) fails.push(`differs: ${path} (mode ${have.mode}, the repository's ${had.mode})`);
      else if (!git(repo, ['cat-file', 'blob', have.oid], 'buffer').equals(Buffer.from(expected, 'utf8'))) fails.push(`differs: ${path} (not the repository's own with only the kit's deny lines added)`);
      else {
        filled.add(path);
        merged.push(path);
      }
      continue;
    }
    let isOwn = had && (had.mode !== want.mode || had.oid !== want.oid);
    let older = false;
    // A filled-in file never equals its raw blob: the base is the repository's own unless it is the rendering now, or an older one.
    if (had && FILLED[path] && had.mode === want.mode) {
      const as = renderedAs({ factory, fac, path, text: blob(repo, had.oid), human });
      isOwn = as !== 'now';
      older = as === 'past';
    }
    const same = isOwn && have && have.mode === had.mode && have.oid === had.oid;
    // A file as an older kit had it, not the repository's own, when the pull request brings it to the kit's.
    if (isOwn && !same && !older && !FILLED[path]) older = pastBlobs(factory, fac, want.src).has(had.oid);
    // An older kit config with the adapter block after it is an older kit's too: it is laid anew with the block.
    if (path === CONFIG && isOwn && !same && !older && had.mode === want.mode) older = pastWithBlock(factory, fac, want.src, blob(repo, had.oid), blockFor(repo, now));
    if (!have) fails.push(`missing: ${path}`);
    else if (same) kept.push(path);
    else if (isOwn && !older) fails.push(`differs: ${path} (the repository's own, changed)`);
    else if (have.mode !== want.mode) fails.push(`differs: ${path} (mode ${have.mode}, the kit's ${want.mode})`);
    else if (path === CONFIG) {
      // The kit's text, with the adapter lines for the repository's own files when it has its own scripts/verify.
      const block = blockFor(repo, now);
      const text = blob(repo, have.oid);
      const kitText = blob(factory, want.oid);
      if (text !== kitText && text !== kitText + block) fails.push(`differs: ${path} (not the kit's text with the adapter lines for this repository)`);
      else if (text !== kitText) {
        filled.add(path);
        adapted.push(path);
        if (isOwn && older) updated.push(was(path, had.oid, 'kit'));
      } else {
        exact++;
        if (isOwn && older) updated.push(was(path, had.oid, 'kit'));
      }
    } else if (!FILLED[path]) {
      if (have.oid !== want.oid) fails.push(`differs: ${path} (content)`);
      else {
        exact++;
        if (isOwn && older) updated.push(was(path, had.oid, 'kit'));
      }
    } else {
      const from = blob(factory, want.oid);
      // The kit filled in with the settings the head's own text holds: a head that holds anything more fails.
      const values = { human, ...valuesOf(path, blob(repo, have.oid)) };
      if (path === '.gate/ruleset.json') {
        const driver = at.get('.gate/driver.json');
        values.mergeMethod = driver && JSON.parse(blob(repo, driver.oid)).merge === 'merge' ? 'merge' : 'squash';
      }
      const to = render(path, from, values);
      if (blob(repo, have.oid) !== to) fails.push(`differs: ${path} (content)`);
      else {
        filled.add(path);
        if (isOwn && older) updated.push(was(path, had.oid, 'kit'));
        const before = from.split('\n');
        to.split('\n').forEach((line, i) => line !== before[i] && rendered.push(`${path}:${i + 1}: \`${before[i]}\` → \`${line}\``));
      }
    }
  }
  // The instruction files. AGENTS.md and CLAUDE.md are the repository's own, so they are judged against the base and the
  // kit's block, not against a kit file; .gate/kit-commit is the factory commit.
  const instructions = [];
  const sectionEntry = kit.get(SECTION);
  const section = sectionEntry ? blob(factory, sectionEntry.oid) : null;
  if (section === null) fails.push(`missing: kit/${SECTION} at the factory commit`);
  const haveA = now.get('AGENTS.md');
  const hadA = at.get('AGENTS.md');
  if (!haveA) fails.push('missing: AGENTS.md');
  else if (!['100644', '100755'].includes(haveA.mode) || (hadA && hadA.mode !== haveA.mode)) fails.push(`differs: AGENTS.md (mode ${haveA.mode}${hadA ? `, the repository's ${hadA.mode}` : ''}; a regular file, as the repository had it)`);
  else if (section !== null) {
    const baseText = hadA && ['100644', '100755'].includes(hadA.mode) ? blob(repo, hadA.oid) : null;
    const text = blob(repo, haveA.oid);
    const verdict = judgeAgents({ text, baseText, section, name, own });
    for (const f of verdict.fails) fails.push(`differs: AGENTS.md (${f})`);
    if (!verdict.fails.length) {
      const how = baseText === null ? 'a title line and the block' : verdict.shown ? 'the repository\'s own text, from --own, with the block inserted' : "the repository's own text with the block, the rest as the base had it";
      instructions.push(`AGENTS.md: ${how} (${text.split('\n').length - (text.endsWith('\n') ? 1 : 0)} lines, ${Buffer.byteLength(text)} bytes)`);
      if (verdict.shown) instructions.push(`AGENTS.md: the repository's own text, ${verdict.shown.length} lines, shown in full (was ${hadA ? hadA.oid.slice(0, 12) : 'none'}):`, ...verdict.shown.map((l) => `  | ${l}`));
    }
  }
  const haveC = now.get('CLAUDE.md');
  const hadC = at.get('CLAUDE.md');
  if (!haveC) fails.push('missing: CLAUDE.md');
  else {
    for (const problem of carrierProblems({ mode: haveC.mode, bytes: haveC.mode === '120000' || ['100644', '100755'].includes(haveC.mode) ? git(repo, ['cat-file', 'blob', haveC.oid], 'buffer') : Buffer.alloc(0) })) fails.push(`differs: CLAUDE.md (${problem})`);
    if (hadC) {
      if (hadC.mode !== haveC.mode || hadC.oid !== haveC.oid) fails.push("differs: CLAUDE.md (the repository's own, which the kit leaves as it is)");
      else instructions.push(`CLAUDE.md: the repository's own, unchanged (mode ${haveC.mode})`);
    } else if (haveC.mode !== '100644' || blob(repo, haveC.oid) !== '@AGENTS.md\n') fails.push('differs: CLAUDE.md (the repository had none: the one-line import @AGENTS.md)');
    else instructions.push('CLAUDE.md: added, the one-line import');
  }
  // .gitattributes is the repository's own too: its text with the kit's review-categories block at the start.
  const categories = [];
  const blockEntry = kit.get(BLOCK_FILE);
  const kitBlock = blockEntry ? blob(factory, blockEntry.oid) : null;
  const haveG = now.get(ATTRIBUTES);
  const hadG = at.get(ATTRIBUTES);
  if (kitBlock === null) {
    // A factory commit from before the block: the kit has no lines for .gitattributes, so the pull request leaves it as it was.
    if (haveG?.oid !== hadG?.oid || haveG?.mode !== hadG?.mode) fails.push(`extra: ${ATTRIBUTES} (the kit at this factory commit holds no ${BLOCK_FILE}, so it is not the kit's to change)`);
  } else if (!haveG) fails.push(`missing: ${ATTRIBUTES}`);
  else if (!['100644', '100755'].includes(haveG.mode) || (hadG && hadG.mode !== haveG.mode)) fails.push(`differs: ${ATTRIBUTES} (mode ${haveG.mode}${hadG ? `, the repository's ${hadG.mode}` : ''}; a regular file, as the repository had it)`);
  else {
    const baseText = hadG ? blob(repo, hadG.oid) : null;
    const text = blob(repo, haveG.oid);
    const problems = judgeAttributes({ text, baseText, block: kitBlock });
    for (const f of problems) fails.push(`differs: ${ATTRIBUTES} (${f})`);
    if (!problems.length) categories.push(`${ATTRIBUTES}: ${baseText === null ? 'the block, nothing else' : "the repository's own lines, with the block at the start, the rest as the base had it"} (${text.split('\n').length - (text.endsWith('\n') ? 1 : 0)} lines)`);
  }
  const haveK = now.get(KIT_COMMIT);
  if (!haveK) fails.push(`missing: ${KIT_COMMIT}`);
  else if (haveK.mode !== '100644' || blob(repo, haveK.oid) !== `${fac}\n`) fails.push(`differs: ${KIT_COMMIT} (the factory commit ${fac} and a newline)`);
  const list = [...new Set([...kit.keys(), INVENTORY, KIT_COMMIT, ])].sort((a, b) => (a < b ? -1 : 1));
  const inventory = now.get(INVENTORY);
  if (!inventory) fails.push(`missing: ${INVENTORY}`);
  else if (inventory.mode !== '100644' || blob(repo, inventory.oid) !== `${list.join('\n')}\n`) fails.push(`differs: ${INVENTORY} (not the kit's inventory)`);
  const listed = new Set(at.get(INVENTORY) ? blob(repo, at.get(INVENTORY).oid).split('\n').filter(Boolean) : []);
  const changed = git(repo, ['diff', '--name-only', '-z', '--no-renames', baseSha, headSha]).split('\0').filter(Boolean);
  for (const path of changed) {
    if (kit.has(path) || [INVENTORY, KIT_COMMIT, ATTRIBUTES, ...INSTRUCTION_FILES].includes(path)) continue;
    const had = at.get(path);
    // The pack file of the old kit: the kit lays none now, so an update removes it.
    if (path === '.gate/pack' && had && !now.has(path)) {
      removed.push(was(path, had.oid, 'no longer laid; no pack'));
      continue;
    }
    // A file the kit dropped may go when the base lists it as the kit's and holds a blob the kit once had at that path.
    if (had && listed.has(path) && !now.has(path) && pastBlobs(factory, fac, `kit/${path}`).has(had.oid)) removed.push(was(path, had.oid, 'no longer in the kit'));
    else if (had && UNTOUCHED(path) && !listed.has(path)) fails.push(`differs: ${path} (the repository's own, which the kit leaves untouched)`);
    else fails.push(`extra: ${path} (not a kit file)`);
  }
  if (now.has('.gate/pack')) fails.push('extra: .gate/pack (the kit lays no pack file now)');
  // The gate's settings as the head's workflows hold them, and the runner rule over them (#335). One the head changes from
  // the base's is marked, so a pull request that moves the reviewer or a runner says so where the Human reads it.
  const settingsAt = (entries) => valuesIn(Object.fromEntries(WORKFLOWS.filter((p) => entries.get(p)?.mode === '100644').map((p) => [p, blob(repo, entries.get(p).oid)])));
  const settings = settingsAt(now);
  const before = settingsAt(at);
  const moved = Object.fromEntries(
    GATE_SETTINGS.filter((s) => at.has(s.file) && JSON.stringify(before[s.key]) !== JSON.stringify(settings[s.key] ?? DEFAULTS[s.key])).map((s) => [
      s.key,
      before[s.key] === undefined ? "CHANGED: the base held none in the kit's form (a repository variable, before #335)" : `CHANGED from ${shown(s.key, before[s.key])}`,
    ]),
  );
  for (const problem of runnerProblems(settings)) fails.push(`runners: ${problem} (kit/.gate/enforced-rules.md)`);
  // The repository's own scripts/ and hooks, which the kit does not ship: they are in the head as they were in the base.
  const untouched = [...at].filter(([path, e]) => UNTOUCHED(path) && !kit.has(path) && !listed.has(path) && now.get(path)?.oid === e.oid && now.get(path)?.mode === e.mode).map(([path]) => path).sort();
  const lines = [
    `kit-evidence: ${fails.length ? 'FAIL' : 'PASS'}`,
    `factory commit: ${fac}, kit tree ${kitTree}`,
    `repository: ${slug} (id ${id})`,
    `base: ${baseSha}`,
    `head: ${headSha}`,
    `managed files: ${kit.size + (kit.has(INVENTORY) ? 0 : 1) + 1}: ${exact} as in the kit, ${filled.size} rendered, ${kept.length} kept, 2 generated`,
  ];
  if (fails.length) lines.push('failures:', ...fails.map((f) => `  ${f}`));
  lines.push("instructions (the repository's own AGENTS.md and CLAUDE.md; the kit's part is the Gate block):", ...(instructions.length ? instructions.map((l) => `  ${l}`) : ['  none']));
  lines.push("review categories (the repository's own .gitattributes; the kit's part is the block at its start):", ...(categories.length ? categories.map((l) => `  ${l}`) : ['  none']));
  lines.push('rendered (bin/onboard fills these in):', ...(rendered.length ? rendered.map((l) => `  ${l}`) : ['  none']));
  lines.push("settings (the gate's, as the head's workflows hold them; a pull request changes one at tier 3):", ...describe(settings, moved).map((l) => `  ${l}`));
  if (merged.length) lines.push("merged (the repository's own file with the kit's deny lines inserted as text; every other byte is the base's):", ...merged.map((p) => `  ${p}`));
  if (adapted.length) lines.push("adapter (the kit's text with the lines bin/lib/adapter.mjs writes for the repository's own files):", ...adapted.map((p) => `  ${p}`));
  if (untouched.length) lines.push("untouched (the repository's own scripts/ and hooks, which the kit does not ship; unchanged):", ...untouched.map((p) => `  ${p}`));
  lines.push("kept (the repository's own, unchanged):", ...(kept.length ? kept.map((p) => `  ${p}`) : ['  none']));
  // Only bin/kit-update's pull requests make these two; a first onboarding's evidence has neither.
  if (updated.length) lines.push("updated (the base held an older kit file, or an older rendering, now the kit's):", ...updated.map((p) => `  ${p}`));
  if (removed.length) lines.push('removed (the base held an older kit file that is no longer laid):', ...removed.map((p) => `  ${p}`));
  return { pass: !fails.length, text: lines.join('\n') };
}

function main(argv) {
  const opt = {};
  // --own is the one flag: the AGENTS.md came from a file the repository prepared, so its text is shown in full.
  const rest = argv.filter((a) => a !== '--own');
  opt.own = rest.length !== argv.length;
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
  const need = ['factory', 'commit', 'repo', 'base', 'head', 'slug', 'id'];
  if (need.some((k) => !opt[k]) || !/^[A-Za-z0-9_=-]+$/.test(opt.id) || !/^[\w.-]+\/[\w.-]+$/.test(opt.slug)) {
    console.error('usage: bin/kit-evidence --factory <dir> --commit <rev> --repo <dir> --base <rev> --head <rev> --slug <owner/name> --id <repository id> [--human <login>] [--own]');
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
