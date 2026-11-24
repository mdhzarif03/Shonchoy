'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectKind } = require('../src/engine/detect');
const args = require('../src/engine/args');
const { parseSlt, lastPercent, classifyError, safeRelPath, normPath } = require('../src/engine/parse');
const { expandSelection } = require('../src/engine/select');
const { safeTarget, resolveName } = require('../src/engine/fsutil');
const { FORMATS } = require('../src/engine/archive');

function tempFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shonchoy-t-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}

// ---- detection by signature, not extension ------------------------------

test('detects 7z, zip, rar, gzip, xz, zstd and PAR2 from magic bytes', () => {
  assert.equal(detectKind(tempFile('x.bin', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0])), '7z');
  assert.equal(detectKind(tempFile('x.dat', [0x50, 0x4b, 0x03, 0x04, 0, 0])), 'zip');
  assert.equal(detectKind(tempFile('x.rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0])), 'rar');
  assert.equal(detectKind(tempFile('plain.gz', [0x1f, 0x8b, 8, 0])), 'gz');
  assert.equal(detectKind(tempFile('bundle.tar.gz', [0x1f, 0x8b, 8, 0])), 'tar.gz');
  assert.equal(detectKind(tempFile('bundle.tar.xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])), 'tar.xz');
  assert.equal(detectKind(tempFile('bundle.tar.zst', [0x28, 0xb5, 0x2f, 0xfd])), 'tar.zst');
  assert.equal(detectKind(tempFile('x.par2', [0x50, 0x41, 0x52, 0x32, 0x00, 0x50])), 'par2');
});

test('returns null for unknown content and detects raw tar via ustar marker', () => {
  assert.equal(detectKind(tempFile('notes.zip', Buffer.from('just text'))), null);
  const block = Buffer.alloc(512);
  block.write('ustar', 257, 'latin1');
  assert.equal(detectKind(tempFile('raw.tar', block)), 'tar');
});

// ---- argument builders -----------------------------------------------------

test('7z create args: method, level, encryption, encrypted names, volumes, excludes', () => {
  const a = args.buildCreateArgs({
    type: '7z', level: 9, method: 'lzma2', password: 'secret', encryptNames: true,
    volumeSize: '100m', excludes: ['Thumbs.db'], out: 'C:\\out\\a.7z', sources: ['C:\\in'],
  });
  assert.ok(a.includes('-t7z'));
  assert.ok(a.includes('-mx=9'));
  assert.ok(a.includes('-m0=LZMA2'));
  assert.ok(a.includes('-psecret'));
  assert.ok(a.includes('-mhe=on'));
  assert.ok(a.includes('-v100m'));
  assert.ok(a.includes('-xr!Thumbs.db'));
  assert.deepEqual(a.slice(-3), ['--', 'C:\\out\\a.7z', 'C:\\in']);
});

test('zip encryption uses AES-256 and never encrypted names', () => {
  const a = args.buildCreateArgs({ type: 'zip', level: 5, method: 'deflate', password: 'pw', encryptNames: true, out: 'o.zip', sources: ['s'] });
  assert.ok(a.includes('-mem=AES256'));
  assert.ok(!a.some((x) => x.startsWith('-mhe')));
  assert.ok(a.includes('-mm=Deflate'));
});

test('no password means no encryption switches', () => {
  const a = args.buildCreateArgs({ type: 'zip', level: 3, out: 'o.zip', sources: ['s'] });
  assert.ok(!a.some((x) => x.startsWith('-p')));
  assert.ok(!a.includes('-mem=AES256'));
});

test('volume size is validated and level is clamped', () => {
  assert.throws(() => args.buildCreateArgs({ type: '7z', out: 'o', sources: ['s'], volumeSize: '1; rm' }));
  assert.equal(args.clampLevel(42), 9);
  assert.equal(args.clampLevel(-3), 0);
  assert.equal(args.clampLevel('abc'), 5);
});

test('extract args map overwrite policy to 7-Zip switches', () => {
  assert.ok(args.buildExtractArgs({ archive: 'a', dest: 'd', overwrite: 'replace' }).includes('-aoa'));
  assert.ok(args.buildExtractArgs({ archive: 'a', dest: 'd', overwrite: 'skip' }).includes('-aos'));
  assert.ok(args.buildExtractArgs({ archive: 'a', dest: 'd', overwrite: 'rename' }).includes('-aou'));
  const withList = args.buildExtractArgs({ archive: 'a', dest: 'd', overwrite: 'rename', listFile: 'L.txt' });
  assert.ok(withList.includes('-i@L.txt'));
});

// ---- listing parser --------------------------------------------------------

const SLT = `Listing archive: demo.7z

--
Path = demo.7z
Type = 7z
Physical Size = 900
Solid = +

----------
Path = docs
Size = 0
Packed Size = 0
Modified = 2026-03-01 10:00:00
Attributes = D_ drwxr-xr-x
Folder = +
Encrypted = -

Path = docs\\readme.txt
Size = 1200
Packed Size = 300
Modified = 2026-03-01 10:05:30
Attributes = A_ -rw-r--r--
Folder = -
Encrypted = +
CRC = ABCD1234

Path = photo.jpg
Size = 5000
Packed Size = 4900
Folder = -
Encrypted = -
`;

test('parseSlt returns items, skips archive header, handles folders and encryption', () => {
  const e = parseSlt(SLT);
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((x) => x.name), ['docs', 'docs/readme.txt', 'photo.jpg']);
  assert.equal(e[0].kind, 'dir');
  assert.equal(e[1].kind, 'file');
  assert.equal(e[1].size, 1200);
  assert.equal(e[1].packed, 300);
  assert.equal(e[1].encrypted, true);
  assert.equal(e[2].encrypted, false);
});

test('parseSlt returns an empty list for empty output', () => {
  assert.deepEqual(parseSlt(''), []);
});

// ---- progress, errors, paths ----------------------------------------------

test('lastPercent reads the most recent percentage', () => {
  assert.equal(lastPercent('\b\b 5%'), 5);
  assert.equal(lastPercent(' 12% 3 + a.txt\b\b\b 47%'), 47);
  assert.equal(lastPercent('no numbers here'), null);
  assert.equal(lastPercent('Compressing 62.5%'), 62.5);
});

test('classifyError maps engine messages to stable codes', () => {
  assert.equal(classifyError('Wrong password?', false), 'PASSWORD_REQUIRED');
  assert.equal(classifyError('Wrong password?', true), 'WRONG_PASSWORD');
  assert.equal(classifyError('Data Error : CRC Failed', false), 'CORRUPT');
  assert.equal(classifyError('There is not enough space left on the device', false), 'DISK_FULL');
  assert.equal(classifyError('something odd', false), 'FAILED');
});

test('safeRelPath blocks traversal, absolute and drive paths', () => {
  assert.equal(safeRelPath('../evil'), null);
  assert.equal(safeRelPath('a/../../b'), null);
  assert.equal(safeRelPath('/etc/passwd'), null);
  assert.equal(safeRelPath('C:\\Windows\\x'), null);
  assert.equal(safeRelPath('./dir\\file.txt'), 'dir/file.txt');
  assert.equal(normPath('.\\docs\\'), 'docs');
});

test('safeTarget keeps every write inside the destination', () => {
  const dest = path.join(os.tmpdir(), 'dest-root');
  assert.equal(safeTarget(dest, '../x'), null);
  const t = safeTarget(dest, 'sub/file.txt');
  assert.ok(t.startsWith(path.resolve(dest) + path.sep));
});

test('resolveName renames, replaces or skips duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shonchoy-n-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'x');
  assert.equal(path.basename(resolveName(f, 'rename')), 'a (2).txt');
  assert.equal(resolveName(f, 'skip'), null);
  assert.equal(resolveName(f, 'replace'), f);
  assert.equal(resolveName(path.join(dir, 'new.txt'), 'skip'), path.join(dir, 'new.txt'));
});

// ---- selection expansion ---------------------------------------------------

test('expandSelection expands folders to their files and keeps files', () => {
  const entries = [
    { name: 'docs', kind: 'dir' },
    { name: 'docs/a.txt', kind: 'file' },
    { name: 'docs/sub/b.txt', kind: 'file' },
    { name: 'photo.jpg', kind: 'file' },
  ];
  assert.deepEqual(expandSelection(['docs/'], entries).sort(), ['docs/a.txt', 'docs/sub/b.txt']);
  assert.deepEqual(expandSelection(['photo.jpg'], entries), ['photo.jpg']);
  assert.equal(expandSelection([], entries), null);
});

// ---- format catalogue ------------------------------------------------------

test('format catalogue: encryption and volumes only where supported', () => {
  assert.equal(FORMATS['7z'].encrypt, true);
  assert.equal(FORMATS.zip.encrypt, true);
  assert.equal(FORMATS['tar.gz'].encrypt, undefined);
  assert.equal(FORMATS['tar.zst'].compressor, 'zstd');
});
