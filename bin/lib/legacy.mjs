// The old kit's AGENTS.md, which the repositories onboarded before #132 still hold: the kit's head (rendered with the
// repository's name), the pack's section, then the repository's own `## Layout` and `## Facts the code cannot tell`. A
// repository is "legacy" when its AGENTS.md, up to its `## Layout` line, is exactly what a factory commit reachable from
// the one being laid rendered from kit/AGENTS.md and packs/<pack>/section.md (or AGENTS.md, its name before #132). Its
// update drops that head, puts the Gate block in its place, and keeps every byte from `## Layout` on. Anything else is not
// known, and is refused: the kit does not guess where the repository's own text begins.
import { execFileSync } from 'node:child_process';

const LAYOUT = '## Layout';
const ANCHOR = '## What the Human keeps';
const GIT_MS = 60_000;

const show = (factory, rev, path) => {
  try {
    return execFileSync('git', ['-C', factory, 'cat-file', 'blob', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: GIT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/** The old kit's AGENTS.md with the pack's section right before ANCHOR (the old composition, frozen), or null when the
 * kit text has no such line. */
function composeOld(kit, section) {
  const lines = kit.split('\n');
  const at = lines.indexOf(ANCHOR);
  if (at < 0) return null;
  if (section === null) return lines;
  return [...lines.slice(0, at), ...section.replace(/\n+$/, '').split('\n'), '', ...lines.slice(at)];
}

/** What kit-update and the evidence make of a legacy AGENTS.md: `# <name>`, the block, a blank line, and the base's text
 * from its `## Layout` line to its last byte; or null when the base is not a rendering the old kit made. packName is the
 * repository's `.gate/pack` (pstack when it has none). */
export function legacyCompose({ factory, fac, baseText, name, packName = 'pstack', section }) {
  const baseLines = baseText.split('\n');
  const layoutAt = baseLines.indexOf(LAYOUT);
  if (layoutAt < 0) return null;
  const head = baseLines.slice(0, layoutAt);
  const packFiles = packName === 'none' ? [] : [`packs/${packName}/section.md`, `packs/${packName}/AGENTS.md`];
  const paths = ['kit/AGENTS.md', ...packFiles];
  const revs = [fac, ...execFileSync('git', ['-C', factory, '--literal-pathspecs', 'log', '--format=%H', fac, '--', ...paths], { encoding: 'utf8', timeout: GIT_MS }).split('\n').filter(Boolean)];
  for (const rev of revs) {
    const kit = show(factory, rev, 'kit/AGENTS.md');
    if (kit === null) continue;
    const sections = packFiles.length ? packFiles.map((p) => show(factory, rev, p)).filter((t) => t !== null) : [null];
    for (const pack of sections) {
      const old = composeOld(kit, pack);
      if (!old) continue;
      const rendered = old.map((l) => l.replace('<repo>', name));
      if (!rendered.includes(LAYOUT)) continue;
      const oldHead = rendered.slice(0, rendered.indexOf(LAYOUT));
      if (oldHead.length === head.length && oldHead.every((l, i) => l === head[i])) return { text: `# ${name}\n\n${section}\n${baseLines.slice(layoutAt).join('\n')}` };
    }
  }
  return null;
}
