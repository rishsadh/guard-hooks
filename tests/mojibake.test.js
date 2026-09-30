import test from 'node:test';
import assert from 'node:assert/strict';
import { findMojibake, countMojibake } from '../src/mojibake.js';
import { cp1252Table, charToByte } from '../src/text.js';
import { mojibake } from './helpers.js';

test('the cp1252 table has the well-known anchors', () => {
  const t = cp1252Table();
  const at = (byte) => String.fromCodePoint(t[byte - 0x80]);
  assert.equal(at(0x80), '\u20ac');
  assert.equal(at(0x92), '\u2019');
  assert.equal(at(0x93), '\u201c');
  assert.equal(at(0x94), '\u201d');
  assert.equal(at(0x96), '\u2013');
  assert.equal(at(0x97), '\u2014');
  assert.equal(at(0x99), '\u2122');
  assert.equal(t[0x81 - 0x80], null);
});

test('the cp1252 table agrees with TextDecoder when the build is spec compliant', (ctx) => {
  const dec = new TextDecoder('windows-1252');
  if (dec.decode(Uint8Array.of(0x80)) !== '\u20ac') return ctx.skip('this Node build decodes windows-1252 as Latin-1');
  const table = cp1252Table();
  for (let i = 0; i < table.length; i++) {
    if (table[i] === null) continue;
    assert.equal(dec.decode(Uint8Array.of(0x80 + i)), String.fromCodePoint(table[i]));
  }
});

test('charToByte inverts the decoder', () => {
  assert.equal(charToByte(0x20ac), 0x80);
  assert.equal(charToByte(0x2019), 0x92);
  assert.equal(charToByte(0xe9), 0xe9);
  assert.equal(charToByte(0x4e2d), -1);
});

test('finds and repairs Spanish accents read as Windows-1252', () => {
  const real = 'Gesti\u00f3n de M\u00e9dicos, \u00bfC\u00f3mo est\u00e1s?';
  const damaged = mojibake(real);
  assert.notEqual(damaged, real);
  const hits = findMojibake(damaged);
  assert.equal(hits.length, 5);
  let fixed = damaged;
  for (const h of [...hits].reverse()) fixed = fixed.slice(0, h.index) + h.repaired + fixed.slice(h.index + h.found.length);
  assert.equal(fixed, real);
});

test('finds curly quotes, dashes and ellipsis (three-byte sequences)', () => {
  const real = 'It\u2019s \u201cfine\u201d \u2014 really\u2026';
  const hits = findMojibake(mojibake(real));
  assert.deepEqual(hits.map((h) => h.repaired), ['\u2019', '\u201c', '\u201d', '\u2014', '\u2026']);
});

test('finds CJK and emoji (three and four-byte sequences)', () => {
  const real = '\u4f60\u597d \u{1f600}';
  assert.equal(countMojibake(mojibake(real)), 3);
});

test('finds mojibake made by a Latin-1 decode too', () => {
  const real = 'caf\u00e9 \u00fcber';
  assert.equal(countMojibake(mojibake(real, 'iso-8859-1')), 2);
});

test('the no-break space survives: a non-breaking space after a lead byte', () => {
  const real = '\u00a0\u00a9';
  const hits = findMojibake(mojibake(real));
  assert.equal(hits.length, 2);
});

test('clean text, accents and real prose are not flagged', () => {
  for (const s of [
    'plain ascii',
    'caf\u00e9, \u00fcber, na\u00efve, Z\u00fcrich, se\u00f1or',
    '\u00c2 is a letter in Romanian and Vietnamese',
    '\u00c3 alone',
    'R\u00e9sum\u00e9 \u2014 \u201cquoted\u201d',
    '\u4f60\u597d',
    '',
  ]) {
    assert.equal(countMojibake(s), 0, JSON.stringify(s));
  }
});

test('a lead byte at the very end of the string does not throw', () => {
  assert.equal(countMojibake('abc\u00c3'), 0);
  assert.equal(countMojibake('abc\u00e2\u20ac'), 0);
});
