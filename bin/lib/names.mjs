// The names of the factory's sessions (#286): the animals of Ubuntu's release code names, so the Human knows an agent by a name a
// person remembers. The list is read at the source: https://wiki.ubuntu.com/Releases, which redirects to
// https://ubuntu.com/project/docs/release-team/list-of-releases/ (last modified 2026-10-17). Every released code name has one
// animal; the page's "future" T-Rex is not released and is left out.
export const ANIMALS = [
  'aardvark', 'badger', 'beaver', 'cuttlefish', 'dingo', 'drake', 'eft', 'ermine', 'fawn', 'fossa', 'gibbon', 'gorilla', 'hedgehog', 'heron', 'hippo',
  'ibex', 'indri', 'jackalope', 'jellyfish', 'koala', 'kudu', 'lobster', 'lynx', 'meerkat', 'minotaur', 'narwhal', 'numbat', 'ocelot', 'oriole',
  'pangolin', 'puffin', 'quetzal', 'quokka', 'raccoon', 'ringtail', 'salamander', 'stingray', 'tahr', 'unicorn', 'vervet', 'warthog', 'werewolf',
  'xerus', 'yak', 'zapus',
];

/** A Lead's team (#196): a letter, then at most 31 lowercase letters and digits. No `-` and no `/`, so `<repo>-<team>` splits at its
 * last `-`; a letter first, so it never matches a Lead's issue folder `<repo>-<n>`. Without --team, use the only team, pick a nickname when none exists, and refuse when several exist. */
export const TEAM = /^[a-z][a-z0-9]{0,31}$/;

/** `<repo>-<team>` (#311) split at its last `-`: { repo, team }, or null. The repo is a plain folder name (GitHub's characters, no `..`,
 * no `-` at its end); the team is in the TEAM grammar. Whether the repo is onboarded is not asked here. */
export function parseTeam(name) {
  if (typeof name !== 'string') return null;
  const i = name.lastIndexOf('-');
  if (i < 1) return null;
  const [repo, team] = [name.slice(0, i), name.slice(i + 1)];
  if (!TEAM.test(team) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) || repo.endsWith('-') || repo.includes('..')) return null;
  return { repo, team };
}

/** The first animal, in list order, that is not in taken; with all of them taken, the list again with a number (aardvark2). */
export function firstFree(taken) {
  const held = new Set(taken);
  for (let round = 1; ; round += 1) {
    const free = ANIMALS.map((a) => (round === 1 ? a : `${a}${round}`)).find((n) => !held.has(n));
    if (free) return free;
  }
}
