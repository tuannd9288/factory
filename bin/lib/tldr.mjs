// The opening of a kit pull request's body (#386, #411): `**Tóm tắt cho anh**`, three bullets (Anh quyết, Đề xuất, Rủi ro) in plain
// Vietnamese with the terms in English, so the Human reads and approves a tier-3 pull request from them, then `**TL;DR**` with
// the same three in English (You decide, Recommendation, Risk). They are the same layout as kit/.github/pull_request_template.md,
// and the Vietnamese block is the repository's only Vietnamese (docs/decisions.md, Language); a decision for him is numbered in Đề xuất,
// each with a recommendation, and each changed setting is named once, there. A fourth line (Nếu không trả lời / If no answer) is
// written only when a caller passes `silence`, `{ vi, en }`; bin/onboard and bin/kit-update pass none.
//
//   node bin/lib/tldr.mjs onboard <name> < evidence
//   node bin/lib/tldr.mjs kit-update <name> <added> <updated> <removed> <kept> < evidence
//
// The evidence is bin/kit-evidence's output on stdin: its `settings` block is the gate's settings, which the bullets name in
// plain words (bin/lib/gate-settings.mjs prints the rows); a row that carries `CHANGED` is a change the pull request makes,
// and each is a decision for him. The caller stops when the text is empty (a failed call prints nothing here).
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isHosted } from './gate-settings.mjs';

const NAMES = {
  "main's runner": 'máy chạy việc của main',
  "the candidate's runner": 'máy kiểm từng thay đổi',
  'the trusted runner': 'máy chạy bước tier',
};
const NAMES_EN = {
  "main's runner": 'the machine that runs main',
  "the candidate's runner": 'the machine that checks each change',
  'the trusted runner': 'the machine that runs the tier check',
};
const VALUE = /^(\[[^\]]*\]|[^,\s]+)(?:, (.*))?$/;

/** A setting's value as the evidence prints it, in words (Vietnamese, or English when `en`). */
function plain(words, value, en = false) {
  try {
    const labels = JSON.parse(value);
    if (labels.length === 1 && labels[0] === 'ubuntu-latest') return en ? "GitHub's machine" : 'máy của GitHub';
    if (isHosted(labels)) return en ? `GitHub's machine (${labels[0]})` : `máy của GitHub (${labels[0]})`;
    return en ? `your own machine (labels ${labels.join(', ')})` : `máy riêng của anh (nhãn ${labels.join(', ')})`;
  } catch {
    return value;
  }
}

/** The gate's settings as the evidence lists them: [{ name, value, raw, changed, from, fromRaw, en }] in words, or [] if none. `raw`
 * is the value as printed; `from` is what a changed setting was, in words, and `fromRaw` as printed; both are '' when the base held
 * it in a form the kit does not use. `en` is { name, value, from } in English. */
export function settingsOf(evidence) {
  const lines = evidence.split('\n');
  const at = lines.findIndex((l) => l.startsWith('settings ('));
  if (at < 0) return [];
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  ')) break;
    const m = l.trim().match(/^(.+?) \([^)]*\): (.*)$/);
    const v = m?.[2].match(VALUE);
    const words = m?.[1];
    if (!v) {
      const name = NAMES[words] ?? l.trim();
      rows.push({ name, value: '', raw: '', changed: false, from: '', fromRaw: '', en: { name: NAMES_EN[words] ?? l.trim(), value: '', from: '' } });
      continue;
    }
    const row = {
      name: NAMES[words] ?? words, value: plain(words, v[1]), raw: v[1], changed: false, from: '', fromRaw: '',
      en: { name: NAMES_EN[words] ?? words, value: plain(words, v[1], true), from: '' },
    };
    if (v[2]?.startsWith('CHANGED')) {
      row.changed = true;
      const was = v[2].match(/^CHANGED from (.*)$/)?.[1].match(VALUE);
      row.from = was ? plain(words, was[1]) : '';
      row.en.from = was ? plain(words, was[1], true) : '';
      row.fromRaw = was ? was[1] : '';
    }
    rows.push(row);
  }
  return rows;
}

const say = (r) => (r.value ? `${r.name}: ${r.value}` : r.name);
const REVERT = 'muốn bỏ thì revert PR này';
const REVERT_EN = 'to undo, revert this PR';

const LABELS = {
  vi: { head: '**Tóm tắt cho anh**', decide: 'Anh quyết', recommend: 'Đề xuất', risk: 'Rủi ro', silence: 'Nếu không trả lời' },
  en: { head: '**TL;DR**', decide: 'You decide', recommend: 'Recommendation', risk: 'Risk', silence: 'If no answer' },
};

/** One block: the heading and the bullets in the order the Human reads them (what he decides, the answer, the risk), then the
 * line for silence when the caller gave one. */
const block = (lang, { decide, recommend, risk, silence }) => {
  const l = LABELS[lang];
  const pairs = [[l.decide, decide], [l.recommend, recommend], [l.risk, risk], ...(silence ? [[l.silence, silence]] : [])];
  return [l.head, ...pairs.map(([k, v]) => `- **${k}:** ${v}`)].join('\n');
};

/** The two blocks, Vietnamese then English, with a blank line between. `silence` is { vi, en } or none. */
const section = (vi, en, silence) => [block('vi', { ...vi, silence: silence?.vi }), block('en', { ...en, silence: silence?.en })].join('\n\n');

