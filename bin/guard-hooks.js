#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { analyzeChange, inspectFile } from '../src/compare.js';
import { preTool, postTool, gate } from '../src/hook.js';
import { checkStaged } from '../src/git.js';
import { classifyCommand, classifyTool, LEVELS } from '../src/levels.js';
import { settingsSnippet, isEphemeralInstall } from '../src/init.js';
import { loadConfig } from '../src/config.js';

const HELP = `guard-hooks: stop agent writes that damage files, and classify what an action does.

Hooks (read the agent's JSON from stdin):
  pre-tool [--ps 5.1|7]    Before Write, Edit, MultiEdit, Bash, PowerShell. Exit 2 blocks.
  post-tool [--fix]        After Write, Edit, MultiEdit. Compares the real file with the snapshot.
  gate [--ask a,b] [--deny a,b]
                           Classify any tool call and ask or deny by level.

Commands:
  check <file...>          Look for mojibake, replacement characters, NUL and mixed line endings.
  compare <before> <after> Report what changing <before> into <after> would damage.
  staged                   Check staged git changes against HEAD (use as a pre-commit hook).
  classify "<command>"     Print the action level of a shell command.
  classify --tool <name> [--input '<json>']
  levels [--json]          Print the action ladder.
  init [--gate] [--no-fix] Print the settings.json snippet. Writes nothing.

Options: --json for machine output.
Exit codes for commands: 0 clean, 1 damage found, 2 usage error.`;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^\ufeff/, '')));
    process.stdin.on('error', () => resolve(''));
    if (process.stdin.isTTY) resolve('');
  });
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args, name) => args.includes(name);
const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

function printFindings(label, findings) {
  for (const f of findings) console.log(`${f.severity === 'block' ? 'FAIL' : 'WARN'}  ${label}  ${f.code}: ${f.message}`);
}

