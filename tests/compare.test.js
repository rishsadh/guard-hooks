import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChange, inspectFile, fingerprint } from '../src/compare.js';
import { normalizeConfig, matchesGlob } from '../src/config.js';
import { BOM, mojibake, codes } from './helpers.js';

const utf8 = (s) => Buffer.from(s, 'utf8');
const withBom = (s) => Buffer.concat([BOM, utf8(s)]);

test('lost BOM is blocked', () => {
  const before = withBom('name = "caf\u00e9"\r\n');
  const f = analyzeChange({ before, after: 'name = "caf\u00e9"\r\n', relPath: 'a.ini' });
  assert.deepEqual(codes(f), ['bom-lost']);
  assert.equal(f[0].severity, 'block');
});

test('a write that keeps the BOM passes', () => {
  const before = withBom('one\r\ntwo\r\n');
  assert.deepEqual(analyzeChange({ before, after: '\ufeffone\r\nTWO\r\n', relPath: 'a.txt' }), []);
});

test('added BOM on an existing file is blocked, on a new file it is not', () => {
  assert.deepEqual(codes(analyzeChange({ before: utf8('x\n'), after: '\ufeffx\n', relPath: 'a.sh' })), ['bom-added']);
  assert.deepEqual(analyzeChange({ before: null, after: '\ufeffx\n', relPath: 'a.sh' }), []);
});

test('CRLF file rewritten with LF is blocked', () => {
  const f = analyzeChange({ before: utf8('a\r\nb\r\nc\r\n'), after: 'a\nb\nc\n', relPath: 'x.txt' });
  assert.deepEqual(codes(f), ['eol-changed']);
  assert.match(f[0].message, /CRLF/);
});

test('LF file rewritten with CRLF is blocked', () => {
  assert.deepEqual(codes(analyzeChange({ before: utf8('a\nb\n'), after: 'a\r\nb\r\n', relPath: 'x.txt' })), ['eol-changed']);
});

test('adding LF lines to a CRLF file makes it mixed and is blocked', () => {
  const f = analyzeChange({ before: utf8('a\r\nb\r\n'), after: 'a\r\nb\r\nc\nd\n', relPath: 'x.txt' });
  assert.deepEqual(codes(f), ['eol-mixed']);
  assert.match(f[0].message, /2 lines/);
});

test('a file that was already mixed is left alone', () => {
  assert.deepEqual(analyzeChange({ before: utf8('a\r\nb\nc\r\n'), after: 'a\nb\nc\n', relPath: 'x.txt' }), []);
});

test('a one-line file with no line ending raises no EOL finding', () => {
  assert.deepEqual(analyzeChange({ before: utf8('one'), after: 'one\ntwo\n', relPath: 'x.txt' }), []);
});

test('new mojibake is blocked and names a repair', () => {
  const damaged = mojibake('Gesti\u00f3n');
  const f = analyzeChange({ before: utf8('Gestion\n'), after: damaged + '\n', relPath: 'x.md' });
  assert.deepEqual(codes(f), ['mojibake-introduced']);
  assert.match(f[0].message, /should be/);
});

test('existing mojibake is not blamed on an unrelated edit', () => {
  const before = utf8(mojibake('Gesti\u00f3n') + '\nother\n');
  assert.deepEqual(analyzeChange({ before, after: mojibake('Gesti\u00f3n') + '\nOTHER\n', relPath: 'x.md' }), []);
});

test('mojibake in a brand new file is blocked', () => {
  assert.deepEqual(codes(analyzeChange({ before: null, after: mojibake('\u00bfC\u00f3mo?'), relPath: 'new.txt' })), ['mojibake-introduced']);
});

test('replacement characters and lossy question marks are blocked', () => {
  const before = utf8('caf\u00e9 na\u00efve\n');
  assert.deepEqual(codes(analyzeChange({ before, after: 'caf\ufffd na\ufffdve\n', relPath: 'x.txt' })), ['replacement-char-introduced']);
  assert.deepEqual(codes(analyzeChange({ before, after: 'caf? na?ve\n', relPath: 'x.txt' })), ['lossy-question-marks']);
});

