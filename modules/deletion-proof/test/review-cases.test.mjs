// Every fixture of #17's four review rounds, against the deletion-proof module (#71): each is refused. The old proof read
// JavaScript line by line and the reviewers found a way through it four times; this one reads none, so each of their
// fixtures fails at the first thing it does: it edits, adds or retypes a source file, or deletes what the config's
// protection or knip's report does not vouch for. (review-cases.mjs holds the fixtures as the reviewers wrote them.)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { moduleRepo, report, fl } from './lib.mjs';
import { ROUND1, ROUND1B, ROUND2, ROUND3, ROUND4 } from './review-cases.mjs';

// The one fixture that is not a source change: a CSS rule is no source file under GATE_SOURCE, and red-check ignores it
// on main too (the reviewers' "not-source"); the deletion beside it is a listed whole file, which the module proves.
const NOT_SOURCE = /^CSS rule removed/;
// Round 1's B5 needs a knip that lists a file an honest one would not, which only a loosened config yields. The module
// refuses a config that .gate/protected does not name, so the fixture is refused at the base where it is unprotected.
const LOOSENED = /imported without its extension/;
const UNPROTECTED = { '.gate/protected': '/.gate/\n' };

describe('the fixtures of the four review rounds are refused', () => {
  let r;
  before(() => (r = moduleRepo({ 'src/lib.js': 'export const lib = 1;\n' })));
  after(() => r.cleanup());

  for (const [round, cases] of Object.entries({ 'round 1': ROUND1, 'round 1 (adv2)': ROUND1B, 'round 2': ROUND2, 'round 3': ROUND3, 'round 4': ROUND4 })) {
    describe(round, () => {
      for (const [name, c] of Object.entries(cases)) {
        test(name, () => {
          const base = LOOSENED.test(name) ? { ...c.base, ...UNPROTECTED } : c.base;
          const out = r.attempt({ base, head: c.head, knip: c.knip, symlink: c.symlink });
          if (NOT_SOURCE.test(name)) {
            assert.equal(out.code, 0, out.out);
            assert.match(out.out, /passed as a pure deletion/);
            return;
          }
          assert.equal(out.code, 1, out.out);
          assert.match(out.out, /^red-check: not a pure deletion: (config|check [123]): /m);
          assert.doesNotMatch(out.out, /passed/);
        });
      }
    });
  }

  test('the fixtures are all there: 96 cases from the four rounds', () => {
    assert.equal([ROUND1, ROUND1B, ROUND2, ROUND3, ROUND4].reduce((n, c) => n + Object.keys(c).length, 0), 96);
  });
});

describe('the tier and config fixtures of the rounds', () => {
  let r;
  before(() => (r = moduleRepo({ 'src/old.js': 'export const old = 1;\n' })));
  after(() => r.cleanup());
  const PJ = (entry) => `{\n  "name": "app",\n  "private": true,\n  "type": "module",\n  "knip": {\n    "entry": ${entry}\n  }\n}\n`;
  const listed = report(fl('src/old.js'));

  test('P: a multi-line "knip" block in package.json is no config the gate trusts: move it to knip.json', () => {
    const out = r.attempt({ base: { 'knip.json': null, 'package.json': PJ('["src/app.js"]') }, head: { 'src/old.js': null }, knip: listed });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /config: the knip config is in package\.json; move it to knip\.json for a machine proof/);
  });
  test('K: a JSON config whose "preprocessor" names a JS file that could rewrite knip\'s report is refused', () => {
    const out = r.attempt({ base: { 'knip.json': '{ "preprocessor": "./tools/knip-pre.js" }\n', 'tools/knip-pre.js': 'export default (o) => o;\n' }, head: { 'src/old.js': null }, knip: listed });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /config: knip\.json holds the key "preprocessor"/);
  });
  test('N10: a knip.ts that imports a file outside the gate\'s protection is refused whole', () => {
    const out = r.attempt({ base: { 'knip.json': null, 'knip.ts': "import base from './config/knip-base.js';\nexport default base;\n", 'config/knip-base.js': 'export default { entry: [] };\n' }, head: { 'src/old.js': null }, knip: listed });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /config: a JS or TS knip config can import files the gate does not protect/);
  });
});
