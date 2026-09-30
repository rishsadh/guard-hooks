// The hook handlers. They take the JSON a coding agent sends on stdin and return a verdict.
// Pure functions where possible, so the tests can drive them without spawning a process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { analyzeChange, compareFingerprints, fingerprint } from './compare.js';
import { decodeUtf8, eolStyle, isValidUtf8, BOM } from './text.js';
import { lintShell } from './shell.js';
import { classifyTool, decide } from './levels.js';
import { loadConfig, matchesGlob } from './config.js';

const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

function resolveTarget(filePath, cwd) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw e;
  }
}

function relTo(root, file) {
  const r = path.relative(root, file).replace(/\\/g, '/');
  return r.startsWith('..') ? file.replace(/\\/g, '/') : r;
}

/** The replacement texts of an Edit or MultiEdit, as {old, neu} pairs. */
function editPairs(toolName, input) {
  const name = toolName.toLowerCase();
  if (name === 'edit') return [{ old: input.old_string ?? '', neu: input.new_string ?? '' }];
  if (name === 'multiedit' && Array.isArray(input.edits)) {
    return input.edits.map((e) => ({ old: e.old_string ?? '', neu: e.new_string ?? '' }));
  }
  return [];
}

/**
 * Check one Write, Edit or MultiEdit before it runs.
 * Write: the whole proposed file is compared with the file on disk.
 * Edit: only the replacement text can be judged, because the editor does its own writing.
 * The post-tool check covers what the editor really wrote.
 * @returns {{code:string, severity:string, message:string}[]}
 */
export function checkWrite(toolName, input, { cwd, config, root } = {}) {
  const name = toolName.toLowerCase();
  const target = resolveTarget(input.file_path, cwd);
  if (!target) return [];
  const rel = relTo(root || cwd || process.cwd(), target);
  const before = readIfExists(target);

  if (name === 'write') {
    const content = input.content ?? input.file_text;
    if (typeof content !== 'string') return [];
    return analyzeChange({ before, after: content, relPath: rel, config });
  }

  const findings = [];
  for (const { old, neu } of editPairs(toolName, input)) {
    // Judge the new text against the text it replaces, so existing mojibake is not blamed on this edit.
    const r = analyzeChange({
      before: Buffer.from(old, 'utf8'),
      after: Buffer.from(neu, 'utf8'),
      relPath: rel,
      config: { ...config, allow: [...(config?.allow || [])], requireBom: [] },
    }).filter((f) => ['mojibake-introduced', 'replacement-char-introduced', 'nul-introduced', 'lossy-question-marks'].includes(f.code));
    findings.push(...r);
  }
  return dedupe(findings);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => (seen.has(f.code) ? false : (seen.add(f.code), true)));
}

// ---- snapshots for the post-tool check -------------------------------------------------------

function snapshotDir() {
  return path.join(os.tmpdir(), 'guard-hooks-snapshots');
}

function snapshotKey(payload, target) {
  const id = payload.tool_use_id || `${payload.session_id || 'nosession'}:${target}`;
  return crypto.createHash('sha1').update(String(id)).update(target).digest('hex').slice(0, 24);
}

export function saveSnapshot(payload, target, buf) {
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  const fp = fingerprint(buf);
  fs.writeFileSync(path.join(dir, snapshotKey(payload, target) + '.json'), JSON.stringify({ target, fp }));
}

function takeSnapshot(payload, target) {
  const f = path.join(snapshotDir(), snapshotKey(payload, target) + '.json');
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.unlinkSync(f);
    return s.fp;
  } catch {
    return null;
  }
}

// ---- pre-tool ---------------------------------------------------------------------------------

/**
 * @param {object} payload the hook input
 * @param {{powershell?: string}} [opts]
 * @returns {{decision:'allow'|'deny', reason?:string, context?:string, findings:object[]}}
 */
export function preTool(payload, opts = {}) {
  const toolName = String(payload.tool_name || '');
  const name = toolName.toLowerCase();
  const input = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();
  const { config, root } = loadConfig(cwd);
  const ps = opts.powershell || config.powershell;
  let findings = [];

  if (WRITE_TOOLS.has(name)) {
    findings = checkWrite(toolName, input, { cwd, config, root });
    const target = resolveTarget(input.file_path, cwd);
    if (target) {
      try { saveSnapshot(payload, target, readIfExists(target)); } catch { /* the post check is best effort */ }
    }
  } else if (SHELL_TOOLS.has(name) && typeof input.command === 'string') {
    findings = lintShell(input.command, { tool: toolName, powershell: ps });
  } else {
    return { decision: 'allow', findings: [] };
  }

  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  if (blocks.length) {
    const target = input.file_path ? relTo(root, resolveTarget(input.file_path, cwd)) : '';
    const lines = blocks.map((f) => `- ${f.code}: ${f.message}`);
    const how = WRITE_TOOLS.has(name)
      ? 'Fix the content and try again. If this change is intended, the user can allow it for this path in .guard-hooks.json ("allow").'
      : 'Use the editor tools for this change, or add the missing encoding arguments.';
    return { decision: 'deny', reason: `guard-hooks blocked this ${toolName}${target ? ` to ${target}` : ''}:\n${lines.join('\n')}\n${how}`, findings };
  }
  if (warns.length) {
    return { decision: 'allow', context: `guard-hooks notes:\n${warns.map((f) => `- ${f.code}: ${f.message}`).join('\n')}`, findings };
  }
  return { decision: 'allow', findings };
}

