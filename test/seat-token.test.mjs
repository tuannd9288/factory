// bin/seat (#91): seat 1's token file must be printable ASCII (0x21-0x7E) once trailing newlines are stripped. A file with a
// NUL byte (a UTF-16 copy is one way) made Node throw an error that quotes the value, onto the caller's stderr (review of #91,
// B1). The refusal names the path and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder, world } from './seat-world.mjs';

/** Every 8-character piece of the printable runs of a value. */
const pieces = (s) => s.split(/[^\x21-\x7e]+/).flatMap((run) => Array.from({ length: Math.max(0, run.length - 7) }, (_, i) => run.slice(i, i + 8)));

const secret = 'fake-tok\x00-REVIEW-0123456789';
const bad = {
  'a NUL byte': Buffer.from(`${secret}\n`),
  'UTF-16': Buffer.from(`﻿${secret.replace('\x00', '')}\n`, 'utf16le'),
  'a space': Buffer.from('fake-tok en-REVIEW-0123456789\n'),
  'a line inside it': Buffer.from('fake-token-REVIEW\n0123456789\n'),
};

for (const [what, content] of Object.entries(bad)) {
  test(`a token file with ${what} is refused with exit 2, naming the path and printing none of the value`, () => world((w) => {
    const r = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'x']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.ok((r.out + r.err).includes(w.tokenFile));
    const seen = [r.out, r.err, ...[...filesUnder(w.run), ...filesUnder(w.state)].map(([, text]) => text)].join('\n');
    const text = content.toString('latin1').replace(/\x00/g, '');
    for (const piece of pieces(secret.replace('\x00', 'X')).concat(pieces(text))) assert.ok(!seen.includes(piece), `output holds ${piece.length} characters of the token`);
    assert.deepEqual(readdirSync(w.run).filter((n) => n !== 'BRIEF.md'), [], 'nothing was started');
  }, { tokenFile: content }));
}
