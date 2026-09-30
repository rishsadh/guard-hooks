// Compare a file before and after a proposed write and report the damage an agent can do
// without meaning to: a lost BOM, changed line endings, mojibake, replacement characters.
import {
  bomOf, decodeUtf8, isValidUtf8, eolStats, eolStyle, eolName,
  countChar, countNonAscii,
} from './text.js';
import { findMojibake } from './mojibake.js';
import { matchesGlob } from './config.js';

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tgz', 'tar', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov',
  'wav', 'webm', 'avi', 'psd', 'sqlite', 'db', 'wasm', 'jar', 'class', 'pyc',
]);

const POWERSHELL_EXT = /\.(ps1|psm1|psd1)$/i;
const WIDE = new Set(['utf16le', 'utf16be', 'utf32le', 'utf32be']);

/**
 * Metadata that is enough to detect damage later without keeping the file contents.
 * @param {Buffer|null} buf
 */
export function fingerprint(buf) {
  if (!buf) return { exists: false };
  const bom = bomOf(buf);
  const textual = !bom || bom === 'utf8';
  const text = textual ? decodeUtf8(buf) : '';
  return {
    exists: true,
    size: buf.length,
    bom,
    validUtf8: isValidUtf8(buf),
    binary: textual && buf.includes(0),
    eol: eolStats(text),
    mojibake: textual ? findMojibake(text).length : 0,
    fffd: countChar(text, 0xfffd),
    nul: countChar(text, 0),
    nonAscii: countNonAscii(text),
    questionMarks: countChar(text, 63),
  };
}

function examples(text, limit = 3) {
  return findMojibake(text).slice(0, limit).map((h) => `"${h.found}" should be "${h.repaired}"`).join(', ');
}

