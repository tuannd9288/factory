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

/** The first animal, in list order, that is not in taken; with all of them taken, the list again with a number (aardvark2). */
export function firstFree(taken) {
  const held = new Set(taken);
  for (let round = 1; ; round += 1) {
    const free = ANIMALS.map((a) => (round === 1 ? a : `${a}${round}`)).find((n) => !held.has(n));
    if (free) return free;
  }
}
