import test from 'node:test';
import assert from 'node:assert/strict';
import { lintShell, splitSegments, words } from '../src/shell.js';
import { codes } from './helpers.js';

const ps = (cmd, opts = {}) => lintShell(cmd, { tool: 'PowerShell', powershell: '5.1', ...opts });

test('splitSegments respects quotes and operators', () => {
  assert.deepEqual(splitSegments('a && b; c | d').map((s) => s.text), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitSegments('echo "a && b" ; ls').map((s) => s.text), ['echo "a && b"', 'ls']);
  assert.deepEqual(splitSegments("echo 'a;b'").map((s) => s.text), ["echo 'a;b'"]);
  assert.deepEqual(splitSegments('cmd 2>&1 | tee x').map((s) => s.text), ['cmd 2>&1', 'tee x']);
});

test('words strips quotes', () => {
  assert.deepEqual(words('git commit -m "a b" \'c d\''), ['git', 'commit', '-m', 'a b', 'c d']);
});

test('Get-Content piped to Set-Content without -Encoding is blocked on 5.1', () => {
  const f = ps("(Get-Content src\\app.js) -replace 'a','b' | Set-Content src\\app.js");
  assert.deepEqual(codes(f), ['ps-roundtrip']);
  assert.equal(f[0].severity, 'block');
});

test('the round trip that corrupted real source files is blocked: Get-Content -Raw then WriteAllText', () => {
  const cmd = "$c = Get-Content $f -Raw; $c = $c -replace 'organisation','organization'; [IO.File]::WriteAllText($f, $c)";
  const f = ps(cmd);
  assert.deepEqual(codes(f), ['ps-roundtrip']);
});

test('the same round trip with -Encoding on both ends is allowed', () => {
  const f = ps("Get-Content -Encoding UTF8 a.txt | ForEach-Object { $_ } | Set-Content -Encoding UTF8 b.txt");
  assert.deepEqual(f, []);
});

test('the round trip is not flagged on PowerShell 7', () => {
  assert.deepEqual(ps("(Get-Content a.js) -replace 'a','b' | Set-Content a.js", { powershell: '7' }), []);
});

test('Set-Content without -Encoding warns on 5.1 and stays quiet with it', () => {
  assert.deepEqual(codes(ps("Set-Content -Path a.txt -Value 'x'")), ['ps-write-default-encoding']);
  assert.deepEqual(ps("Set-Content -Path a.txt -Value 'x' -Encoding UTF8"), []);
});

test('redirection in PowerShell warns, in Bash it does not', () => {
  assert.deepEqual(codes(ps('Get-Date > out.txt')), ['ps-redirect-utf16']);
  assert.deepEqual(lintShell('date > out.txt', { tool: 'Bash' }), []);
  assert.deepEqual(ps('cmd 2>&1'), []);
  assert.deepEqual(ps('Get-Date > $null'), []);
});

test('WriteAllText without an encoding warns', () => {
  assert.deepEqual(codes(ps("[System.IO.File]::WriteAllText('a.txt', $t)")), ['dotnet-write-no-encoding']);
  assert.deepEqual(ps("[System.IO.File]::WriteAllText('a.txt', $t, (New-Object System.Text.UTF8Encoding $true))"), []);
});

test('an ASCII or default write encoding flag warns', () => {
  assert.ok(codes(ps("Out-File a.txt -Encoding ascii")).includes('ps-lossy-encoding-flag'));
});

test('line ending converters warn', () => {
  assert.deepEqual(codes(lintShell('dos2unix *.sh', { tool: 'Bash' })), ['eol-command']);
  assert.deepEqual(codes(lintShell("tr -d '\\r' < a > b", { tool: 'Bash' })), ['eol-command']);
});

test('ordinary commands are quiet', () => {
  for (const c of ['git status', 'npm test', 'ls -la', 'Get-ChildItem -Recurse', 'node build.mjs']) {
    assert.deepEqual(lintShell(c, { tool: 'Bash' }), [], c);
  }
});

test('redirection to a path with backslashes is still seen', () => {
  assert.deepEqual(codes(ps('Get-Date > out\today.txt')), ['ps-redirect-utf16']);
});
