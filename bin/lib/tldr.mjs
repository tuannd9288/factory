// The opening of a kit pull request's body (#386): `**Tóm tắt cho anh**`, three bullets (Thay đổi, Rủi ro, Đề xuất) in plain
// Vietnamese with the terms in English, so the Human reads and approves a tier-3 pull request from them. They are the same three
// bullets as kit/.github/pull_request_template.md, and the repository's only Vietnamese (AGENTS.md, Language); a decision for
// him is numbered in Đề xuất, each with a recommendation, and each changed setting is named once, there.
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
  'the reviewer': 'reviewer',
  "main's runner": 'máy chạy việc của main',
  "the candidate's runner": 'máy kiểm từng thay đổi',
  'the trusted runner': 'máy giữ key của reviewer',
};
const NO_REVIEWER = 'none (review and verdict fail closed)';
const VALUE = /^(\[[^\]]*\]|none \(review and verdict fail closed\)|[^,\s]+)(?:, (.*))?$/;

const REVIEWS = { claude: 'review của Claude', entire: 'review của Entire (dịch vụ riêng)', stub: 'reviewer giả để test, không phải review thật' };

/** A setting's value as the evidence prints it, in words. */
function plain(words, value) {
  if (value === NO_REVIEWER) return 'chưa có reviewer (không gì tự merge)';
  if (words === 'the reviewer') return REVIEWS[value] ?? value;
  try {
    const labels = JSON.parse(value);
    if (labels.length === 1 && labels[0] === 'ubuntu-latest') return 'máy của GitHub';
    if (isHosted(labels)) return `máy của GitHub (${labels[0]})`;
    return `máy riêng của anh (nhãn ${labels.join(', ')})`;
  } catch {
    return value;
  }
}

/** The gate's settings as the evidence lists them: [{ name, value, raw, changed, from }] in words, or [] if none. `raw` is the
 * value as printed; `from` is what a changed setting was, or '' when the base held it in a form the kit does not use. */
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
      rows.push({ name: NAMES[words] ?? l.trim(), value: '', raw: '', changed: false, from: '' });
      continue;
    }
    const row = { name: NAMES[words] ?? words, value: plain(words, v[1]), raw: v[1], changed: false, from: '' };
    if (v[2]?.startsWith('CHANGED')) {
      row.changed = true;
      const was = v[2].match(/^CHANGED from (.*)$/)?.[1].match(VALUE);
      row.from = was ? plain(words, was[1]) : '';
    }
    rows.push(row);
  }
  return rows;
}

const say = (r) => (r.value ? `${r.name}: ${r.value}` : r.name);
const REVERT = 'Muốn bỏ thì revert PR này.';

const section = (bullets) =>
  ['**Tóm tắt cho anh**', ...Object.entries(bullets).map(([k, v]) => `- **${k}:** ${v}`)].join('\n');

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

/** The review clause follows the head's reviewer: none, a test stand-in, or a real review. */
function reviewClause(rows) {
  const reviewer = rows.find((r) => r.name === NAMES['the reviewer'])?.raw;
  if (reviewer === undefined || reviewer === '') return '';
  if (reviewer === NO_REVIEWER) return ' Chưa có reviewer nên không có review AI nào chạy.';
  if (reviewer === 'stub') return ' Chỉ reviewer giả để test chạy, không phải review thật.';
  return ' Review AI chạy trên PR này.';
}

export function onboardTldr(name, evidence) {
  const settings = settingsOf(evidence).map(say).join('; ');
  return section({
    'Thay đổi': `${name} vào factory: thêm gate (bộ kiểm tra tự động), hooks, template PR và luật cho agent.${settings ? ` Cài đặt của gate: ${settings}.` : ''}`,
    'Rủi ro': `verify sẽ đỏ cho tới khi PR này merge; vậy là bình thường, không chặn merge. Chưa có review AI nào chạy trên PR này. ${REVERT}`,
    'Đề xuất': `Approve, khi các cài đặt trên đúng ý anh và session của ${name} đã liệt kê các file sửa vào thì rủi ro.`,
  });
}

export function kitUpdateTldr(name, { added, updated, removed, kept }, evidence) {
  const rows = settingsOf(evidence);
  const changed = rows.filter((r) => r.changed);
  const moves = changed.filter((r) => r.from);
  const touches = updated + removed;
  const settings = !changed.length
    ? ' Cài đặt của gate giữ nguyên.'
    : moves.length
      ? ` ${changed.length} cài đặt của gate đổi, xem Đề xuất.`
      : ` ${changed.length} cài đặt của gate chuyển vào file của gate, xem Đề xuất.`;
  return section({
    'Thay đổi': `kit trong ${name} lên bản factory mới: thêm ${added} file, cập nhật ${updated}, bỏ ${removed}; ${kept} file riêng của repo giữ nguyên.${settings}`,
    'Rủi ro': `${touches ? `Sửa ${touches} file repo đã có.` : 'Không sửa file nào repo đã có.'}${reviewClause(rows)} ${REVERT}`,
    'Đề xuất': changed.length ? settingDecisions(changed) : 'Approve.',
  });
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
