// The fixtures of #17's four review rounds (the reviewers' adv*.mjs, kept as they wrote them): for each, the files of the
// base, the files of the head, the report an honest knip would give, and what the reviewer made of the old proof.
// They are data; test/review-cases.test.mjs runs them against the deletion-proof module. Round 1 is the review of
// 2b8e7bc, round 2 of 8da70a4, round 3 of aedffb0, round 4 of a2f6aa4.
import { entry, ex, fl, report } from './lib.mjs';

const SERVER = "import { app, auth, register } from './server.js';\n";
const server = { 'src/server.js': 'export const app = { use() {} };\nexport const auth = 1;\nexport function register() {}\n' };

export const ROUND1 = {
  'guard after a block comment, in a used function, plus an unused file deleted': {
    base: { 'src/h.js': 'export function handler(req) {\n  if (!req.user) return 401;\n  /* authz */ if (!authorized(req)) return 403;\n  return 200;\n}\n', 'src/dead.js': 'export const dead = 1;\n' },
    head: { 'src/h.js': 'export function handler(req) {\n  if (!req.user) return 401;\n  return 200;\n}\n', 'src/dead.js': null },
    knip: report(fl('src/dead.js')),
    should: false,
  },
  'guard block opened after a block comment': {
    base: { 'src/h.js': 'export function handler(req) {\n  /* authz */ if (!authorized(req)) {\n    return 403;\n  }\n  return 200;\n}\n', 'src/dead.js': 'export const dead = 1;\n' },
    head: { 'src/h.js': 'export function handler(req) {\n  return 200;\n}\n', 'src/dead.js': null },
    knip: report(fl('src/dead.js')),
    should: false,
  },
  'guard on a line that starts inside a multi-line block comment': {
    base: { 'src/h.js': 'export function handler(req) {\n  /*\n   * authz */ if (!authorized(req)) return 403;\n  return 200;\n}\n', 'src/dead.js': 'export const dead = 1;\n' },
    head: { 'src/h.js': 'export function handler(req) {\n  return 200;\n}\n', 'src/dead.js': null },
    knip: report(fl('src/dead.js')),
    should: false,
  },
  'top-level app.use after a comment, beside an unused export': {
    base: { 'src/app.js': "import { app, auth } from './server.js';\n/* auth */ app.use(auth);\nexport const unusedC = 1;\n" },
    head: { 'src/app.js': "import { app, auth } from './server.js';\n" },
    knip: report(ex('src/app.js', 'unusedC')),
    should: false,
  },
  'side effect after the export on the same line': {
    base: { 'src/app.js': "import { app, auth } from './server.js';\nexport const unusedC = 1; app.use(auth);\n" },
    head: { 'src/app.js': "import { app, auth } from './server.js';\n" },
    knip: report(ex('src/app.js', 'unusedC')),
    should: false,
  },
  'side effect after the closing brace of the export': {
    base: { 'src/app.js': "import { app, auth } from './server.js';\nexport function unusedC() {\n  return 1;\n} app.use(auth);\n" },
    head: { 'src/app.js': "import { app, auth } from './server.js';\n" },
    knip: report(ex('src/app.js', 'unusedC')),
    should: false,
  },
  'side effect in the initializer of an unused export (inside the settled rule)': {
    base: { 'src/app.js': "import { app, auth } from './server.js';\nexport const unusedC = app.use(auth);\n" },
    head: { 'src/app.js': "import { app, auth } from './server.js';\n" },
    knip: report(ex('src/app.js', 'unusedC')),
    should: 'settled',
  },
  'export const a, b where b is imported elsewhere': {
    base: { 'src/lib.js': 'export const unusedA = 1, usedB = 2;\nexport const keep = 3;\n', 'src/use.js': "import { usedB } from './lib.js';\nexport const v = usedB;\n" },
    head: { 'src/lib.js': 'export const keep = 3;\n' },
    knip: report(ex('src/lib.js', 'unusedA')),
    should: false,
  },
  'export line text inside a template literal, removed with the real export': {
    base: { 'src/gen.js': 'export const unusedC = 1;\nexport function banner() {\n  return `\nexport const unusedC = 1;\n`;\n}\n' },
    head: { 'src/gen.js': 'export function banner() {\n  return `\n`;\n}\n' },
    knip: report(ex('src/gen.js', 'unusedC')),
    should: false,
  },
  'keyword-only edit of a line inside a template literal': {
    base: { 'src/gen.js': 'export const unusedC = 1;\nexport function banner() {\n  return `\nexport const unusedC = 1;\n`;\n}\n' },
    head: { 'src/gen.js': 'export const unusedC = 1;\nexport function banner() {\n  return `\nconst unusedC = 1;\n`;\n}\n' },
    knip: report(ex('src/gen.js', 'unusedC')),
    should: false,
  },
  'JSX pragma comment removed beside an unused export': {
    base: { 'src/view.jsx': "/** @jsx h */\nimport { h } from 'preact';\nexport const View = () => <p>hi</p>;\nexport const unusedC = 1;\n" },
    head: { 'src/view.jsx': "import { h } from 'preact';\nexport const View = () => <p>hi</p>;\n" },
    knip: report(ex('src/view.jsx', 'unusedC')),
    should: false,
  },
  'comment-only hunk inside a used function, plus an unused file': {
    base: { 'src/h.js': 'export function f() {\n  // istanbul ignore next\n  return 1;\n}\n', 'src/dead.js': 'export const dead = 1;\n' },
    head: { 'src/h.js': 'export function f() {\n  return 1;\n}\n', 'src/dead.js': null },
    knip: report(fl('src/dead.js')),
    should: 'harmless',
  },
  'guard deleted inside a used function (plain)': {
    base: { 'src/h.js': 'export function handler(req) {\n  if (!authorized(req)) return 403;\n  return 200;\n}\nexport const unusedC = 1;\n' },
    head: { 'src/h.js': 'export function handler(req) {\n  return 200;\n}\n' },
    knip: report(ex('src/h.js', 'unusedC')),
    should: false,
  },
  'top-level register() call deleted beside an unused export': {
    base: { 'src/r.js': "import { register } from './reg.js';\nregister('x');\nexport const unusedC = 1;\n" },
    head: { 'src/r.js': "import { register } from './reg.js';\n" },
    knip: report(ex('src/r.js', 'unusedC')),
    should: false,
  },
  'removed export used through a computed dynamic import': {
    base: { 'src/plug.js': 'export function onLoad() {\n  return 1;\n}\nexport const keep = 1;\n', 'src/loader.js': "export const load = async (n) => (await import(`./${n}.js`))['on' + 'Load']();\n" },
    head: { 'src/plug.js': 'export const keep = 1;\n' },
    knip: report(ex('src/plug.js', 'onLoad')),
    should: 'reviewer',
  },
  'default export deleted': {
    base: { 'src/d.js': 'export const keep = 1;\nexport default function () {\n  return 1;\n}\n' },
    head: { 'src/d.js': 'export const keep = 1;\n' },
    knip: report(ex('src/d.js', 'default')),
    should: 'either',
  },
  're-export star removed': {
    base: { 'src/index.js': "export * from './a.js';\nexport const keep = 1;\n", 'src/a.js': 'export const a1 = 1;\n' },
    head: { 'src/index.js': 'export const keep = 1;\n' },
    knip: report(ex('src/index.js', 'a1')),
    should: false,
  },
  'export keyword removed from a name another file imports': {
    base: { 'src/lib.js': 'export const shared = 1;\nexport const keep = 2;\n', 'src/use.js': "import { shared } from './lib.js';\nexport const v = shared;\n" },
    head: { 'src/lib.js': 'const shared = 1;\nexport const keep = 2;\n' },
    knip: report(ex('src/lib.js', 'shared')),
    should: false,
  },
  'class member removed': {
    base: { 'src/c.js': 'export class C {\n  used() {\n    return 1;\n  }\n  unusedM() {\n    return 2;\n  }\n}\n' },
    head: { 'src/c.js': 'export class C {\n  used() {\n    return 1;\n  }\n}\n' },
    knip: report(entry('src/c.js', { classMembers: [{ name: 'unusedM' }] })),
    should: false,
  },
  'object literal entry removed inside an export': {
    base: { 'src/o.js': 'export const cfg = {\n  a: 1,\n  strict: true,\n};\nexport const unusedC = 1;\n' },
    head: { 'src/o.js': 'export const cfg = {\n  a: 1,\n};\n' },
    knip: report(ex('src/o.js', 'unusedC')),
    should: false,
  },
  'TS enum removed (runtime object)': {
    base: { 'src/e.ts': 'export enum Unused {\n  A,\n  B,\n}\nexport const keep = 1;\n' },
    head: { 'src/e.ts': 'export const keep = 1;\n' },
    knip: report(ex('src/e.ts', 'Unused')),
    should: true,
  },
  'TS declare global block removed': {
    base: { 'src/g.ts': 'declare global {\n  interface Window { x: number }\n}\nexport const unusedC = 1;\n' },
    head: { 'src/g.ts': '' },
    knip: report(ex('src/g.ts', 'unusedC')),
    should: false,
  },
  'decorated class removed': {
    base: { 'src/k.ts': "import { register } from './reg';\n@register\nexport class UnusedK {}\nexport const keep = 1;\n" },
    head: { 'src/k.ts': "import { register } from './reg';\nexport const keep = 1;\n" },
    knip: report(ex('src/k.ts', 'UnusedK')),
    should: false,
  },
  'decorated class with static block (inside the settled rule)': {
    base: { 'src/k.js': "import { registry } from './reg.js';\nexport class UnusedK {\n  static {\n    registry.add(this);\n  }\n}\nexport const keep = 1;\n" },
    head: { 'src/k.js': "import { registry } from './reg.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/k.js', 'UnusedK')),
    should: 'settled',
  },
  'hunk across an unused export and a used one': {
    base: { 'src/two.js': 'export const unusedC = 1;\nexport const used = 2;\n', 'src/u.js': "import { used } from './two.js';\nexport const v = used;\n" },
    head: { 'src/two.js': '' },
    knip: report(ex('src/two.js', 'unusedC')),
    should: false,
  },
  'side-effect import line removed beside an unused export': {
    base: { 'src/main.js': "import './polyfill.js';\nexport const unusedC = 1;\nexport const keep = 1;\n", 'src/polyfill.js': 'globalThis.x = 1;\n' },
    head: { 'src/main.js': 'export const keep = 1;\n' },
    knip: report(ex('src/main.js', 'unusedC')),
    should: false,
  },
  'CSS rule removed, with an unused file deleted': {
    base: { 'src/a.css': '.btn { display: none; }\n.x { color: red; }\n', 'src/dead.js': 'export const dead = 1;\n' },
    head: { 'src/a.css': '.x { color: red; }\n', 'src/dead.js': null },
    knip: report(fl('src/dead.js')),
    should: 'not-source',
  },
  'two consts in one export statement on separate lines (multi-line var)': {
    base: { 'src/lib.js': 'export const unusedA = 1,\n  usedB = 2;\nexport const keep = 3;\n', 'src/use.js': "import { usedB } from './lib.js';\nexport const v = usedB;\n" },
    head: { 'src/lib.js': 'export const keep = 3;\n' },
    knip: report(ex('src/lib.js', 'unusedA')),
    should: false,
  },
  'two statements on one export line: function then const': {
    base: { 'src/lib.js': 'export function unusedA() {} export const usedB = 2;\nexport const keep = 3;\n', 'src/use.js': "import { usedB } from './lib.js';\nexport const v = usedB;\n" },
    head: { 'src/lib.js': 'export const keep = 3;\n' },
    knip: report(ex('src/lib.js', 'unusedA')),
    should: false,
  },
  'knip item with a namespace for the same name': {
    base: { 'src/ns.ts': 'export namespace NS {\n  export const x = 1;\n}\nexport const keep = 1;\n' },
    head: { 'src/ns.ts': 'export const keep = 1;\n' },
    knip: report(entry('src/ns.ts', { exports: [{ name: 'NS' }] })),
    should: true,
  },
  'knip exits 0 with an empty report while a file is deleted': {
    base: { 'src/dead.js': 'export const dead = 1;\n' },
    head: { 'src/dead.js': null },
    knip: '{"files":["src/dead.js"],"issues":[]}',
    should: false,
  },
  'knip v5-shaped report (top-level files array)': {
    base: { 'src/dead.js': 'export const dead = 1;\n' },
    head: { 'src/dead.js': null },
    knip: JSON.stringify({ files: ['src/dead.js'], issues: [{ file: 'src/dead.js', files: true, exports: [] }] }),
    should: false,
  },
};

// Round 1's second runner, adv2.mjs, adds two cases of its own; the rest of its list repeats round 1.
export const ROUND1B = {
  'two keyword-only removals that swap the order of side effects': {
    base: { 'src/o.js': "import { f, g } from './fx.js';\nexport const sideAq = f();\nexport const sideBq = g();\nexport const keep = sideAq + sideBq;\n" },
    head: { 'src/o.js': "import { f, g } from './fx.js';\nconst sideBq = g();\nconst sideAq = f();\nexport const keep = sideAq + sideBq;\n" },
    knip: report(ex('src/o.js', 'sideAq', 'sideBq')),
    should: false,
  },
  'deleted file imported without its extension (knip config loosened, lists it)': {
    base: { 'src/old.js': 'export const old = 1;\n', 'src/use.js': "import { old as o } from './old';\nexport const v = o;\n" },
    head: { 'src/old.js': null },
    knip: report(fl('src/old.js')),
    should: false,
  },
};

export const ROUND2 = {
  'R1 regex /{/ desyncs depth: top-level app.use and a used export removed between two functions': {
    base: { 'src/r.js': "import { app, auth } from './server.js';\nexport function unusedRf() { return /{/; }\napp.use(auth);\nexport function usedRg() { return /}/; }\nexport const keep = 1;\n", 'src/u.js': "import { usedRg } from './r.js';\nexport const v = usedRg;\n" },
    head: { 'src/r.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/r.js', 'unusedRf')),
    should: false,
  },
  'R2 regex with a backtick desyncs the template: keyword-only edit inside a real template': {
    base: { 'src/gen.js': "export const unusedTc = 1;\nconst re = /`/; export function banner() { return re && `\nexport const unusedTc = 1;\n`; }\n" },
    head: { 'src/gen.js': "export const unusedTc = 1;\nconst re = /`/; export function banner() { return re && `\nconst unusedTc = 1;\n`; }\n" },
    knip: report(ex('src/gen.js', 'unusedTc')),
    should: false,
  },
  'R3 regex /x\\/*/ opens a fake block comment over a top-level call': {
    base: { 'src/r.js': "import { app, auth } from './server.js';\nexport function unusedRf() { return /x\\/*/; }\napp.use(auth);\n/* end */ export function unusedRg() { return /}/; }\nexport const keep = 1;\n" },
    head: { 'src/r.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/r.js', 'unusedRf', 'unusedRg')),
    should: false,
  },
  'D1 arrow then a call on one line': {
    base: { 'src/a.js': "import { g } from './g.js';\nexport const unusedAf = (a) => a; g();\nexport const keep = 1;\n" },
    head: { 'src/a.js': "import { g } from './g.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/a.js', 'unusedAf')),
    should: false,
  },
  'D2 function then a call after the closing brace, no semicolon': {
    base: { 'src/a.js': "import { g } from './g.js';\nexport function unusedAf() {} g()\nexport const keep = 1;\n" },
    head: { 'src/a.js': "import { g } from './g.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/a.js', 'unusedAf')),
    should: false,
  },
  'D3 TS return type after ) then a call after the body': {
    base: { 'src/a.ts': "import { g } from './g';\nexport function unusedAf(): void {}; g();\nexport const keep = 1;\n" },
    head: { 'src/a.ts': "import { g } from './g';\nexport const keep = 1;\n" },
    knip: report(ex('src/a.ts', 'unusedAf')),
    should: false,
  },
  'D4 arrow whose body is a parenthesised call then a call': {
    base: { 'src/a.js': "import { g } from './g.js';\nexport const unusedAf = () => (1)\n;[g()]\nexport const keep = 1;\n" },
    head: { 'src/a.js': "import { g } from './g.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/a.js', 'unusedAf')),
    should: false,
  },
  'C1 spread in an initializer runs an iterator at load': {
    base: { 'src/c.js': "import { registry } from './reg.js';\nexport const unusedSp = [...registry];\nexport const keep = 1;\n" },
    head: { 'src/c.js': "import { registry } from './reg.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/c.js', 'unusedSp')),
    should: 'rule C list (spread not named)',
  },
  'C2 property read in an initializer (getter) at load': {
    base: { 'src/c.js': "import { cfg } from './cfg.js';\nexport const unusedPr = cfg.load;\nexport const keep = 1;\n" },
    head: { 'src/c.js': "import { cfg } from './cfg.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/c.js', 'unusedPr')),
    should: 'rule C list (getter not named)',
  },
  'C3 class extends a property read': {
    base: { 'src/c.js': "import { mix } from './mix.js';\nexport class UnusedCx extends mix.Base {}\nexport const keep = 1;\n" },
    head: { 'src/c.js': "import { mix } from './mix.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/c.js', 'UnusedCx')),
    should: 'rule C list',
  },
  'C4 arrow with an immediately-invoked tail via template tag on next line': {
    base: { 'src/c.js': "export const unusedTt = (a) => a\n`x`;\nexport const keep = 1;\n" },
    head: { 'src/c.js': 'export const keep = 1;\n' },
    knip: report(ex('src/c.js', 'unusedTt')),
    should: false,
  },
  'C5 enum member initialised from a property read': {
    base: { 'src/e.ts': "import { cfg } from './cfg';\nexport enum UnusedEn {\n  A = cfg.a,\n}\nexport const keep = 1;\n" },
    head: { 'src/e.ts': "import { cfg } from './cfg';\nexport const keep = 1;\n" },
    knip: report(ex('src/e.ts', 'UnusedEn')),
    should: 'rule C list',
  },
  'C6 initialiser with a comment hiding a call from rule C': {
    base: { 'src/c.js': "import { g } from './g.js';\nexport const unusedCm = /* x */ g /* y */ ``;\nexport const keep = 1;\n" },
    head: { 'src/c.js': "import { g } from './g.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/c.js', 'unusedCm')),
    should: false,
  },
  'C7 string-keyed static in a class': {
    base: { 'src/c.js': "import { reg } from './reg.js';\nexport class UnusedSk {\n  'static' = 1;\n}\nexport const keep = 1;\n" },
    head: { 'src/c.js': "import { reg } from './reg.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/c.js', 'UnusedSk')),
    should: true,
  },
  'C8 static after a newline-split class body (static on its own line)': {
    base: { 'src/c.js': "import { reg } from './reg.js';\nexport class UnusedSb\n{\n  static\n  x = reg.add(1);\n}\nexport const keep = 1;\n" },
    head: { 'src/c.js': "import { reg } from './reg.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/c.js', 'UnusedSb')),
    should: false,
  },
};

export const ROUND3 = {
  'M1 keyword as a member name (s.new) read as a regex start: top-level call and a used export removed': {
    base: { 'src/m.js': "import { app, auth } from './server.js';\nexport function unusedRf(s, t) { return Math.round(s.new / t) / 2; }\napp.use(auth);\nexport function usedRg(s, t, f) { return s.new / f(t(1) / 2); }\nexport const keep = 1;\n", 'src/u.js': "import { usedRg } from './m.js';\nexport const v = usedRg;\n" },
    head: { 'src/m.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/m.js', 'unusedRf')),
    should: false,
  },
  'M2 postfix ++ then division read as a regex': {
    base: { 'src/m.js': "import { app, auth } from './server.js';\nexport function unusedRf(i, w) { return Math.floor(i++ / w) / 2; }\napp.use(auth);\nexport function unusedRh(i, f, g) { return i++ / f(g(1) / 2); }\nexport const keep = 1;\n" },
    head: { 'src/m.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/m.js', 'unusedRf', 'unusedRh')),
    should: false,
  },
  'M3 identifier named of': {
    base: { 'src/m.js': "import { app, auth } from './server.js';\nexport function unusedRf(of, w) { return Math.floor(of / w) / 2; }\napp.use(auth);\nexport function unusedRh(of, f, g) { return of / f(g(1) / 2); }\nexport const keep = 1;\n" },
    head: { 'src/m.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/m.js', 'unusedRf', 'unusedRh')),
    should: false,
  },
  'J1 JSX closing tag then a // comment: a top-level call on the same line': {
    base: { 'src/view.jsx': "import { app, auth } from './server.js';\nexport function UnusedJ() { return <b>1</b>; } app.use(auth); //}\nexport const keep = 1;\n" },
    head: { 'src/view.jsx': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/view.jsx', 'UnusedJ')),
    should: false,
  },
  'T1 nested template in ${} desyncs depth': {
    base: { 'src/t.js': "import { app, auth } from './server.js';\nexport function unusedRf() { return `${`{`}`; }\napp.use(auth);\nexport function usedRg() { return `${`}`}`; }\nexport const keep = 1;\n", 'src/u.js': "import { usedRg } from './t.js';\nexport const v = usedRg;\n" },
    head: { 'src/t.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/t.js', 'unusedRf')),
    should: false,
  },
  'T2 a backtick in a string in ${} ends the template early: keyword-only edit inside the real template': {
    base: { 'src/t.js': "export const unusedTc = 1;\nexport const banner = () => `${'`'}\nexport const unusedTc = 1;\n`;\n" },
    head: { 'src/t.js': "export const unusedTc = 1;\nexport const banner = () => `${'`'}\nconst unusedTc = 1;\n`;\n" },
    knip: report(ex('src/t.js', 'unusedTc')),
    should: false,
  },
  'T3 same, whole removal of the real export and the template line': {
    base: { 'src/t.js': "export const unusedTc = 1;\nexport const banner = () => `${'`'}\nexport const unusedTc = 1;\n`;\n" },
    head: { 'src/t.js': "export const banner = () => `${'`'}\n`;\n" },
    knip: report(ex('src/t.js', 'unusedTc')),
    should: false,
  },
  'X1 regex in a class body, flags, then a removed top-level call': {
    base: { 'src/x.js': "import { app, auth } from './server.js';\nexport class UnusedX {\n  m(s) { return /a{/gi.test(s); }\n}\napp.use(auth);\nexport const keep = 1;\n" },
    head: { 'src/x.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/x.js', 'UnusedX')),
    should: false,
  },
  'X2 division after ) whose second slash is on the line, balanced body (stays division)': {
    base: { 'src/x.js': "export function unusedDv(a, b, c) { return (a) / b / c; }\nexport const keep = 1;\n" },
    head: { 'src/x.js': 'export const keep = 1;\n' },
    knip: report(ex('src/x.js', 'unusedDv')),
    should: true,
  },
  'X3 CRLF file: guard after a block comment beside an unused export': {
    base: { 'src/w.js': "export function handler(req) {\r\n  /* authz */ if (!authorized(req)) return 403;\r\n  return 200;\r\n}\r\nexport const unusedW = 1;\r\n" },
    head: { 'src/w.js': "export function handler(req) {\r\n  return 200;\r\n}\r\n" },
    knip: report(ex('src/w.js', 'unusedW')),
    should: false,
  },
  'X4 CRLF file: whole unused export removed': {
    base: { 'src/w.js': "export function keepW() {\r\n  return 1;\r\n}\r\nexport function unusedW() {\r\n  return 2;\r\n}\r\n" },
    head: { 'src/w.js': "export function keepW() {\r\n  return 1;\r\n}\r\n" },
    knip: report(ex('src/w.js', 'unusedW')),
    should: true,
  },
  'X5 removal on the last, tainted line (unclosed regex at EOF)': {
    base: { 'src/e.js': "export const keep = 1;\nexport function unusedE(s) { return s.split(/ x\n" },
    head: { 'src/e.js': 'export const keep = 1;\n' },
    knip: report(ex('src/e.js', 'unusedE')),
    should: false,
  },
  'S1 object spread in an exported const': {
    base: { 'src/s.js': "import { defaults } from './d.js';\nexport const unusedOs = { ...defaults };\nexport const keep = 1;\n" },
    head: { 'src/s.js': "import { defaults } from './d.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/s.js', 'unusedOs')),
    should: false,
  },
  'S2 spread in an array of an exported const': {
    base: { 'src/s.js': "import { items } from './d.js';\nexport const unusedAs = [1, ...items];\nexport const keep = 1;\n" },
    head: { 'src/s.js': "import { items } from './d.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/s.js', 'unusedAs')),
    should: false,
  },
  'S3 top-level call with a spread argument beside an unused export': {
    base: { 'src/s.js': "import { register, items } from './d.js';\nregister(...items);\nexport const unusedSc = 1;\n" },
    head: { 'src/s.js': "import { register, items } from './d.js';\n" },
    knip: report(ex('src/s.js', 'unusedSc')),
    should: false,
  },
  'S4 spread inside an arrow body (runs on call only)': {
    base: { 'src/s.js': "import { items } from './d.js';\nexport const unusedSa = () => [...items];\nexport const keep = 1;\n" },
    head: { 'src/s.js': "import { items } from './d.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/s.js', 'unusedSa')),
    should: true,
  },
};

export const ROUND4 = {
  // ---- new fail-open candidates ----
  'H1 hashbang ending in /* opens a block for the gate only; a // */ line hides app.use(auth) from it': {
    base: { ...server, 'src/h.js': `#! /*\nconst s = '*/'; /*\n// */ app.use(auth);\nexport function zorkH() {}\n// */\n${SERVER}export const keep = s;\n` },
    head: { 'src/h.js': `#! /*\nconst s = '*/'; /*\n// */\n${SERVER}export const keep = s;\n` },
    knip: report(ex('src/h.js', 'zorkH')),
    should: false,
  },
  'A1 the removed declaration continues into the kept next line: unusedA = register\\n(auth)': {
    base: { ...server, 'src/a.js': `${SERVER}export const zorkA1 = register\n(auth);\nexport const keep = 1;\n` },
    head: { 'src/a.js': `${SERVER}(auth);\nexport const keep = 1;\n` },
    knip: report(ex('src/a.js', 'zorkA1')),
    should: false,
  },
  'A2 removing a declaration joins the kept lines around it into a call: plugin = register\\n(auth)': {
    base: { ...server, 'src/a.js': `${SERVER}const plugin = register\nexport function zorkA2() {}\n(auth);\nexport const keep = plugin;\n` },
    head: { 'src/a.js': `${SERVER}const plugin = register\n(auth);\nexport const keep = plugin;\n` },
    knip: report(ex('src/a.js', 'zorkA2')),
    should: false,
  },
  'U1 unicode escape in the name: zork\\u0041 is read as zork; the used zorkA goes, whole removal': {
    base: { 'src/m.js': 'export const zork = 1;\nexport const zork\\u0041 = 2;\nexport const keep = 1;\n', 'src/u.js': "import { zorkA } from './m.js';\nexport const v = zorkA;\n" },
    head: { 'src/m.js': 'export const keep = 1;\n' },
    knip: report(ex('src/m.js', 'zork')),
    should: false,
  },
  'U2 same, keyword-only: export dropped from zork\\u0041, claimed as zork': {
    base: { 'src/m.js': 'export const zork = 1;\nexport const zork\\u0041 = 2;\n', 'src/u.js': "import { zorkA } from './m.js';\nexport const v = zorkA;\n" },
    head: { 'src/m.js': 'export const zork = 1;\nconst zork\\u0041 = 2;\n' },
    knip: report(ex('src/m.js', 'zork')),
    should: false,
  },
  'U3 non-ASCII letter in the name: zorkÄ is read as zork (check 2 may catch the importer)': {
    base: { 'src/m.js': 'export const zork = 1;\nexport const zorkÄ = 2;\nexport const keep = 1;\n', 'src/u.js': "import { zorkÄ } from './m.js';\nexport const v = zorkÄ;\n" },
    head: { 'src/m.js': 'export const keep = 1;\n' },
    knip: report(ex('src/m.js', 'zork')),
    should: false,
  },
  'U4 escape in the name, importer writes the escape too': {
    base: { 'src/m.js': 'export const zork = 1;\nexport const zork\\u0041 = 2;\nexport const keep = 1;\n', 'src/u.js': "import { zork\\u0041 } from './m.js';\nexport const v = zorkA;\n" },
    head: { 'src/m.js': 'export const keep = 1;\n' },
    knip: report(ex('src/m.js', 'zork')),
    should: false,
  },
  'HT HTML-like comment in a .cjs: <!-- /* hides app.use(auth); knip report claims the export node sees in a comment': {
    base: { 'src/h.cjs': "module.exports.k = 1; <!-- /*\nconst s = '*/'; /*\n// */ app.use(auth); /*\nexport const zorkHt = 1;\n// */\n" },
    head: { 'src/h.cjs': "module.exports.k = 1; <!-- /*\nconst s = '*/'; /*\n// */\n" },
    knip: report(ex('src/h.cjs', 'zorkHt')),
    should: 'false (needs a knip report naming an export node never sees)',
  },
  'GA .gitattributes at the base marks src/gen.js -diff: the change adds a line and drops app.use(auth) in it': {
    base: { ...server, '.gitattributes': 'src/gen.js -diff\n', 'src/gen.js': `${SERVER}app.use(auth);\nexport const keep = 1;\n`, 'src/old.js': 'export const zorkOld = 1;\n' },
    head: { 'src/gen.js': `${SERVER}export const keep = 2;\nexport const added = 3;\n`, 'src/old.js': null },
    knip: report(fl('src/old.js')),
    should: false,
  },
  'TC a source file becomes a symlink (type change T) to a file without the effect, beside a listed deletion': {
    base: { ...server, 'src/m.js': `${SERVER}app.use(auth);\nexport const keep = 1;\n`, 'src/quiet.js': 'export const keep = 1;\n', 'src/old.js': 'export const zorkOld = 1;\n' },
    head: { 'src/old.js': null },
    symlink: ['quiet.js', 'src/m.js'],
    knip: report(fl('src/old.js')),
    should: false,
  },
  // ---- lexer probes that must fail closed ----
  "L1 '\\\\'' escape, then code after the string on the same line": {
    base: { ...server, 'src/q.js': `${SERVER}export const zorkQ = '\\''; app.use(auth); //'\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: false,
  },
  'L2 "\\\\\\\\" escape, then code after the string': {
    base: { ...server, 'src/q.js': `${SERVER}export const zorkQ = "\\\\"; app.use(auth); //"\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: false,
  },
  "L3 '\\\\\\\\' escape, then code": {
    base: { ...server, 'src/q.js': `${SERVER}export const zorkQ = '\\\\'; app.use(auth); //'\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: false,
  },
  'L4 a string holding // and /*, then code': {
    base: { ...server, 'src/q.js': `${SERVER}export const zorkQ = 'a // b /* c'; app.use(auth);\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: false,
  },
  'L5 a block comment holding a quote, then code on its line, above an export': {
    base: { ...server, 'src/q.js': `${SERVER}/* it's */ app.use(auth);\nexport const zorkQ = 1;\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: false,
  },
  'L6 a multi-line block comment holding code-like text, above a removed export (comment only)': {
    base: { ...server, 'src/q.js': `${SERVER}/*\n app.use(auth); '\n*/\nexport const zorkQ = 1;\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: true,
  },
  'L7 a lone CR ends a // comment for node: app.use(auth) after it': {
    base: { ...server, 'src/q.js': `${SERVER}export const zorkQ = 1; //\rapp.use(auth);\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: false,
  },
  'L8 U+2028 ends a // comment for node': {
    base: { ...server, 'src/q.js': `${SERVER}export const zorkQ = 1; // app.use(auth);\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: false,
  },
  'L9 U+2029 inside a string (legal in a string since ES2019)': {
    base: { ...server, 'src/q.js': `${SERVER}export const zorkQ = 'a b';\nexport const keep = 1;\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: 'refused (over-block, fine)',
  },
  'L10 unterminated block comment at the end of the base file (node: SyntaxError)': {
    base: { ...server, 'src/q.js': `${SERVER}export const keep = 1;\nexport const zorkQ = 1;\n/* app.use(auth);\n` },
    head: { 'src/q.js': `${SERVER}export const keep = 1;\n/* app.use(auth);\n` },
    knip: report(ex('src/q.js', 'zorkQ')),
    should: 'either (base does not load)',
  },
  'L11 a hashbang with a path: #!/usr/bin/env node (cost)': {
    base: { ...server, 'src/cli.js': `#!/usr/bin/env node\n${SERVER}export const keep = 1;\nexport const zorkQ = 1;\n` },
    head: { 'src/cli.js': `#!/usr/bin/env node\n${SERVER}export const keep = 1;\n` },
    knip: report(ex('src/cli.js', 'zorkQ')),
    should: 'refused at line 1 (cost)',
  },
  'L12 a .cjs or .mts whole export with nothing odd passes': {
    base: { 'src/q.mts': 'export const keep = 1;\nexport function zorkM(a: number): number {\n  return a * 2;\n}\n' },
    head: { 'src/q.mts': 'export const keep = 1;\n' },
    knip: report(ex('src/q.mts', 'zorkM')),
    should: true,
  },
  // ---- TypeScript ----
  'T1 decorator above an exported class': {
    base: { 'src/t.ts': "import { reg } from './r.js';\n@reg\nexport class ZorkT {}\nexport const keep = 1;\n" },
    head: { 'src/t.ts': "import { reg } from './r.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/t.ts', 'ZorkT')),
    should: false,
  },
  'T2 decorator on a member': {
    base: { 'src/t.ts': "import { reg } from './r.js';\nexport class ZorkT {\n  @reg m() {}\n}\nexport const keep = 1;\n" },
    head: { 'src/t.ts': "import { reg } from './r.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/t.ts', 'ZorkT')),
    should: false,
  },
  'T3 generic function': {
    base: { 'src/t.ts': 'export const keep = 1;\nexport function zorkG<T extends { a: number }>(x: T): T {\n  return x;\n}\n' },
    head: { 'src/t.ts': 'export const keep = 1;\n' },
    knip: report(ex('src/t.ts', 'zorkG')),
    should: true,
  },
  'T4 <T>x cast of a call': {
    base: { 'src/t.ts': "import { reg } from './r.js';\nexport const zorkC = <Foo>reg;\nexport const keep = 1;\n" },
    head: { 'src/t.ts': "import { reg } from './r.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/t.ts', 'zorkC')),
    should: 'refused (fail closed on <)',
  },
  'T5 triple-slash directive above a removed export': {
    base: { 'src/t.ts': 'export const keep = 1;\n/// <reference types="node" />\nexport declare const zorkD: number;\n' },
    head: { 'src/t.ts': 'export const keep = 1;\n' },
    knip: report(ex('src/t.ts', 'zorkD')),
    should: false,
  },
  'T6 declare const and declare namespace': {
    base: { 'src/t.ts': 'export const keep = 1;\nexport declare const zorkD: number;\nexport declare namespace ZorkN {\n  const a: number;\n}\n' },
    head: { 'src/t.ts': 'export const keep = 1;\n' },
    knip: report(ex('src/t.ts', 'zorkD', 'ZorkN')),
    should: true,
  },
  'T7 enum with a call': {
    base: { 'src/t.ts': "import { reg } from './r.js';\nexport enum ZorkE { A = reg(), B }\nexport const keep = 1;\n" },
    head: { 'src/t.ts': "import { reg } from './r.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/t.ts', 'ZorkE')),
    should: false,
  },
  'T8 namespace with a statement': {
    base: { 'src/t.ts': "import { reg } from './r.js';\nexport namespace ZorkN {\n  reg();\n}\nexport const keep = 1;\n" },
    head: { 'src/t.ts': "import { reg } from './r.js';\nexport const keep = 1;\n" },
    knip: report(ex('src/t.ts', 'ZorkN')),
    should: false,
  },
  'T9 TS arrow with a return type: register\\n(auth) continuation through `as`': {
    base: { ...server, 'src/t.ts': `${SERVER}export const zorkAs = register as (x: number) => void\n(auth);\nexport const keep = 1;\n` },
    head: { 'src/t.ts': `${SERVER}(auth);\nexport const keep = 1;\n` },
    knip: report(ex('src/t.ts', 'zorkAs')),
    should: false,
  },
};