function isBinaryPath(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(p || '');
  return !!m && BINARY_EXT.has(m[1].toLowerCase());
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Compare two fingerprints. `afterText` (optional) supplies readable examples.
 * @returns {{code:string, severity:'block'|'warn', message:string}[]}
 */
export function compareFingerprints(before, after, opts = {}) {
  const out = [];
  const add = (code, message, severity = 'block') => out.push({ code, severity, message });
  const existed = before.exists;

  if (existed && before.binary) return out;
  if (after.binary) {
    add('nul-introduced', 'the result contains NUL bytes. This usually means a UTF-16 file was written as UTF-8, or the reverse.');
    return out;
  }

  if (existed) {
    if (before.bom === 'utf8' && after.bom !== 'utf8') {
      add('bom-lost', 'the file started with a UTF-8 BOM and the result does not. Tools that need the BOM will read the file as ANSI. Keep the EF BB BF bytes at the start.');
    } else if (!before.bom && after.bom === 'utf8') {
      add('bom-added', 'the file had no BOM and the result starts with one. A BOM breaks shebang lines, JSON parsers and many Unix tools.');
    }
    if (WIDE.has(before.bom) && after.bom !== before.bom) {
      add('encoding-changed', `the file was ${before.bom.toUpperCase()} and the result is not. The encoding would change.`);
    }
    if (!before.validUtf8 && !WIDE.has(before.bom) && after.validUtf8) {
      add('legacy-encoding-rewritten', 'the file is not valid UTF-8 (probably Latin-1 or Windows-1252) and this write would convert it to UTF-8. Anything that reads it as ANSI will then show mojibake.');
    }
    if (before.validUtf8 && !after.validUtf8 && !WIDE.has(after.bom)) {
      add('invalid-utf8', 'the result is not valid UTF-8 although the file was.');
    }
    const bs = eolStyle(before.eol);
    const as = eolStyle(after.eol);
    if (bs !== 'none' && bs !== 'mixed' && as !== bs && as !== 'none') {
      if (as === 'mixed') {
        const foreign = bs === 'crlf' ? after.eol.lf + after.eol.cr
          : bs === 'lf' ? after.eol.crlf + after.eol.cr
            : after.eol.crlf + after.eol.lf;
        add('eol-mixed', `the file used ${eolName(bs)} line endings throughout. The result has ${plural(foreign, 'line')} with a different ending, so the file becomes mixed.`);
      } else {
        add('eol-changed', `the file used ${eolName(bs)} line endings throughout and the result uses ${eolName(as)}.`);
      }
    }
  }

  const baseMoji = existed ? before.mojibake : 0;
  if (after.mojibake > baseMoji) {
    const ex = opts.afterText ? ` Example: ${examples(opts.afterText)}.` : '';
    add('mojibake-introduced', `the result contains ${plural(after.mojibake - baseMoji, 'new mojibake sequence')} (UTF-8 text that was read as Latin-1 or Windows-1252).${ex}`);
  }
  const baseFffd = existed ? before.fffd : 0;
  if (after.fffd > baseFffd) {
    add('replacement-char-introduced', `the result contains ${plural(after.fffd - baseFffd, 'new replacement character')} (U+FFFD). Text was lost on the way in.`);
  }
  if (after.nul > (existed ? before.nul : 0)) {
    add('nul-introduced', 'the result contains NUL characters.');
  }
  if (existed) {
    const lost = before.nonAscii - after.nonAscii;
    const addedQ = after.questionMarks - before.questionMarks;
    if (lost > 0 && addedQ >= Math.max(1, Math.ceil(lost / 2))) {
      add('lossy-question-marks', `${plural(lost, 'non-ASCII character')} disappeared and ${plural(addedQ, 'question mark')} appeared. That is what a write through an ASCII or ANSI code page does.`);
    }
  }
  return out;
}

function applyAllow(findings, cfg, rel) {
  return findings.filter((f) => !cfg.allow.some((a) => matchesGlob(a.glob, rel) && (a.codes.includes('*') || a.codes.includes(f.code))));
}

const DEFAULT_CFG = { ignore: [], allow: [], requireBom: [], maxBytes: 5 * 1024 * 1024 };

/**
 * Analyse a proposed change to one file.
 * @param {{before: Buffer|null, after: Buffer|string, relPath?: string, config?: object}} args
 */
export function analyzeChange({ before, after, relPath = '', config }) {
  const cfg = config || DEFAULT_CFG;
  const rel = relPath.replace(/\\/g, '/');
  if (isBinaryPath(rel)) return [];
  if (cfg.ignore.some((g) => matchesGlob(g, rel))) return [];
  const afterBuf = typeof after === 'string' ? Buffer.from(after, 'utf8') : after;
  if ((before && before.length > cfg.maxBytes) || afterBuf.length > cfg.maxBytes) return [];

  const fb = fingerprint(before);
  const fa = fingerprint(afterBuf);
  const afterText = !fa.bom || fa.bom === 'utf8' ? decodeUtf8(afterBuf) : '';
  const findings = compareFingerprints(fb, fa, { afterText });

  if (!before && fa.nonAscii > 0 && fa.bom !== 'utf8') {
    if (cfg.requireBom.some((g) => matchesGlob(g, rel))) {
      findings.push({ code: 'bom-required', severity: 'block', message: 'this path is listed in requireBom and the new file has non-ASCII text without a UTF-8 BOM. Start the content with U+FEFF.' });
    } else if (POWERSHELL_EXT.test(rel)) {
      findings.push({ code: 'bom-recommended', severity: 'warn', message: 'a new PowerShell script with non-ASCII text and no BOM is read as ANSI by Windows PowerShell 5.1. Start the content with U+FEFF, or keep the script ASCII.' });
    }
  }
  return applyAllow(findings, cfg, rel);
}

/** Findings for a file as it stands, with no before state: a health check. */
export function inspectFile({ buf, relPath = '', config }) {
  const findings = analyzeChange({ before: null, after: buf, relPath, config });
  const fp = fingerprint(buf);
  if (eolStyle(fp.eol) === 'mixed') {
    const { crlf, lf, cr } = fp.eol;
    findings.push({ code: 'mixed-line-endings', severity: 'warn', message: `line endings are mixed (${crlf} CRLF, ${lf} LF, ${cr} CR)` });
  }
  return { findings, fingerprint: fp };
}