test('a file that is not valid UTF-8 is flagged before it is converted', () => {
  const latin1 = Buffer.from('caf\u00e9\n', 'latin1');
  const f = analyzeChange({ before: latin1, after: 'caf\u00e9 au lait\n', relPath: 'x.txt' });
  assert.ok(codes(f).includes('legacy-encoding-rewritten'));
});

test('UTF-16 files that turn into UTF-8 are flagged', () => {
  const before = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\r\n', 'utf16le')]);
  assert.deepEqual(codes(analyzeChange({ before, after: 'hi\r\n', relPath: 'x.txt' })), ['encoding-changed']);
});

test('binary files and binary extensions are skipped', () => {
  assert.deepEqual(analyzeChange({ before: Buffer.from([0, 1, 2, 0xff]), after: Buffer.from([0, 9, 9]), relPath: 'x.dat' }), []);
  assert.deepEqual(analyzeChange({ before: utf8('a'), after: 'b\ufffd', relPath: 'logo.png' }), []);
});

test('a new PowerShell script with non-ASCII text and no BOM gets a warning, ASCII does not', () => {
  assert.deepEqual(codes(analyzeChange({ before: null, after: 'Write-Host "caf\u00e9"\n', relPath: 'a.ps1' })), ['bom-recommended']);
  assert.deepEqual(analyzeChange({ before: null, after: 'Write-Host "cafe"\n', relPath: 'a.ps1' }), []);
  assert.equal(analyzeChange({ before: null, after: 'Write-Host "caf\u00e9"\n', relPath: 'a.ps1' })[0].severity, 'warn');
});

test('requireBom turns the new-file rule into a block', () => {
  const config = normalizeConfig({ requireBom: ['**/*.pas'] });
  assert.deepEqual(codes(analyzeChange({ before: null, after: "'\u00bfC\u00f3mo?'\n", relPath: 'src/unit.pas', config })), ['bom-required']);
  assert.deepEqual(analyzeChange({ before: null, after: "\ufeff'\u00bfC\u00f3mo?'\n", relPath: 'src/unit.pas', config }), []);
});

test('allow and ignore in the config silence named findings', () => {
  const config = normalizeConfig({
    allow: [{ glob: '**/*.bat', codes: ['eol-changed'] }],
    ignore: ['vendor/**'],
  });
  assert.deepEqual(analyzeChange({ before: utf8('a\nb\n'), after: 'a\r\nb\r\n', relPath: 'tools/run.bat', config }), []);
  assert.deepEqual(codes(analyzeChange({ before: utf8('a\nb\n'), after: 'a\r\nb\r\n', relPath: 'tools/run.txt', config })), ['eol-changed']);
  assert.deepEqual(analyzeChange({ before: utf8('a\nb\n'), after: 'a\r\nb\r\n', relPath: 'vendor/x/y.txt', config }), []);
});

test('glob matching', () => {
  assert.ok(matchesGlob('**/*.ps1', 'a.ps1'));
  assert.ok(matchesGlob('**/*.ps1', 'x/y/a.PS1'));
  assert.ok(matchesGlob('src/**', 'src/a/b.js'));
  assert.ok(!matchesGlob('*.js', 'src/a.js'));
  assert.ok(matchesGlob('docs/?.md', 'docs/a.md'));
});

test('a bad config is refused with a clear message', () => {
  assert.throws(() => normalizeConfig({ allow: [{ codes: ['x'] }] }), /glob/);
  assert.throws(() => normalizeConfig({ ignore: 'x' }), /ignore/);
});

test('inspectFile reports mixed line endings as a warning', () => {
  const { findings } = inspectFile({ buf: utf8('a\r\nb\nc\n'), relPath: 'x.txt' });
  assert.deepEqual(codes(findings), ['mixed-line-endings']);
});

test('fingerprint keeps no file content', () => {
  const fp = fingerprint(withBom('secret text\r\n'));
  assert.equal(fp.bom, 'utf8');
  assert.equal(fp.eol.crlf, 1);
  assert.ok(!JSON.stringify(fp).includes('secret'));
});