/** The decisions for the changed settings, numbered on: those with an old value we can see, then those whose old value the
 * factory cannot see (the base held them in a form the kit does not use, so it cannot say whether they changed). */
function settingDecisions(changed) {
  const moves = changed.filter((r) => r.from);
  const unseen = changed.filter((r) => !r.from);
  let n = 0;
  const parts = [];
  if (moves.length) parts.push(`Approve khi các cài đặt mới đúng ý anh: ${moves.map((r) => `${++n}. ${r.name}: từ ${r.from} thành ${r.value}.`).join(' ')}`);
  if (unseen.length) {
    parts.push(`${parts.length ? 'Và approve' : 'Approve'} khi các giá trị này là giá trị repo đang dùng, hoặc giá trị anh muốn (factory không thấy được giá trị cũ): ${unseen.map((r) => `${++n}. ${say(r)}.`).join(' ')}`);
  }
  return parts.join(' ');
}

/** The same decisions in English, numbered the same way. */
function settingDecisionsEn(changed) {
  const moves = changed.filter((r) => r.en.from);
  const unseen = changed.filter((r) => !r.en.from);
  let n = 0;
  const parts = [];
  if (moves.length) parts.push(`Approve if the new settings are what you want: ${moves.map((r) => `${++n}. ${r.en.name}: from ${r.en.from} to ${r.en.value}.`).join(' ')}`);
  if (unseen.length) {
    parts.push(`${parts.length ? 'And approve' : 'Approve'} if these values are what the repository uses or what you want (the factory cannot see the old value): ${unseen.map((r) => `${++n}. ${say(r.en)}.`).join(' ')}`);
  }
  return parts.join(' ');
}

export function onboardTldr(name, evidence, silence) {
  const rows = settingsOf(evidence);
  const settings = rows.map(say).join('; ');
  const settingsEn = rows.map((r) => say(r.en)).join('; ');
  return section(
    {
      decide: `Duyệt PR đưa ${name} vào factory: thêm gate (bộ kiểm tra tự động), hooks, template PR và luật cho agent${settings ? `, với cài đặt của gate: ${settings}` : ''}.`,
      recommend: `Approve, nếu các cài đặt trên đúng ý anh và session của ${name} đã liệt kê các file sửa trong phần chi tiết.`,
      risk: `verify đỏ tới khi PR này merge là bình thường và không chặn merge; ${REVERT}.`,
    },
    {
      decide: `Approve the PR that brings ${name} into the factory: it adds the gate (automatic checks), hooks, a PR template and agent rules${settingsEn ? `, with these gate settings: ${settingsEn}` : ''}.`,
      recommend: `Approve, if the settings above are what you want and ${name}'s session has listed the files it edits in the detail.`,
      risk: `verify stays red until this PR merges, which is normal and does not block the merge; ${REVERT_EN}.`,
    },
    silence,
  );
}

export function kitUpdateTldr(name, { added, updated, removed, kept }, evidence, silence) {
  const rows = settingsOf(evidence);
  const changed = rows.filter((r) => r.changed);
  const moves = changed.filter((r) => r.from);
  const unseen = changed.length - moves.length;
  const touches = updated + removed;
  const settings = !changed.length
    ? ['cài đặt của gate giữ nguyên', 'gate settings unchanged']
    : !unseen
      ? [`${moves.length} cài đặt của gate đổi, xem Đề xuất`, `${moves.length} gate settings change, see Recommendation`]
      : !moves.length
        ? [`${unseen} cài đặt của gate chuyển vào file của gate, xem Đề xuất`, `${unseen} gate settings move into the gate's file, see Recommendation`]
        : [`${moves.length} cài đặt của gate đổi, ${unseen} cài đặt chuyển vào file của gate, xem Đề xuất`, `${moves.length} gate settings change and ${unseen} move into the gate's file, see Recommendation`];
  return section(
    {
      decide: `Duyệt PR đưa kit trong ${name} lên bản factory mới: thêm ${added} file, cập nhật ${updated}, bỏ ${removed}, giữ ${kept} file riêng của repo; ${settings[0]}.`,
      recommend: changed.length ? settingDecisions(changed) : 'Approve.',
      risk: `${touches ? `Sửa ${touches} file repo đã có` : 'Không sửa file nào repo đã có'}; ${REVERT}.`,
    },
    {
      decide: `Approve the PR that moves the kit in ${name} to a newer factory version: ${added} files added, ${updated} updated, ${removed} removed, ${kept} of the repository's own kept; ${settings[1]}.`,
      recommend: changed.length ? settingDecisionsEn(changed) : 'Approve.',
      risk: `${touches ? `It edits ${touches} files the repository already has` : 'It edits no file the repository already has'}; ${REVERT_EN}.`,
    },
    silence,
  );
}

function main([verb, name, ...nums]) {
  const evidence = readFileSync(0, 'utf8');
  if (verb === 'onboard' && name) return console.log(onboardTldr(name, evidence));
  if (verb === 'kit-update' && name && nums.length === 4 && nums.every((n) => /^\d+$/.test(n))) {
    const [added, updated, removed, kept] = nums.map(Number);
    return console.log(kitUpdateTldr(name, { added, updated, removed, kept }, evidence));
  }
  console.error('usage: node bin/lib/tldr.mjs onboard <name> | kit-update <name> <added> <updated> <removed> <kept>   (evidence on stdin)');
  process.exitCode = 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
