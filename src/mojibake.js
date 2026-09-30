// Find UTF-8 text that was decoded as Latin-1 or Windows-1252 (the classic mojibake).
//
// A string is reported only when it can be undone exactly: the characters map back to
// bytes that form a valid UTF-8 sequence. That keeps false positives low, because real
// prose almost never spells out a valid UTF-8 lead byte followed by valid continuation bytes.
import { charToByte } from './text.js';

const strict = new TextDecoder('utf-8', { fatal: true });

function continuationCount(lead) {
  if (lead >= 0xc2 && lead <= 0xdf) return 1;
  if (lead >= 0xe0 && lead <= 0xef) return 2;
  if (lead >= 0xf0 && lead <= 0xf4) return 3;
  return 0;
}

/**
 * @param {string} text
 * @returns {{index:number, found:string, repaired:string}[]}
 */
export function findMojibake(text) {
  const hits = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0xc0) continue; // cheap skip: every lead byte is 0xC2 or above
    const lead = charToByte(code);
    const n = lead < 0 ? 0 : continuationCount(lead);
    if (!n || i + n >= text.length) continue;
    const bytes = [lead];
    let ok = true;
    for (let k = 1; k <= n; k++) {
      const b = charToByte(text.charCodeAt(i + k));
      if (b < 0x80 || b > 0xbf) { ok = false; break; }
      bytes.push(b);
    }
    if (!ok) continue;
    try {
      const repaired = strict.decode(Uint8Array.from(bytes));
      hits.push({ index: i, found: text.slice(i, i + n + 1), repaired });
      i += n;
    } catch {
      // not a valid sequence (overlong or surrogate), leave it alone
    }
  }
  return hits;
}

export function countMojibake(text) {
  return findMojibake(text).length;
}
