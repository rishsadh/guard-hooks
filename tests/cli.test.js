import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BOM, tmpProject, rm, mojibake } from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'guard-hooks.js');
const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });

test('pre-tool: exit 2 and a stderr reason when a write would drop the BOM', () => {
  const dir = tmpProject({ 'a.ini': Buffer.concat([BOM, Buffer.from('k=v\n')]) });
  try {
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: 'a.ini', content: 'k=v\n' } });
    const r = run(['pre-tool'], { input });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /bom-lost/);
    assert.equal(r.stdout, '');
  } finally { rm(dir); }
});

test('pre-tool: exit 0 and no output for a clean write', () => {
  const dir = tmpProject();
  try {
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'hello\n' } });
    const r = run(['pre-tool'], { input });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { rm(dir); }
});

test('pre-tool: a warning is printed as additionalContext JSON', () => {
  const dir = tmpProject();
  try {
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: 'a.ps1', content: 'Write-Host "caf\u00e9"\n' } });
    const r = run(['pre-tool'], { input });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /bom-recommended/);
  } finally { rm(dir); }
});

test('hooks fail open on unreadable input', () => {
  assert.equal(run(['pre-tool'], { input: 'not json' }).status, 0);
  assert.equal(run(['pre-tool'], { input: '' }).status, 0);
  assert.equal(run(['gate'], { input: '{' }).status, 0);
});

test('hooks accept stdin that starts with a BOM', () => {
  const dir = tmpProject({ 'a.txt': 'a\r\nb\r\n' });
  try {
    const input = '\ufeff' + JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'a\nb\n' } });
    assert.equal(run(['pre-tool'], { input }).status, 2);
  } finally { rm(dir); }
});

test('gate: prints an ask decision as JSON, and stays silent for a read', () => {
  const dir = tmpProject();
  try {
    const ask = run(['gate'], { input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }) });
    assert.equal(ask.status, 0);
    const out = JSON.parse(ask.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /deploy/);
    const read = run(['gate'], { input: JSON.stringify({ cwd: dir, tool_name: 'Read', tool_input: {} }) });
    assert.equal(read.stdout, '');
    const deny = run(['gate', '--deny', 'deploy'], { input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm publish' } }) });
    assert.equal(deny.status, 2);
  } finally { rm(dir); }
});

test('check: clean file exits 0, damaged file exits 1', () => {
  const dir = tmpProject({ 'ok.txt': 'fine\n', 'bad.txt': mojibake('\u00bfC\u00f3mo?') + '\n' });
  try {
    assert.equal(run(['check', path.join(dir, 'ok.txt')]).status, 0);
    const bad = run(['check', path.join(dir, 'bad.txt')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /mojibake-introduced/);
  } finally { rm(dir); }
});

test('compare: reports a lost BOM between two files', () => {
  const dir = tmpProject({ 'before.txt': Buffer.concat([BOM, Buffer.from('x\n')]), 'after.txt': 'x\n' });
  try {
    const r = run(['compare', path.join(dir, 'before.txt'), path.join(dir, 'after.txt'), '--json']);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout)[0].code, 'bom-lost');
  } finally { rm(dir); }
});

test('classify, levels and init', () => {
  const c = run(['classify', 'git push origin main', '--json']);
  assert.equal(JSON.parse(c.stdout).level, 'deploy');
  assert.match(run(['classify', 'rm', '-rf', 'build']).stdout, /^delete/);
  assert.match(run(['classify', '--tool', 'mcp__gmail__send_message']).stdout, /^external-send/);
  assert.equal(JSON.parse(run(['levels', '--json']).stdout).ladder.length, 6);
  const init = JSON.parse(run(['init', '--gate']).stdout);
  assert.equal(init.hooks.PreToolUse.length, 2);
  assert.match(init.hooks.PostToolUse[0].hooks[0].command, /post-tool --fix/);
  assert.equal(run(['nonsense']).status, 2);
  assert.match(run(['--help']).stdout, /pre-tool/);
});

test('staged: flags a lost BOM and new mojibake in a commit, passes a clean one', () => {
  const dir = tmpProject();
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.ini'), Buffer.concat([BOM, Buffer.from('k=v\r\n')]));
    fs.writeFileSync(path.join(dir, 'n.md'), 'clean\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    // clean change
    fs.writeFileSync(path.join(dir, 'n.md'), 'still clean\n');
    git('add', '-A');
    assert.equal(run(['staged'], { cwd: dir }).status, 0);
    // damaging changes
    fs.writeFileSync(path.join(dir, 'a.ini'), 'k=v\r\n');
    fs.writeFileSync(path.join(dir, 'new.md'), mojibake('Gesti\u00f3n') + '\n');
    git('add', '-A');
    const r = run(['staged'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /a\.ini.*bom-lost/);
    assert.match(r.stdout, /new\.md.*mojibake-introduced/);
  } finally { rm(dir); }
});

test('staged works in a repository with no commits yet', () => {
  const dir = tmpProject({ 'x.md': mojibake('caf\u00e9') + '\n' });
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    assert.equal(run(['staged'], { cwd: dir }).status, 1);
  } finally { rm(dir); }
});

test('the example config in examples/ is valid', async () => {
  const { normalizeConfig } = await import('../src/config.js');
  const raw = JSON.parse(fs.readFileSync(new URL('../examples/guard-hooks.example.json', import.meta.url), 'utf8'));
  const cfg = normalizeConfig(raw);
  assert.equal(cfg.gate.rules.length, 2);
});