async function hookInput() {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write('guard-hooks: stdin was not JSON; letting the call through.\n');
    return null;
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const json = has(args, '--json');

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return 0; }
  if (cmd === '--version' || cmd === '-v') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }

  if (cmd === 'pre-tool') {
    const payload = await hookInput();
    if (!payload) return 0;
    let r;
    try { r = preTool(payload, { powershell: flag(args, '--ps') }); } catch (e) { process.stderr.write(`guard-hooks: ${e.message}\n`); return 1; }
    if (r.decision === 'deny') { process.stderr.write(r.reason + '\n'); return 2; }
    if (r.context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.context } }) + '\n');
    return 0;
  }

  if (cmd === 'post-tool') {
    const payload = await hookInput();
    if (!payload) return 0;
    let r;
    try { r = postTool(payload, { fix: has(args, '--fix') }); } catch (e) { process.stderr.write(`guard-hooks: ${e.message}\n`); return 1; }
    if (r.decision === 'damage') { process.stderr.write(r.message + '\n'); return 2; }
    if (r.decision === 'fixed') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.message } }) + '\n');
    return 0;
  }

  if (cmd === 'gate') {
    const payload = await hookInput();
    if (!payload) return 0;
    let r;
    try { r = gate(payload, { ask: list(flag(args, '--ask')), deny: list(flag(args, '--deny')) }); } catch (e) { process.stderr.write(`guard-hooks: ${e.message}\n`); return 1; }
    if (r.decision === 'deny') { process.stderr.write(r.reason + '\n'); return 2; }
    if (r.decision === 'ask') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: r.reason } }) + '\n');
    }
    return 0;
  }

  if (cmd === 'check') {
    const files = args.filter((a) => !a.startsWith('--'));
    if (!files.length) { console.error('usage: guard-hooks check <file...>'); return 2; }
    const { config, root } = loadConfig(process.cwd());
    let bad = 0;
    const all = [];
    for (const f of files) {
      let buf;
      try { buf = fs.readFileSync(f); } catch (e) { console.error(`cannot read ${f}: ${e.code}`); return 2; }
      const rel = path.relative(root, path.resolve(f)).replace(/\\/g, '/');
      const { findings } = inspectFile({ buf, relPath: rel, config });
      all.push({ file: f, findings });
      if (findings.some((x) => x.severity === 'block')) bad++;
      if (!json) { if (findings.length) printFindings(f, findings); else console.log(`OK    ${f}`); }
    }
    if (json) console.log(JSON.stringify(all, null, 2));
    return bad ? 1 : 0;
  }

  if (cmd === 'compare') {
    const files = args.filter((a) => !a.startsWith('--'));
    if (files.length !== 2) { console.error('usage: guard-hooks compare <before> <after>'); return 2; }
    const { config, root } = loadConfig(process.cwd());
    let before, after;
    try { before = fs.readFileSync(files[0]); after = fs.readFileSync(files[1]); } catch (e) { console.error(`cannot read file: ${e.code}`); return 2; }
    const rel = path.relative(root, path.resolve(files[1])).replace(/\\/g, '/');
    const findings = analyzeChange({ before, after, relPath: rel, config });
    if (json) console.log(JSON.stringify(findings, null, 2));
    else if (findings.length) printFindings(`${files[0]} -> ${files[1]}`, findings);
    else console.log(`OK    ${files[0]} -> ${files[1]}`);
    return findings.some((f) => f.severity === 'block') ? 1 : 0;
  }

  if (cmd === 'staged') {
    let results;
    try { results = checkStaged(process.cwd()); } catch (e) { console.error(`guard-hooks: ${String(e.stderr || e.message).trim()}`); return 2; }
    if (json) console.log(JSON.stringify(results, null, 2));
    else if (!results.length) console.log('OK    no encoding damage in staged files');
    else for (const r of results) printFindings(r.path, r.findings);
    return results.some((r) => r.findings.some((f) => f.severity === 'block')) ? 1 : 0;
  }

  if (cmd === 'classify') {
    let c;
    let label;
    const toolName = flag(args, '--tool');
    if (toolName) {
      let input = {};
      try { input = JSON.parse(flag(args, '--input') || '{}'); } catch { console.error('--input must be JSON'); return 2; }
      c = classifyTool(toolName, input, { cwd: process.cwd(), rules: loadConfig(process.cwd()).config.gate.rules });
      label = toolName;
    } else {
      const command = args.filter((a) => !a.startsWith('--')).join(' ');
      if (!command) { console.error('usage: guard-hooks classify "<command>"'); return 2; }
      c = classifyCommand(command, { tool: flag(args, '--shell') === 'powershell' ? 'PowerShell' : 'Bash' });
      label = command;
    }
    if (json) console.log(JSON.stringify(c, null, 2));
    else {
      console.log(`${c.level.padEnd(14)} ${label}`);
      if (c.levels.length > 1) console.log(`${''.padEnd(14)} levels: ${c.levels.join(', ')}`);
      if (c.flags.length) console.log(`${''.padEnd(14)} flags: ${c.flags.join(', ')}`);
      for (const r of c.reasons) console.log(`${''.padEnd(14)} ${r}`);
    }
    return 0;
  }

  if (cmd === 'levels') {
    if (json) console.log(JSON.stringify({ ladder: LEVELS }, null, 2));
    else for (const l of LEVELS) console.log(`${l.rank}  ${l.id.padEnd(14)} ${l.summary}`);
    return 0;
  }

  if (cmd === 'init') {
    const snippet = settingsSnippet({ gate: has(args, '--gate'), fix: !has(args, '--no-fix') });
    console.log(JSON.stringify(snippet, null, 2));
    if (isEphemeralInstall()) console.error('\nNote: this ran from an npx cache, so the hooks call "guard-hooks" on PATH. Install it first: npm install -g github:rishsadh/guard-hooks');
    console.error('\nMerge this into .claude/settings.json (project) or ~/.claude/settings.json (user). Nothing was written.');
    return 0;
  }

  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`guard-hooks: ${e.stack || e.message}`); process.exitCode = 1; });
