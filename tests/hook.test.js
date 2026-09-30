import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { preTool, postTool, gate, checkWrite } from '../src/hook.js';
import { BOM, tmpProject, rm, mojibake, codes } from './helpers.js';

const payload = (cwd, tool_name, tool_input, extra = {}) => ({ cwd, tool_name, tool_input, session_id: 's1', tool_use_id: 'toolu_' + Math.random().toString(16).slice(2), ...extra });

test('Write that drops the BOM is denied with a reason the agent can act on', () => {
  const dir = tmpProject({ 'app.ini': Buffer.concat([BOM, Buffer.from('k=v\r\n')]) });
  try {
    const r = preTool(payload(dir, 'Write', { file_path: path.join(dir, 'app.ini'), content: 'k=v\r\n' }));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /bom-lost/);
    assert.match(r.reason, /app\.ini/);
    assert.match(r.reason, /\.guard-hooks\.json/);
  } finally { rm(dir); }
});

test('Write that keeps the file intact is allowed silently', () => {
  const dir = tmpProject({ 'a.txt': 'one\r\ntwo\r\n' });
  try {
    const r = preTool(payload(dir, 'Write', { file_path: 'a.txt', content: 'one\r\ntwo\r\nthree\r\n' }));
    assert.equal(r.decision, 'allow');
    assert.equal(r.context, undefined);
  } finally { rm(dir); }
});

test('Write with mojibake in a new file is denied', () => {
  const dir = tmpProject();
  try {
    const r = preTool(payload(dir, 'Write', { file_path: 'notes.md', content: mojibake('\u00bfC\u00f3mo est\u00e1s?') }));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /mojibake-introduced/);
  } finally { rm(dir); }
});

test('the content field can be called file_text', () => {
  const dir = tmpProject({ 'a.txt': 'a\r\nb\r\n' });
  try {
    assert.equal(preTool(payload(dir, 'Write', { file_path: 'a.txt', file_text: 'a\nb\n' })).decision, 'deny');
  } finally { rm(dir); }
});

test('Edit is judged on its replacement text, not on the whole file', () => {
  const dir = tmpProject({ 'a.md': mojibake('caf\u00e9') + '\r\nsecond\r\n' });
  try {
    // Existing mojibake is not blamed on an edit that leaves it alone.
    const ok = preTool(payload(dir, 'Edit', { file_path: 'a.md', old_string: 'second', new_string: 'SECOND' }));
    assert.equal(ok.decision, 'allow');
    // An edit that writes new mojibake is denied.
    const bad = preTool(payload(dir, 'Edit', { file_path: 'a.md', old_string: 'second', new_string: mojibake('Gesti\u00f3n') }));
    assert.equal(bad.decision, 'deny');
  } finally { rm(dir); }
});

test('an Edit that only changes one line of a CRLF file is not blocked before it runs', () => {
  const dir = tmpProject({ 'a.txt': 'a\r\nb\r\n' });
  try {
    assert.equal(preTool(payload(dir, 'Edit', { file_path: 'a.txt', old_string: 'b', new_string: 'c\nd' })).decision, 'allow');
  } finally { rm(dir); }
});

test('MultiEdit checks every edit', () => {
  const dir = tmpProject({ 'a.md': 'x\n' });
  try {
    const r = preTool(payload(dir, 'MultiEdit', { file_path: 'a.md', edits: [
      { old_string: 'x', new_string: 'y' },
      { old_string: 'y', new_string: 'caf\ufffd' },
    ] }));
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /replacement-char-introduced/);
  } finally { rm(dir); }
});

test('the project config can allow a named finding for a path', () => {
  const dir = tmpProject({
    'run.bat': 'a\nb\n',
    '.guard-hooks.json': JSON.stringify({ allow: [{ glob: '**/*.bat', codes: ['eol-changed'] }] }),
  });
  try {
    assert.equal(preTool(payload(dir, 'Write', { file_path: 'run.bat', content: 'a\r\nb\r\n' })).decision, 'allow');
  } finally { rm(dir); }
});

test('a warning passes through as context, not a block', () => {
  const dir = tmpProject();
  try {
    const r = preTool(payload(dir, 'Write', { file_path: 'new.ps1', content: 'Write-Host "caf\u00e9"\r\n' }));
    assert.equal(r.decision, 'allow');
    assert.match(r.context, /bom-recommended/);
  } finally { rm(dir); }
});

test('shell commands: the PowerShell round trip is denied, a plain command is allowed', () => {
  const dir = tmpProject();
  try {
    const bad = preTool(payload(dir, 'PowerShell', { command: "(Get-Content a.js) -replace 'x','y' | Set-Content a.js" }));
    assert.equal(bad.decision, 'deny');
    assert.match(bad.reason, /ps-roundtrip/);
    assert.equal(preTool(payload(dir, 'Bash', { command: 'git status' })).decision, 'allow');
  } finally { rm(dir); }
});

