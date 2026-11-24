'use strict';

const fs = require('fs');
const path = require('path');

// Magic bytes at offset 0.
const SIGNATURES = [
  { kind: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { kind: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }, // RAR 4 and RAR 5
  { kind: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty ZIP
  { kind: 'zst', bytes: [0x28, 0xb5, 0x2f, 0xfd] },
  { kind: 'xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { kind: 'gz', bytes: [0x1f, 0x8b] },
  { kind: 'bz2', bytes: [0x42, 0x5a, 0x68] },
  { kind: 'par2', bytes: [0x50, 0x41, 0x52, 0x32, 0x00] },
];

const LABELS = {
  '7z': '7Z',
  rar: 'RAR',
  zip: 'ZIP',
  tar: 'TAR',
  'tar.gz': 'TAR.GZ',
  'tar.bz2': 'TAR.BZ2',
  'tar.xz': 'TAR.XZ',
  'tar.zst': 'TAR.ZST',
  gz: 'GZIP',
  bz2: 'BZIP2',
  xz: 'XZ',
  zst: 'ZSTD',
  par2: 'PAR2 recovery',
};

function matches(buf, bytes) {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/** Read the first bytes of a file and report the signature found. */
function sniff(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(512);
    const n = fs.readSync(fd, head, 0, 512, 0);
    const buf = head.subarray(0, n);
    const sig = SIGNATURES.find((s) => matches(buf, s.bytes));
    const tar = n >= 262 && buf.subarray(257, 262).toString('latin1') === 'ustar';
    return { kind: sig ? sig.kind : null, tar };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Detect what an archive is. Returns one of:
 * '7z' | 'rar' | 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'tar.zst'
 * | 'gz' | 'bz2' | 'xz' | 'zst' | 'par2' | null
 */
function detectKind(file) {
  const { kind, tar } = sniff(file);
  if (tar) return 'tar';
  if (!kind) return null;
  if (['gz', 'bz2', 'xz', 'zst'].includes(kind)) {
    const name = path.basename(file).toLowerCase();
    const looksTar = /\.tar(\.|$)/.test(name) || /\.(tgz|tbz2?|txz|tzst)$/.test(name);
    return looksTar ? `tar.${kind}` : kind;
  }
  return kind;
}

module.exports = { detectKind, sniff, LABELS };
