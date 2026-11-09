// bin/onboard and .gitattributes (#380): the kit puts its review-categories block at the start, the repository's own lines
// come after it and win, and a file that cannot take the block is refused with the clone removed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, git, quiet, run } from './helpers.mjs';
import { seeded } from './seed-world.mjs';

const KIT = readFileSync(join(factory, 'kit/.gate/review-categories'), 'utf8');
const blob = (s, path) => run(s.repo, 'git', ['show', `factory/kit:${path}`], quiet).out;
const tracked = (s, path) => git(s.repo, 'ls-tree', '--name-only', 'factory/kit', '--', path);

describe('bin/onboard writes the review-categories block into .gitattributes', () => {
  test('a repository with none gets a file of the block alone, and the kit file beside it', () => {
    const s = seeded({}, { own: false });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, '.gitattributes'), KIT);
      assert.equal(blob(s, '.gate/review-categories'), KIT);
      assert.match(blob(s, '.gate/kit-files'), /^\.gate\/review-categories$/m);
    } finally {
      s.cleanup();
    }
  });

  test('a repository with its own lines keeps every one, after the block', () => {
    const own = '*.png binary\n# the app\'s own\nsrc/** review-implementation\n';
    const s = seeded({ '.gitattributes': own }, { own: false });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, '.gitattributes'), `${KIT}\n${own}`);
    } finally {
      s.cleanup();
    }
  });

  test('a file that already starts with exactly the block gets no second one', () => {
    const done = `${KIT}\n*.png binary\n`;
    const s = seeded({ '.gitattributes': done }, { own: false });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(blob(s, '.gitattributes'), done);
    } finally {
      s.cleanup();
    }
  });

  test('refuses malformed or duplicate markers, a changed block and CRLF, and removes the clone', () => {
    const begin = KIT.split('\n')[0];
    const cases = [
      KIT.replace(/^# factory:review-categories:end.*\n/m, ''),
      `${KIT}\n${KIT}`,
      `${KIT.replace('review-documentation', 'review-assets')}\n*.png binary\n`,
      '*.png binary\r\n*.jpg binary\r\n',
      `*.png binary\n${begin}\n`,
    ];
    for (const text of cases) {
      const s = seeded({ '.gitattributes': text }, { own: false });
      try {
        const out = s.onboard();
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, /\.gitattributes/);
        assert.ok(!existsSync(s.repo), 'the clone is removed');
      } finally {
        s.cleanup();
      }
    }
  });

  test('refuses a .gitattributes that is a link, and removes the clone', () => {
    const s = seeded({}, { own: false, links: { '.gitattributes': 'AGENTS.md' } });
    try {
      const out = s.onboard();
      assert.equal(out.code, 2, out.out);
      assert.ok(!existsSync(s.repo));
    } finally {
      s.cleanup();
    }
  });

  test('a .gitignore that ignores .gitattributes does not keep it out of the kit commit', () => {
    const s = seeded({ '.gitignore': '.gitattributes\n' }, { own: false });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(tracked(s, '.gitattributes'), '.gitattributes');
      assert.equal(blob(s, '.gitattributes'), KIT);
      assert.equal(blob(s, '.gitignore'), '.gitattributes\n');
    } finally {
      s.cleanup();
    }
  });
});
