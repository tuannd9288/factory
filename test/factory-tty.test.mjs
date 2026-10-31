// #177: the hidden prompt of `factory login`, driven with a stand-in for a raw-mode terminal. In raw mode the terminal sends
// Return as "\r" (ICRNL is off), and a paste may bring its own line ends. No real terminal runs here: none could be
// started without a pty tool, which the factory does not take as a dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readSecret, tokenOf } from '../bin/lib/token.mjs';

const TOKEN = 'sk-ant-oat01-Hh4Jj8Kk2Ll6Mm0Nn3Pp7Qq1Rr5Ss9Tt';

function fakeTty(...chunks) {
  const tty = new EventEmitter();
  tty.isTTY = true;
  tty.raw = [];
  tty.paused = false;
  tty.setRawMode = (on) => tty.raw.push(on);
  tty.setEncoding = () => {};
  tty.resume = () => setImmediate(() => chunks.forEach((c) => tty.emit('data', c)));
  tty.pause = () => { tty.paused = true; };
  return tty;
}

const prompt = () => ({ shown: '', write(t) { this.shown += t; } });

async function typed(...chunks) {
  const tty = fakeTty(...chunks);
  const out = prompt();
  const text = await readSecret(tty, out);
  return { text, tty, out, read: tokenOf(text) };
}

test('Return is Enter whichever way the terminal sends it: "\\r", "\\r\\n" or "\\n"', async () => {
  for (const keys of [`${TOKEN}\r`, `${TOKEN}\r\n`, `${TOKEN}\n`]) {
    const r = await typed(keys);
    assert.deepEqual(r.read, { token: TOKEN }, JSON.stringify(keys));
    assert.deepEqual(r.tty.raw, [true, false], 'raw mode on, then off');
    assert.ok(r.tty.paused);
  }
});

test('a token typed in pieces, with a backspace, then Return', async () => {
  const r = await typed('sk-ant-', 'oat01-Hh4Jj', 'XX\u007f\u007f', '8Kk2Ll6Mm0Nn3Pp7Qq1Rr5Ss9Tt', '\r');
  assert.deepEqual(r.read, { token: TOKEN });
});

test('the prompt shows nothing of what is typed', async () => {
  const r = await typed(`${TOKEN}\r`);
  assert.ok(!r.out.shown.includes(TOKEN.slice(0, 8)), r.out.shown);
});

test('a paste of more than one line is refused, whichever line ends it has', async () => {
  for (const keys of [`${TOKEN}\rsecond\r`, `${TOKEN}\r\nsecond\r\n`, `${TOKEN}\nsecond\n`, `${TOKEN}\r\r${TOKEN}\r`]) {
    const r = await typed(keys);
    assert.match(r.read.error, /more than one line/, JSON.stringify(keys));
  }
});

test('an empty Return is refused as empty', async () => {
  for (const keys of ['\r', '\n', ' \t\r']) assert.match((await typed(keys)).read.error, /empty/, JSON.stringify(keys));
});

test('Ctrl-C ends the prompt, puts the terminal back and gives no text', async () => {
  const tty = fakeTty('sk-ant-oat01-partial', '\u0003');
  const out = prompt();
  await assert.rejects(readSecret(tty, out), /interrupted/);
  assert.deepEqual(tty.raw, [true, false]);
  assert.ok(tty.paused);
});

test('tokenOf reads a carriage return as a line end, and trims spaces and tabs from both ends', () => {
  for (const text of [`${TOKEN}\r`, `${TOKEN}\r\n`, ` \t${TOKEN}  \n`, `  ${TOKEN}\t`, TOKEN]) assert.deepEqual(tokenOf(text), { token: TOKEN }, JSON.stringify(text));
});

test('tokenOf refuses an empty token, one with whitespace inside it, and one of more than one line', () => {
  for (const text of ['', '\n', '\r', ' \t \n', '\n\n']) assert.ok(tokenOf(text).error, JSON.stringify(text));
  for (const text of [`${TOKEN} x\n`, `sk-ant-oat01-Hh4Jj8Kk2L\tl6Mm0\n`, 'two words']) assert.match(tokenOf(text).error, /whitespace/, JSON.stringify(text));
  for (const text of [`${TOKEN}\n${TOKEN}\n`, `${TOKEN}\r${TOKEN}`, `\n${TOKEN}\n`, `${TOKEN}\n\n`]) assert.match(tokenOf(text).error, /more than one line/, JSON.stringify(text));
});