test('other tools are ignored by pre-tool', () => {
  assert.equal(preTool(payload(process.cwd(), 'Read', { file_path: 'x' })).decision, 'allow');
});

test('post-tool restores a BOM the editor dropped, when --fix is on', () => {
  const dir = tmpProject({ 'a.ini': Buffer.concat([BOM, Buffer.from('k=v\r\n')]) });
  const file = path.join(dir, 'a.ini');
  try {
    const p = payload(dir, 'Edit', { file_path: file, old_string: 'v', new_string: 'w' });
    assert.equal(preTool(p).decision, 'allow'); // takes the snapshot
    fs.writeFileSync(file, 'k=w\r\n'); // the editor wrote the file without its BOM
    const r = postTool(p, { fix: true });
    assert.equal(r.decision, 'fixed');
    assert.deepEqual(fs.readFileSync(file), Buffer.concat([BOM, Buffer.from('k=w\r\n')]));
  } finally { rm(dir); }
});

test('post-tool reports damage it cannot fix, and leaves the file alone', () => {
  const dir = tmpProject({ 'a.md': 'caf\u00e9\n' });
  const file = path.join(dir, 'a.md');
  try {
    const p = payload(dir, 'Edit', { file_path: file, old_string: 'caf', new_string: 'caf' });
    preTool(p);
    const damaged = mojibake('caf\u00e9') + '\n';
    fs.writeFileSync(file, damaged);
    const r = postTool(p, { fix: true });
    assert.equal(r.decision, 'damage');
    assert.deepEqual(codes(r.findings), ['mojibake-introduced']);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  } finally { rm(dir); }
});

test('post-tool restores CRLF after an editor normalised the file to LF', () => {
  const dir = tmpProject({ 'a.txt': 'one\r\ntwo\r\n' });
  const file = path.join(dir, 'a.txt');
  try {
    const p = payload(dir, 'Write', { file_path: file, content: 'one\r\ntwo\r\nthree\r\n' });
    preTool(p);
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const r = postTool(p, { fix: true });
    assert.equal(r.decision, 'fixed');
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\ntwo\r\nthree\r\n');
  } finally { rm(dir); }
});

test('post-tool without --fix reports, and with no snapshot stays quiet', () => {
  const dir = tmpProject({ 'a.txt': 'one\r\n' });
  const file = path.join(dir, 'a.txt');
  try {
    const p = payload(dir, 'Write', { file_path: file, content: 'x\r\n' });
    preTool(p);
    fs.writeFileSync(file, 'x\n');
    assert.equal(postTool(p).decision, 'damage');
    assert.equal(postTool(payload(dir, 'Write', { file_path: file, content: 'x' })).decision, 'ok');
  } finally { rm(dir); }
});

test('checkWrite on a path outside any config still works', () => {
  const dir = tmpProject();
  try {
    assert.deepEqual(checkWrite('Write', { file_path: path.join(dir, 'n.txt'), content: 'plain\n' }, { cwd: dir }), []);
  } finally { rm(dir); }
});

test('gate asks for deploys and deletes, stays silent for reads and local writes', () => {
  const dir = tmpProject();
  try {
    assert.equal(gate(payload(dir, 'Bash', { command: 'git push origin main' })).decision, 'ask');
    assert.equal(gate(payload(dir, 'Bash', { command: 'rm -rf build' })).decision, 'ask');
    assert.equal(gate(payload(dir, 'Bash', { command: 'ls' })).decision, 'allow');
    assert.equal(gate(payload(dir, 'Write', { file_path: 'a.txt', content: 'x' })).decision, 'allow');
    assert.equal(gate(payload(dir, 'mcp__gmail__send_message', {})).decision, 'ask');
    assert.equal(gate(payload(dir, 'Bash', { command: 'npm publish' }), { deny: ['deploy'] }).decision, 'deny');
  } finally { rm(dir); }
});

test('gate reads project rules and policy from .guard-hooks.json', () => {
  const dir = tmpProject({
    '.guard-hooks.json': JSON.stringify({ gate: { ask: ['spend'], deny: ['delete'], rules: [{ tool: '^mcp__studio__render', level: 'spend' }] } }),
  });
  try {
    assert.equal(gate(payload(dir, 'mcp__studio__render_clip', {})).decision, 'ask');
    assert.equal(gate(payload(dir, 'Bash', { command: 'rm x' })).decision, 'deny');
    assert.equal(gate(payload(dir, 'Bash', { command: 'git push origin main' })).decision, 'allow');
  } finally { rm(dir); }
});
