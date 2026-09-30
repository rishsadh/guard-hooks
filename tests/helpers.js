import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cp1252Table } from '../src/text.js';

export const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Make the mojibake a wrong decode produces, from real text, so no fixture is hand-typed.
 * Node's TextDecoder is not spec compliant for windows-1252 on every build, so decode by hand.
 */
export function mojibake(text, codepage = 'windows-1252') {
  const table = cp1252Table();
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const mapped = codepage === 'windows-1252' && byte >= 0x80 && byte <= 0x9f ? table[byte - 0x80] : null;
    out += String.fromCodePoint(mapped ?? byte);
  }
  return out;
}

export function tmpProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-'));
  for (const [name, content] of Object.entries(files)) {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return dir;
}

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export const codes = (findings) => findings.map((f) => f.code).sort();
