// A pack is what the kit holds only for one way of working: packs/<name>/settings.json (keys merged into the kit's
// .claude/settings.json) and packs/<name>/AGENTS.md (one "## " section placed before "## What the Human keeps"). The
// kit's core stays valid without one. A repository names its pack in .gate/pack, one line: the name, or "none". The
// functions are pure so that bin/onboard and bin/lib/evidence.mjs build the same files from the same texts; the deny
// rules and the repository's own Layout and Facts stay in the core, which no pack can write to.
//   node bin/lib/pack.mjs settings <factory> <pack>   prints the composed .claude/settings.json
//   node bin/lib/pack.mjs agents <factory> <pack>     prints the composed AGENTS.md (own parts not yet filled)
// On an error it prints the message to stderr and exits 2.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTS, LAYOUT } from './own.mjs';

export const PACK_FILE = '.gate/pack';
export const ANCHOR = '## What the Human keeps';
export const NAME = /^[a-z][a-z0-9-]*$/;

/** The pack a name chooses: `none` is null; otherwise the text of its two files, or an error naming the packs there are. */
export function readPack(factory, name) {
  if (name === 'none') return null;
  const dir = join(factory, 'packs');
  const names = () => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  if (!NAME.test(String(name)) || !names().includes(name)) throw new Error(`no pack ${name} in ${dir}; there are: ${names().join(', ')}`);
  return { name, settings: readFileSync(join(dir, name, 'settings.json'), 'utf8'), section: readFileSync(join(dir, name, 'AGENTS.md'), 'utf8') };
}

/** The kit's settings with the pack's keys after them. A pack cannot carry `permissions` or a key the kit has. */
export function composeSettings(kitText, packText) {
  const kit = JSON.parse(kitText);
  const pack = packText === null ? {} : JSON.parse(packText);
  if (Object.hasOwn(pack, 'permissions')) throw new Error("a pack's settings may not carry permissions: the deny rules stay in the kit's core");
  for (const key of Object.keys(pack)) if (Object.hasOwn(kit, key)) throw new Error(`the pack's settings and the kit's both carry ${key}`);
  return `${JSON.stringify({ ...kit, ...pack }, null, 2)}\n`;
}

/** The kit's AGENTS.md with the pack's section right before ANCHOR. The section may not hold the repository's own parts. */
export function composeAgents(kitText, sectionText) {
  if (sectionText === null) return kitText;
  const lines = kitText.split('\n');
  const at = lines.indexOf(ANCHOR);
  if (at < 0) throw new Error(`the kit's AGENTS.md has no line "${ANCHOR}" to place a pack's section before`);
  if (!sectionText.startsWith('## ')) throw new Error('a pack\'s AGENTS.md section must start with a "## " heading');
  for (const own of [LAYOUT, FACTS]) if (sectionText.split('\n').includes(own)) throw new Error(`a pack's AGENTS.md section may not hold "${own}": it is the repository's own`);
  const section = sectionText.replace(/\n+$/, '').split('\n');
  return [...lines.slice(0, at), ...section, '', ...lines.slice(at)].join('\n');
}

function main([what, factory, name]) {
  if (!['settings', 'agents'].includes(what) || !factory || !name) throw new Error('usage: node bin/lib/pack.mjs settings|agents <factory> <pack>');
  const pack = readPack(factory, name);
  const kit = (path) => readFileSync(join(factory, 'kit', path), 'utf8');
  process.stdout.write(what === 'settings' ? composeSettings(kit('.claude/settings.json'), pack?.settings ?? null) : composeAgents(kit('AGENTS.md'), pack?.section ?? null));
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