// ---- post-tool --------------------------------------------------------------------------------

/** Repair a lost or added BOM and a flipped line ending style. Mojibake is never auto-repaired. */
export function repair(buf, before, findings) {
  let out = buf;
  const codes = new Set(findings.map((f) => f.code));
  const fixed = [];
  if (codes.has('eol-changed') || codes.has('eol-mixed')) {
    const style = eolStyle(before.eol);
    if ((style === 'crlf' || style === 'lf') && isValidUtf8(out)) {
      const hasBom = out.subarray(0, 3).equals(BOM.utf8);
      const text = decodeUtf8(out).replace(/\r\n|\r|\n/g, style === 'crlf' ? '\r\n' : '\n');
      out = Buffer.concat([hasBom ? BOM.utf8 : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
      fixed.push('line endings restored to ' + style.toUpperCase());
    }
  }
  if (codes.has('bom-lost') && !out.subarray(0, 3).equals(BOM.utf8)) {
    out = Buffer.concat([BOM.utf8, out]);
    fixed.push('UTF-8 BOM restored');
  }
  if (codes.has('bom-added') && out.subarray(0, 3).equals(BOM.utf8)) {
    out = out.subarray(3);
    fixed.push('UTF-8 BOM removed');
  }
  return { buf: out, fixed };
}

/**
 * Compare the file an editor really wrote with the snapshot taken before.
 * @returns {{decision:'ok'|'damage'|'fixed', message?:string, findings:object[], fixed?:string[]}}
 */
export function postTool(payload, opts = {}) {
  const name = String(payload.tool_name || '').toLowerCase();
  if (!WRITE_TOOLS.has(name)) return { decision: 'ok', findings: [] };
  const cwd = payload.cwd || process.cwd();
  const target = resolveTarget((payload.tool_input || {}).file_path, cwd);
  if (!target) return { decision: 'ok', findings: [] };
  const before = takeSnapshot(payload, target);
  if (!before || !before.exists) return { decision: 'ok', findings: [] };
  const { config, root } = loadConfig(cwd);
  const rel = relTo(root, target);
  if (config.ignore.some((g) => matchesGlob(g, rel))) return { decision: 'ok', findings: [] };

  const buf = readIfExists(target);
  if (!buf) return { decision: 'ok', findings: [] };
  let after = fingerprint(buf);
  let findings = compareFingerprints(before, after).filter((f) => !config.allow.some((a) => matchesGlob(a.glob, rel) && (a.codes.includes('*') || a.codes.includes(f.code))));
  if (!findings.length) return { decision: 'ok', findings: [] };

  let fixed = [];
  if (opts.fix) {
    const r = repair(buf, before, findings);
    if (r.fixed.length) {
      fs.writeFileSync(target, r.buf);
      fixed = r.fixed;
      after = fingerprint(r.buf);
      findings = compareFingerprints(before, after);
    }
  }
  const relName = rel;
  if (!findings.length) {
    return { decision: 'fixed', fixed, findings: [], message: `guard-hooks repaired ${relName} after the edit: ${fixed.join(', ')}.` };
  }
  const lines = findings.map((f) => `- ${f.code}: ${f.message}`);
  const note = fixed.length ? `\nAlready repaired: ${fixed.join(', ')}.` : '';
  return { decision: 'damage', findings, fixed, message: `guard-hooks found damage in ${relName} after the edit:\n${lines.join('\n')}${note}\nRestore the original encoding and line endings.` };
}

// ---- gate -------------------------------------------------------------------------------------

/**
 * Classify the tool call and apply the policy. Silence (allow) leaves Claude Code's own
 * permission flow untouched.
 */
export function gate(payload, opts = {}) {
  const cwd = payload.cwd || process.cwd();
  const { config } = loadConfig(cwd);
  const policy = { ...config.gate };
  if (opts.ask) policy.ask = opts.ask;
  if (opts.deny) policy.deny = opts.deny;
  const c = classifyTool(payload.tool_name, payload.tool_input || {}, { rules: config.gate.rules, cwd });
  const d = decide(c, policy);
  const why = c.reasons.slice(0, 3).join('; ');
  return {
    decision: d.decision,
    classification: c,
    reason: d.decision === 'allow' ? undefined : `guard-hooks: ${payload.tool_name} is ${c.levels.join(' + ')}${c.flags.length ? ` (${c.flags.join(', ')})` : ''}. ${why}`,
  };
}
