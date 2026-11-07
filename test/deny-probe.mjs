// What no agent may read, written apart from bin/lib/deny-read.mjs's list, so that taking an entry out of the list fails here: a literal
// table of protected categories and of reads the work needs, each with the channels that must refuse it. A probe makes synthetic files in a
// temporary home and work folder (never a credential) and asks, for each channel, whether its rendered rules refuse each file. The matchers
// follow each harness's matching rules as the factory reads them; Claude Code's own matching and a live `codex sandbox` run are not shown here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Every channel a probe can ask: Claude Code's file tools of a seat, the pack Lead, the MacBook Lead, Colly and a served repository (kit),
 * the seats' shell sandbox, and Codex. */
export const CHANNELS = ['seat file', 'lead file', 'here file', 'colly file', 'kit file', 'seat shell', 'codex'];
const ALL = CHANNELS;
const FACTORY_FILE_TOOLS = ['seat file', 'lead file', 'here file', 'colly file'];

/** [what, path under home (or `./` under the work folder), the channels that refuse it]. */
export const ROWS = [
  ['ssh keys', '.ssh/id_ed25519', ALL],
  ["gh's login", '.config/gh/hosts.yml', ALL],
  ['the Team API key file', '.config/claude-credit/anthropic.env', ALL],
  ["Claude Code's login", '.claude/.credentials.json', ALL],
  ["Claude Code's config", '.claude.json', ALL],
  ['a spare Claude home', '.claude-acc2/.credentials.json', ALL],
  ["Codex's login", '.codex/auth.json', ALL],
  ['another Codex home', '.codex-verifier/auth.json', ALL],
  ["a team's token", '.agent-profiles/tokens/team-a', ALL],
  ["seat 1's old token file", '.agent-profiles/seats/1/oauth-token', ALL],
  ["Claude Code's data", '.local/share/claude/versions/2.1.319', ALL],
  ["Cursor's login", '.cursor/cli-config.json', ALL],
  ["a repository's .env file, which its tests may load in a seat's shell", './.env', ALL.filter((c) => c !== 'seat shell')],
  // All of ~/.config is denied to the factory's own file tools; the shells, Codex and the kit name its stores (INN-39, question 1).
  ["another tool's login under ~/.config", '.config/some-tool/token', FACTORY_FILE_TOOLS],
  ["git's own settings, which git reads in a shell", '.config/git/config', FACTORY_FILE_TOOLS],
  ["git's settings in home", '.gitconfig', []],
  ["a file of the repository", './README.md', []],
  ['a plugin of the cache outside the profiles', '.local/share/factory/plugins/p/skills/s/SKILL.md', []],
  ["a Lead's transcript copy, its own", 'factory-runs/app-lead/transcripts/s.jsonl', ['seat file']],
  ["a seat's own run log", 'factory-runs/issue-1/run-worker.jsonl', []],
  ["Colly's own profile", '.local/state/factory/colly/profile/settings.json', []],
];

/** A temporary home and work folder holding a synthetic file at each row's path. */
export function probeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'deny-probe-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  const at = (rel) => (rel.startsWith('./') ? join(work, rel.slice(2)) : join(home, rel));
  for (const [, rel] of ROWS) {
    mkdirSync(dirname(at(rel)), { recursive: true });
    writeFileSync(at(rel), 'SYNTHETIC: not a credential\n');
  }
  return { home, work, at, done: () => rmSync(root, { recursive: true, force: true }) };
}

const glob = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');

/** Whether one of Claude Code's Read rules refuses `path`: `~/` is home, `//` the root, `./` the work folder; `*` is one path part, `**` any. */
export const refusedRead = (rules, path, { home, work }) => rules.some((rule) => {
  const m = /^Read\((.*)\)$/.exec(rule);
  if (!m) return false;
  const p = m[1];
  const abs = p.startsWith('~/') ? home + p.slice(1) : p.startsWith('//') ? p.slice(1) : p.startsWith('./') ? work + p.slice(1) : null;
  return abs !== null && new RegExp(`^${glob(abs)}$`).test(path);
});

/** Whether the seats' sandbox refuses `path`: a denied path refuses itself and all it holds; `*` is one path part. */
export const refusedSandbox = (paths, path) => paths.some((p) => new RegExp(`^${glob(p)}(?:/.*)?$`).test(path));

/** Whether Codex's profile refuses `path`: a plain path refuses itself and all it holds; a glob only what it names, so `<glob>/**` is its
 * own entry; `/**` at the start is any folder. */
export const refusedCodex = (paths, path) => paths.some((p) => {
  if (p.startsWith('/**/')) return new RegExp(`^/(?:.*/)?${glob(p.slice(4))}$`).test(path);
  if (p.endsWith('/**')) return new RegExp(`^${glob(p.slice(0, -3))}/.*$`).test(path);
  return new RegExp(p.includes('*') ? `^${glob(p)}$` : `^${glob(p)}(?:/.*)?$`).test(path);
});

/** The rows where a channel refuses what it should read or reads what it should refuse, one line each: [] when every channel agrees. */
export function mismatches(checks, world) {
  const out = [];
  for (const [what, rel, refusing] of ROWS) {
    for (const [channel, refuses] of Object.entries(checks)) {
      const want = refusing.includes(channel);
      if (refuses(world.at(rel)) !== want) out.push(`${channel}: ${what} (${rel}) is ${want ? 'readable' : 'refused'}`);
    }
  }
  return out;
}
