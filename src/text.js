// Byte and text helpers shared by the detectors. No dependencies.

// Windows-1252 differs from Latin-1 only in 0x80 to 0x9F. A null entry is a byte
// that cp1252 leaves undefined; it is treated as the Latin-1 control character.
// Source: the Unicode Consortium cp1252 mapping table (unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP1252.TXT).
const CP1252_HIGH = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

const CHAR_TO_BYTE = new Map();
for (let i = 0; i < CP1252_HIGH.length; i++) {
  if (CP1252_HIGH[i] !== null) CHAR_TO_BYTE.set(CP1252_HIGH[i], 0x80 + i);
}

/** Map a character to the byte a cp1252 or Latin-1 decoder would have read it from, or -1. */
export function charToByte(code) {
  if (code < 0x100) return code; // ASCII, C1 controls (Latin-1 reading) and 0xA0-0xFF
  const b = CHAR_TO_BYTE.get(code);
  return b === undefined ? -1 : b;
}

export function cp1252Table() {
  return CP1252_HIGH.slice();
}

export const BOM = {
  utf8: Buffer.from([0xef, 0xbb, 0xbf]),
};

/** Name of the byte order mark at the start of a buffer, or null. */
export function bomOf(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) return 'utf32le';
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) return 'utf32be';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  return null;
}

export function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Decode UTF-8 (lossy on bad bytes) and drop a leading BOM character. */
export function decodeUtf8(buf) {
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(buf);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Line ending counts. CRLF is counted once, never as a CR plus an LF. */
export function eolStats(text) {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++;
    } else if (c === 10) lf++;
  }
  return { crlf, lf, cr };
}

export function eolStyle(s) {
  const kinds = (s.crlf > 0) + (s.lf > 0) + (s.cr > 0);
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  return s.crlf ? 'crlf' : s.lf ? 'lf' : 'cr';
}

export function countChar(text, code) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

export function countNonAscii(text) {
  let n = 0;
  for (const ch of text) if (ch.codePointAt(0) > 0x7f) n++;
  return n;
}

const NAMES = { crlf: 'CRLF', lf: 'LF', cr: 'CR', mixed: 'mixed', none: 'none' };
export const eolName = (style) => NAMES[style] || style;
