// A real run of the hooks against a scratch project. Nothing is mocked: each line is the exit
// code and stderr of the actual `guard-hooks pre-tool` and `gate` processes.
//   node examples/demo.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'guard-hooks.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hooks-demo-'));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const cp = String.fromCodePoint;

// The scratch project: a BOM file, a CRLF file, and a plain note.
fs.writeFileSync(path.join(dir, 'app.ini'), Buffer.concat([BOM, Buffer.from('name = caf' + cp(0xe9) + '\r\nmode = dev\r\n')]));
fs.writeFileSync(path.join(dir, 'config.cfg'), 'retries = 3\r\ntimeout = 30\r\n');
fs.writeFileSync(path.join(dir, 'notes.md'), 'Release notes\n');

// Mojibake made the way it really happens: UTF-8 bytes shown as Latin-1.
const damaged = Buffer.from('Gesti' + cp(0xf3) + 'n de M' + cp(0xe9) + 'dicos', 'utf8').toString('latin1');

function hook(sub, tool_name, tool_input) {
  const r = spawnSync(process.execPath, [bin, sub], { input: JSON.stringify({ cwd: dir, tool_name, tool_input }), encoding: 'utf8' });
  return r;
}
const first = (stderr) => {
  const m = /- ([a-z-]+): (.*)/.exec(stderr);
  return m ? m[1] : stderr.split('\n')[0];
};

const calls = [
  ['Write', 'notes.md', { file_path: 'notes.md', content: 'Release notes\nSecond line\n' }, 'adds a line'],
  ['Write', 'app.ini', { file_path: 'app.ini', content: 'name = caf' + cp(0xe9) + '\r\nmode = prod\r\n' }, 'drops the BOM'],
  ['Write', 'config.cfg', { file_path: 'config.cfg', content: 'retries = 5\ntimeout = 30\n' }, 'CRLF becomes LF'],
  ['Write', 'notes.md', { file_path: 'notes.md', content: damaged + '\n' }, 'writes mojibake'],
  ['Edit', 'notes.md', { file_path: 'notes.md', old_string: 'Release', new_string: damaged }, 'edit with mojibake'],
  ['PowerShell', '', { command: "(Get-Content app.ini) -replace 'dev','prod' | Set-Content app.ini" }, 'Get-Content to Set-Content'],
];

console.log(`guard-hooks pre-tool, ${calls.length} agent calls against a scratch project\n`);
for (const [tool, file, input, what] of calls) {
  const r = hook('pre-tool', tool, input);
  const verdict = r.status === 2 ? 'FAIL' : 'PASS';
  const why = r.status === 2 ? first(r.stderr) : 'allowed';
  console.log(`${verdict}  ${tool.padEnd(10)} ${file.padEnd(11)} ${what.padEnd(28)} ${why}`);
}

console.log('\nguard-hooks gate, the action level of each call\n');
const gates = [
  ['Bash', { command: 'git status' }],
  ['Bash', { command: 'npm install left-pad' }],
  ['Bash', { command: 'rm -rf build' }],
  ['Bash', { command: 'git push origin feature' }],
  ['Bash', { command: 'git push origin main' }],
  ['mcp__studio__generate_image', {}],
];
for (const [tool, input] of gates) {
  const r = spawnSync(process.execPath, [bin, 'classify', '--tool', tool, '--input', JSON.stringify(input), '--json'], { encoding: 'utf8' });
  const c = JSON.parse(r.stdout);
  const shown = input.command || tool;
  console.log(`${c.level.padEnd(14)} ${shown}`);
}

fs.rmSync(dir, { recursive: true, force: true });
