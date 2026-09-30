// Shell helpers: a quote-aware command splitter, and a lint for commands that are known to
// damage text encoding. The lint is a heuristic on the command text. It cannot see which
// files a command will touch, so it only flags patterns that are unsafe on their own.

/**
 * Split a shell or PowerShell command into simple segments at ; && || | & and newlines,
 * leaving quoted text intact. Returns segments with the operator that followed each.
 */
export function splitSegments(cmd, { pipes = true } = {}) {
  const segs = [];
  let cur = '';
  let quote = null;
  const push = (op) => {
    if (cur.trim()) segs.push({ text: cur.trim(), op });
    cur = '';
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === '`' && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '`' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '\n' || c === ';') { push(c === ';' ? ';' : '\n'); continue; }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { push(c + c); i++; continue; }
    if (c === '|' && pipes) { push('|'); continue; }
    if (c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>' && cmd[i - 1] !== '<') { push('&'); continue; }
    cur += c;
  }
  push(null);
  return segs;
}

/** Words of a segment, honouring quotes. Quotes are removed. */
export function words(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

const HAS_ENCODING = /-Encoding\b/i;

// What each occurrence covers: from the cmdlet name to the next pipe, semicolon, closing paren or newline.
const occurrences = (text, names) => [...text.matchAll(new RegExp(`(?<![\\w-])(?:${names})(?![\\w-])[^|;)\\r\\n]*`, 'gi'))].map((m) => m[0]);

const MSG = {
  roundtrip: 'this reads a file with Get-Content without -Encoding and writes text back. In Windows PowerShell 5.1 Get-Content reads a file without a BOM as ANSI, so UTF-8 text is decoded wrongly, and Set-Content or Out-File write the ANSI code page, so a UTF-8 BOM is dropped and characters outside that code page become question marks. Use the editor tools, or give both ends -Encoding UTF8, or a Node script.',
  defaultEncoding: 'Set-Content, Add-Content and Out-File without -Encoding write ANSI or UTF-16LE in a stock Windows PowerShell 5.1. Add -Encoding UTF8, or use the editor tools.',
  redirect: 'In a stock Windows PowerShell 5.1 the > and >> operators write UTF-16LE (Microsoft docs). Use Out-File -Encoding UTF8 or the editor tools.',
  dotnet: 'File.WriteAllText without an encoding argument writes UTF-8 without a BOM, so a file that had a BOM loses it.',
  lossyFlag: 'this writes with an encoding that cannot hold all of Unicode or that changes the file encoding.',
  eol: 'this command rewrites line endings in every file it touches.',
};

/**
 * Lint one command string for encoding hazards.
 * @param {string} command
 * @param {{tool?: string, powershell?: string}} opts tool is "Bash" or "PowerShell"; powershell is "5.1" or "7"
 * @returns {{code:string, severity:'block'|'warn', message:string}[]}
 */
export function lintShell(command, opts = {}) {
  const out = [];
  const tool = (opts.tool || '').toLowerCase();
  const ps7 = /^7/.test(String(opts.powershell || ''));
  const add = (code, message, severity) => out.push({ code, severity, message });
  const isPs = tool === 'powershell' || /\b(powershell|pwsh)(\.exe)?\b/i.test(command);

  if (isPs) {
    const readers = tool === 'powershell' ? 'Get-Content|gc|cat|type' : 'Get-Content|gc';
    const dotnetWrite = '\\[(?:System\\.)?IO\\.File\\]::(?:WriteAllText|WriteAllLines|AppendAllText)';
    const writers = tool === 'powershell'
      ? `Set-Content|Add-Content|Out-File|sc|ac|${dotnetWrite}`
      : `Set-Content|Add-Content|Out-File|${dotnetWrite}`;
    const reads = occurrences(command, readers);
    const writes = occurrences(command, writers);
    // The round trip that corrupts UTF-8: an ANSI read feeding a write, in one command.
    if (!ps7 && reads.some((r) => !HAS_ENCODING.test(r)) && writes.length) {
      add('ps-roundtrip', MSG.roundtrip, 'block');
      return out;
    }
    for (const { text } of splitSegments(command, { pipes: false })) {
      const w = occurrences(text, writers);
      const dotnet = /\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText)\(([^)]*)\)/i.exec(text);
      if (dotnet && !/Encoding|UTF8|Unicode|ASCII/i.test(dotnet[1])) add('dotnet-write-no-encoding', MSG.dotnet, 'warn');
      const cmdletWrites = w.filter((x) => !/^\[/.test(x));
      if (!ps7 && cmdletWrites.some((x) => !HAS_ENCODING.test(x))) add('ps-write-default-encoding', MSG.defaultEncoding, 'warn');
      if (cmdletWrites.some((x) => /-Encoding\s+['"]?(ascii|default|oem|unicode|bigendianunicode|utf7|latin1)\b/i.test(x))) add('ps-lossy-encoding-flag', MSG.lossyFlag, 'warn');
      if (tool === 'powershell' && !ps7 && /(?:^|[^>\d&])>{1,2}\s*['"]?(?!\$null|nul\b|&)[\w.\\/:$~-]+/i.test(text)) add('ps-redirect-utf16', MSG.redirect, 'warn');
    }
  }
  if (/\b(dos2unix|unix2dos)\b|\btr\s+-d\s+['"]\\r['"]|\bsed\b[^|]*\bs\/\\r\/\/|-replace\s+['"]\\r?\\n['"]|-replace\s+["']`r`n["']/i.test(command)) {
    add('eol-command', MSG.eol, 'warn');
  }
  return dedupe(out);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => (seen.has(f.code) ? false : (seen.add(f.code), true)));
}
