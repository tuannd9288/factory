// The kit's core and its packs (#7): packs/<name>/ holds what exists only for one way of working, bin/lib/pack.mjs
// composes it with the core, and a repository names its pack in .gate/pack. The library loads inside each test, so a
// test fails on its own when the library or a pack file is missing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, commit, factory, git, quiet, repoWithKit, run, script, write } from './helpers.mjs';

const lib = () => import('../bin/lib/pack.mjs');
const read = (path) => readFileSync(join(factory, path), 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const packs = () => readdirSync(join(factory, 'packs')).filter((n) => lstatSync(join(factory, 'packs', n)).isDirectory()).sort();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// The sha256 of JSON.stringify(deny) for the kit's deny list at 8ca0e7a: the rules stay in the core, unchanged.
const TODAY_DENY = '21e727537fca50e0e30cb774e2c072d42cf17b9755c291617875d02b585fae5e';

describe('composing the core with a pack', () => {
  test('with no pack the core alone is valid: only the deny rules, and the kit\'s AGENTS.md as it is', async () => {
    const { composeAgents, composeSettings } = await lib();
    const settings = JSON.parse(composeSettings(read('kit/.claude/settings.json'), null));
    assert.deepEqual(Object.keys(settings), ['permissions']);
    assert.deepEqual(Object.keys(settings.permissions), ['deny']);
    assert.equal(sha256(JSON.stringify(settings.permissions.deny)), TODAY_DENY);
    const agents = composeAgents(read('kit/AGENTS.md'), null);
    assert.equal(agents, read('kit/AGENTS.md'));
  });

  test('the deny rules stay in the core: a pack with a permissions key is refused, and so is a key in both', async () => {
    const { composeSettings } = await lib();
    const kit = json({ permissions: { deny: ['Read(./.env*)'] }, env: { A: '1' } });
    assert.throws(() => composeSettings(kit, json({ permissions: { deny: [] } })), /deny rules stay in the kit's core/);
    assert.throws(() => composeSettings(kit, json({ env: { B: '2' } })), /env/);
    assert.equal(composeSettings(kit, json({ enabledPlugins: { x: true } })), json({ permissions: { deny: ['Read(./.env*)'] }, env: { A: '1' }, enabledPlugins: { x: true } }));
    for (const name of packs()) assert.equal(Object.hasOwn(JSON.parse(read(`packs/${name}/settings.json`)), 'permissions'), false, `packs/${name}/settings.json`);
  });

  test('a section goes right before "## What the Human keeps"; a section with no heading, or a part of the repository\'s own, is refused', async () => {
    const { composeAgents, ANCHOR } = await lib();
    assert.equal(ANCHOR, '## What the Human keeps');
    const kit = '# <repo>\n\nRules.\n\n## What the Human keeps\n\n- Tier 3.\n\n## Layout\n\nx\n\n## Facts the code cannot tell\n\ny\n';
    assert.equal(composeAgents(kit, '## Yields\n\nA rule.\n\n'), kit.replace('## What the Human keeps', '## Yields\n\nA rule.\n\n## What the Human keeps'));
    assert.equal(composeAgents(kit, null), kit);
    assert.throws(() => composeAgents('# <repo>\n\nRules.\n', '## Yields\n\n'), /## What the Human keeps/);
    assert.throws(() => composeAgents(kit, 'A rule with no heading.\n\n'), /## /);
    assert.throws(() => composeAgents(kit, '# Yields\n\n'), /## /);
    assert.throws(() => composeAgents(kit, '## Yields\n\n## Layout\n\nours\n\n'), /## Layout/);
    assert.throws(() => composeAgents(kit, '## Yields\n\n## Facts the code cannot tell\n\nours\n\n'), /## Facts the code cannot tell/);
  });

  test('every pack within the 150 lines composed, and the core alone too', async () => {
    const { composeAgents } = await lib();
    const kit = read('kit/AGENTS.md');
    assert.ok(composeAgents(kit, null).split('\n').length - 1 <= 150);
    assert.ok(packs().length >= 1, 'no pack under packs/');
    for (const name of packs()) assert.ok(composeAgents(kit, read(`packs/${name}/AGENTS.md`)).split('\n').length - 1 <= 150, name);
  });
});

describe('reading a pack', () => {
  const fake = () => {
    const dir = mkdtempSync(join(tmpdir(), 'packs-'));
    for (const name of ['zeta', 'alpha-2']) write(dir, { [`packs/${name}/settings.json`]: '{}\n', [`packs/${name}/AGENTS.md`]: `## ${name}\n\n` });
    return dir;
  };

  test('none is no pack; a name returns the text of its two files', async () => {
    const { readPack } = await lib();
    assert.equal(readPack(factory, 'none'), null);
    assert.deepEqual(readPack(factory, 'pstack'), { name: 'pstack', settings: read('packs/pstack/settings.json'), section: read('packs/pstack/AGENTS.md') });
  });

  test('an unknown name is refused, naming the packs there are, sorted', async () => {
    const { readPack } = await lib();
    const dir = fake();
    try {
      assert.throws(() => readPack(dir, 'nope'), new Error(`no pack nope in ${dir}/packs; there are: alpha-2, zeta`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a name that is not lower-case letters, digits and hyphens, starting with a letter, is refused before any path is built', async () => {
    const { readPack } = await lib();
    for (const name of ['', '../kit', 'Pstack', '-a', '1a', 'a b', 'a/b', '.']) assert.throws(() => readPack(factory, name), /pack/, JSON.stringify(name));
  });

  test('the command line prints the composed file, and on an error prints the message to stderr and exits 2', async () => {
    const cli = join(factory, 'bin/lib/pack.mjs');
    const { composeAgents, composeSettings } = await lib();
    let out = run(factory, 'node', [cli, 'agents', factory, 'pstack']);
    assert.equal(out.code, 0, out.out);
    assert.equal(out.out, composeAgents(read('kit/AGENTS.md'), read('packs/pstack/AGENTS.md')));
    out = run(factory, 'node', [cli, 'settings', factory, 'pstack']);
    assert.equal(out.out, composeSettings(read('kit/.claude/settings.json'), read('packs/pstack/settings.json')));
    out = run(factory, 'node', [cli, 'agents', factory, 'none']);
    assert.equal(out.out, read('kit/AGENTS.md'));
    out = run(factory, 'node', [cli, 'settings', factory, 'nope']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /no pack nope in .*\/packs; there are: pstack/);
    out = run(factory, 'node', [cli, 'frobnicate', factory, 'pstack']);
    assert.equal(out.code, 2, out.out);
  });
});

describe('the repository\'s choice', () => {
  test('.gate/pack is a tier-3 path: a pull request that changes it needs the Human', () => {
    assert.ok(read('kit/.gate/protected').split('\n').includes('/.gate/'));
    const r = repoWithKit();
    try {
      git(r.repo, 'switch', '-q', '-C', 't', 'origin/main');
      commit(r.repo, { '.gate/pack': 'none\n' }, 'change the pack');
      const out = script(r.repo, 'tier', ['--base', 'origin/main']);
      assert.match(out.out, /^tier 3\n {2}\.gate\/pack \(protected: \/\.gate\/\)/);
    } finally {
      r.cleanup();
    }
  });
});

describe('packs/pstack', () => {
  test('holds the pin as the installer writes it, and the rule under its own heading', () => {
    const settings = read('packs/pstack/settings.json');
    assert.equal(settings, json(JSON.parse(settings)));
    assert.deepEqual(Object.keys(JSON.parse(settings)), ['enabledPlugins', 'extraKnownMarketplaces']);
    const agents = read('packs/pstack/AGENTS.md');
    assert.ok(agents.startsWith('## Where pstack yields\n'));
    assert.ok(agents.endsWith('\n\n'), 'ends with the blank line before the next heading');
    assert.equal(agents.split('\n').filter((l) => l.startsWith('## ')).length, 1);
  });
});

describe('onboard --pack', () => {
  /** A seed repository with `files`, and beside it what bin/onboard needs (as in test/kit.test.mjs). */
  const seeded = (files = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pack-'));
    const seed = join(dir, 'seed');
    git(dir, 'init', '-q', '-b', 'main', seed);
    write(seed, { ...APP, ...files });
    commit(seed, {}, 'start');
    git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
    const onboard = (...args) =>
      run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr', ...args], {
        ...quiet,
        FACTORY_ROOT: join(dir, 'root'),
        AGENT_PROFILES: join(dir, 'profiles'),
        XDG_DATA_HOME: join(dir, 'xdg'),
        XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      });
    return { dir, repo: join(dir, 'root/app'), onboard, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };
  const repoText = (s, path) => readFileSync(join(s.repo, path), 'utf8');

  test('by default lays pstack: .gate/pack, the AGENTS.md and .claude/settings.json that compose gives, and lists .gate/pack as generated', async () => {
    const { composeAgents, composeSettings } = await lib();
    const s = seeded();
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(repoText(s, '.gate/pack'), 'pstack\n');
      assert.equal(repoText(s, 'AGENTS.md'), composeAgents(read('kit/AGENTS.md'), read('packs/pstack/AGENTS.md')).replace('<repo>', 'app'));
      // Independent of compose: the pack's section and its pin are in the files onboard wrote.
      assert.ok(repoText(s, 'AGENTS.md').includes(read('packs/pstack/AGENTS.md')));
      assert.deepEqual(JSON.parse(repoText(s, '.claude/settings.json')).enabledPlugins, JSON.parse(read('packs/pstack/settings.json')).enabledPlugins);
      assert.equal(repoText(s, '.claude/settings.json'), composeSettings(read('kit/.claude/settings.json'), read('packs/pstack/settings.json')));
      assert.ok(repoText(s, '.gate/kit-files').split('\n').includes('.gate/pack'));
    } finally {
      s.cleanup();
    }
  });

  test('--pack none lays settings with only permissions, and an AGENTS.md without the pack\'s section', () => {
    const s = seeded();
    try {
      const out = s.onboard('--pack', 'none');
      assert.equal(out.code, 0, out.out);
      assert.equal(repoText(s, '.gate/pack'), 'none\n');
      assert.deepEqual(Object.keys(JSON.parse(repoText(s, '.claude/settings.json'))), ['permissions']);
      const agents = repoText(s, 'AGENTS.md');
      assert.doesNotMatch(agents, /pstack yields/);
      assert.match(agents, /^## What the Human keeps$/m);
    } finally {
      s.cleanup();
    }
  });

  test('without --pack the repository\'s own .gate/pack is the default', () => {
    const s = seeded({ '.gate/pack': 'none\n' });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(repoText(s, '.gate/pack'), 'none\n');
      assert.deepEqual(Object.keys(JSON.parse(repoText(s, '.claude/settings.json'))), ['permissions']);
    } finally {
      s.cleanup();
    }
  });

  test('--pack nope is refused before anything is written, naming the packs there are', () => {
    const s = seeded();
    try {
      const out = s.onboard('--pack', 'nope');
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /^onboard: no pack nope in .*\/packs; there are: pstack; nothing done$/m);
      assert.ok(!existsSync(s.repo), 'cloned before refusing');
      assert.ok(!existsSync(join(s.dir, 'profiles')), 'a profile was made');
    } finally {
      s.cleanup();
    }
  });

  test('--own is checked against the composed AGENTS.md: the pack\'s lines count against the 150', async () => {
    const { composeAgents } = await lib();
    const s = seeded({ 'AGENTS.md': '# Our map\n' });
    try {
      const composed = composeAgents(read('kit/AGENTS.md'), read('packs/pstack/AGENTS.md')).split('\n').length - 1;
      const budget = 150 - (composed - 2);
      const long = `## Layout\n\n${'- a line\n'.repeat(budget)}\n## Facts the code cannot tell\n\n- one more\n`;
      writeFileSync(join(s.dir, 'own.md'), long);
      const out = s.onboard('--own', join(s.dir, 'own.md'));
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, new RegExp(`its two bodies are ${budget + 1} lines; the kit's AGENTS\\.md leaves room for ${budget} \\(at most 150 lines\\)`));
      assert.ok(!existsSync(s.repo), 'cloned before refusing');
    } finally {
      s.cleanup();
    }
  });
});

describe('onboard with a pack the repository already names', () => {
  const seededWith = (pack) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pack-'));
    const seed = join(dir, 'seed');
    git(dir, 'init', '-q', '-b', 'main', seed);
    write(seed, { ...APP, '.gate/pack': pack });
    commit(seed, {}, 'start');
    git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
    const env = { ...quiet, FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), XDG_DATA_HOME: join(dir, 'xdg'), XDG_CONFIG_HOME: join(dir, 'xdg-config') };
    return { dir, onboard: (...args) => run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr', ...args], env), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  test('refuses a .gate/pack that names a pack the factory lacks, and removes the clone it made', () => {
    const s = seededWith('nope\n');
    try {
      const out = s.onboard();
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /^onboard: \.gate\/pack: no pack nope in .*\/packs; there are: pstack; the clone is removed and nothing else was done$/m);
      assert.ok(!existsSync(join(s.dir, 'root/app')), 'the clone is left behind');
      assert.ok(!existsSync(join(s.dir, 'profiles')), 'a profile was made');
    } finally {
      s.cleanup();
    }
  });

  test('--pack over the repository\'s own .gate/pack wins, and the file is rewritten to it', () => {
    const s = seededWith('none\n');
    try {
      const out = s.onboard('--pack', 'pstack');
      assert.equal(out.code, 0, out.out);
      assert.equal(readFileSync(join(s.dir, 'root/app/.gate/pack'), 'utf8'), 'pstack\n');
      assert.match(readFileSync(join(s.dir, 'root/app/AGENTS.md'), 'utf8'), /^## Where pstack yields$/m);
    } finally {
      s.cleanup();
    }
  });
});

// Found by #7's review: .gate/pack and .gate/kit-files were written through a link the repository holds, so a link to a
// file outside the clone had that file overwritten.
import { mkdirSync, symlinkSync } from 'node:fs';

test('onboard replaces a .gate/pack or .gate/kit-files the repository holds as a link, never writing through it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-pack-link-'));
  try {
    const seed = join(dir, 'seed');
    git(dir, 'init', '-q', '-b', 'main', seed);
    write(seed, APP);
    mkdirSync(join(seed, '.gate'), { recursive: true });
    for (const name of ['pack', 'kit-files']) {
      writeFileSync(join(dir, `outside-${name}`), 'theirs\n');
      symlinkSync(join(dir, `outside-${name}`), join(seed, '.gate', name));
    }
    commit(seed, {}, 'start');
    git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
    const env = { ...quiet, FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), XDG_DATA_HOME: join(dir, 'xdg'), XDG_CONFIG_HOME: join(dir, 'xdg-config') };
    const out = run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr', '--pack', 'pstack'], env);
    assert.equal(out.code, 0, out.out);
    for (const name of ['pack', 'kit-files']) {
      assert.equal(readFileSync(join(dir, `outside-${name}`), 'utf8'), 'theirs\n', `onboard wrote through .gate/${name}`);
      assert.ok(!lstatSync(join(dir, 'root/app/.gate', name)).isSymbolicLink(), `.gate/${name} is still a link`);
    }
    assert.equal(readFileSync(join(dir, 'root/app/.gate/pack'), 'utf8'), 'pstack\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
