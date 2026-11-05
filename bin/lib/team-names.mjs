// Team nicknames ported from piggery v0.10.3 internal/core/names.go.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './checkout.mjs';
import { parseTeam } from './names.mjs';
import { readAccounts } from './token.mjs';
import { teamRows } from './teams.mjs';
import { leadTeams } from './top.mjs';

// The living-person block, elon through mira, is omitted: teams must not be named after real people.
// Every other reference word is retained in its original order.
export const WORDS = [
  'otter', 'badger', 'beaver', 'bison', 'camel', 'cobra', 'condor', 'crane', 'dingo', 'dolphin',
  'donkey', 'eagle', 'egret', 'falcon', 'ferret', 'finch', 'fox', 'gazelle', 'gecko', 'gerbil',
  'gibbon', 'goose', 'gopher', 'heron', 'hippo', 'ibis', 'iguana', 'impala', 'jackal', 'jaguar',
  'koala', 'lemur', 'leopard', 'lion', 'llama', 'lobster', 'lynx', 'magpie', 'mallard', 'manatee',
  'marmot', 'marten', 'meerkat', 'mink', 'mole', 'moose', 'narwhal', 'newt', 'ocelot', 'okapi',
  'oriole', 'osprey', 'ostrich', 'owl', 'panda', 'panther', 'parrot', 'pelican', 'penguin', 'pigeon',
  'plover', 'puffin', 'puma', 'quail', 'rabbit', 'raven', 'robin', 'salmon', 'seal', 'shark',
  'sparrow', 'squid', 'stork', 'swan', 'tapir', 'tiger', 'toucan', 'trout', 'turtle', 'walrus',
  'weasel', 'whale', 'wolf', 'wombat', 'wren', 'yak', 'zebra', 'bee', 'beetle', 'cricket',
  'moth', 'ant', 'hare', 'kiwi', 'lark', 'orca', 'pony', 'sloth', 'snail', 'tern',
  'toad', 'vole', 'acorn', 'alder', 'aspen', 'birch', 'cedar', 'clover', 'cypress', 'daisy',
  'fern', 'fig', 'ginkgo', 'hazel', 'holly', 'iris', 'ivy', 'juniper', 'larch', 'laurel',
  'lily', 'lotus', 'maple', 'moss', 'oak', 'olive', 'orchid', 'palm', 'pine', 'poppy',
  'reed', 'rose', 'rowan', 'sage', 'spruce', 'tulip', 'willow', 'yew', 'bamboo', 'basil',
  'cactus', 'lichen', 'lupin', 'mango', 'melon', 'peach', 'pear', 'plum', 'quince', 'thyme',
  'bay', 'beach', 'brook', 'canyon', 'cape', 'cliff', 'coast', 'cove', 'creek', 'delta',
  'dune', 'fjord', 'glade', 'glen', 'grove', 'gulf', 'harbor', 'heath', 'hill', 'island',
  'lagoon', 'lake', 'marsh', 'mesa', 'moor', 'oasis', 'ocean', 'pass', 'peak', 'plain',
  'pond', 'prairie', 'reef', 'ridge', 'river', 'shore', 'spring', 'stream', 'summit', 'tundra',
  'valley', 'vista', 'aurora', 'breeze', 'cloud', 'comet', 'dawn', 'dew', 'dusk', 'ember',
  'frost', 'galaxy', 'gale', 'glow', 'haze', 'horizon', 'meteor', 'mist', 'moon', 'nebula',
  'nova', 'orbit', 'planet', 'prism', 'quasar', 'rain', 'rainbow', 'shadow', 'sky', 'snow',
  'spark', 'star', 'storm', 'sun', 'thunder', 'tide', 'wave', 'wind', 'anchor', 'anvil',
  'arrow', 'atlas', 'banner', 'beacon', 'bell', 'bridge', 'button', 'candle', 'canoe', 'castle',
  'chalk', 'compass', 'copper', 'crystal', 'drum', 'feather', 'flag', 'flute', 'harp', 'noodle',
  'pickle', 'potato', 'waffle', 'taco', 'nugget', 'muffin', 'burrito', 'hamster', 'goblin', 'gremlin',
  'raccoon', 'pudding', 'toaster', 'duck', 'segfault', 'hotfix', 'kernel', 'cache', 'bug', 'nit',
  'lgtm', 'regex', 'yolo', 'nullptr', 'turing', 'hopper', 'lovelace', 'knuth', 'ritchie', 'dijkstra',
];

export function wordStart(key) {
  let hash = 14695981039346656037n;
  for (const byte of Buffer.from(key)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return Number(hash % BigInt(WORDS.length));
}

export function freeWord(key, taken) {
  const held = new Set(taken);
  const start = wordStart(key);
  for (let i = 0; i < WORDS.length; i++) {
    const word = WORDS[(start + i) % WORDS.length];
    if (!held.has(word)) return word;
  }
  // The reference falls back to numbered names; omit its dash to retain the team's grammar.
  for (let i = 2; ; i++) if (!held.has(`${WORDS[start]}${i}`)) return `${WORDS[start]}${i}`;
}

export function teamsOf(repo, { home = process.env.HOME, state = process.env.FACTORY_STATE ?? join(home, '.local/state/factory'), runs = process.env.FACTORY_RUNS ?? join(home, 'factory-runs'), root = ROOT, processes } = {}) {
  let folders = [];
  try { folders = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let sockets = [];
  try { sockets = readdirSync(join(state, 'lead-here')).filter((n) => n.endsWith('.socket')).map((n) => n.slice(0, -7)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const names = [...folders, ...sockets, ...Object.keys(readAccounts(state)).filter((r) => r.startsWith('factory/')).map((r) => r.slice(8)), ...teamRows(state, root).map((t) => t.name)];
  return [...new Set([...names.map(parseTeam).filter((t) => t?.repo === repo).map((t) => t.team), ...leadTeams(repo, processes)])].sort();
}

export function pickTeam(repo, options = {}) {
  const teams = teamsOf(repo, options);
  // A wake names a team that exists; only starting a Lead picks a new word.
  if (options.existing && teams.length === 0) throw new Error(`${repo} has no team`);
  if (options.newTeam || teams.length === 0) return freeWord(repo, teams);
  if (teams.length === 1) return teams[0];
  throw new Error(`${repo} has several teams: ${teams.join(', ')}; choose --team <name> or --new-team`);
}
