'use strict';

const { ArchiveError } = require('./errors');

const METHODS_7Z = { lzma2: 'LZMA2', ppmd: 'PPMd', bzip2: 'BZip2', deflate: 'Deflate', copy: 'Copy' };
const METHODS_ZIP = { deflate: 'Deflate', bzip2: 'BZip2', lzma: 'LZMA', ppmd: 'PPMd', copy: 'Copy' };

// -y: assume yes. -bsp1: progress to stdout. -bso0/-bse1: quiet stdout, errors on stderr.
const QUIET = ['-y', '-bsp1', '-bso0', '-bse1'];

function clampLevel(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(9, Math.max(0, n)) : 5;
}

function safeVolume(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (!/^\d+[kmg]?$/.test(s)) throw new ArchiveError('BAD_OPTION', `Invalid volume size: ${v}`);
  return s;
}

/**
 * Build `7z a` arguments.
 * type: '7z' | 'zip' | 'tar' | 'gzip' | 'bzip2' | 'xz'
 */
function buildCreateArgs(o) {
  const a = ['a', ...QUIET, `-t${o.type}`, `-mx=${clampLevel(o.level)}`];
  if (o.type === '7z') {
    a.push(`-m0=${METHODS_7Z[o.method] || 'LZMA2'}`);
    a.push(o.solid === false ? '-ms=off' : '-ms=on');
  } else if (o.type === 'zip') {
    a.push(`-mm=${METHODS_ZIP[o.method] || 'Deflate'}`);
  }
  if (o.password) {
    a.push(`-p${o.password}`);
    if (o.type === 'zip') a.push('-mem=AES256');
    if (o.type === '7z' && o.encryptNames) a.push('-mhe=on');
  }
  const vol = safeVolume(o.volumeSize);
  if (vol && (o.type === '7z' || o.type === 'zip')) a.push(`-v${vol}`);
  for (const x of o.excludes || []) {
    const pat = String(x).trim();
    if (pat) a.push(`-xr!${pat}`);
  }
  a.push('--', o.out, ...o.sources);
  return a;
}

/** Build `7z x` arguments. overwrite: 'replace' | 'skip' | 'rename' */
function buildExtractArgs(o) {
  const overwriteSwitch = { replace: '-aoa', skip: '-aos', rename: '-aou' }[o.overwrite] || '-aou';
  const a = ['x', ...QUIET, `-o${o.dest}`, overwriteSwitch];
  if (o.password) a.push(`-p${o.password}`);
  if (o.listFile) a.push('-scsUTF-8', `-i@${o.listFile}`);
  a.push('--', o.archive);
  return a;
}

/** Build `7z l -slt` arguments (machine-readable listing). */
function buildListArgs(o) {
  const a = ['l', '-slt', '-sccUTF-8'];
  if (o.password) a.push(`-p${o.password}`);
  a.push('--', o.archive);
  return a;
}

/** Build `7z t` arguments (full read with CRC verification). */
function buildTestArgs(o) {
  const a = ['t', ...QUIET];
  if (o.password) a.push(`-p${o.password}`);
  a.push('--', o.archive);
  return a;
}

module.exports = {
  clampLevel,
  buildCreateArgs,
  buildExtractArgs,
  buildListArgs,
  buildTestArgs,
  METHODS_7Z,
  METHODS_ZIP,
};
