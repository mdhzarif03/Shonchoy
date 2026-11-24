'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const tools = require('./tools');
const detect = require('./detect');
const proc = require('./proc');
const zstd = require('./zstd');
const par2 = require('./par2');
const rarEngine = require('./rar');
const args = require('./args');
const { ArchiveError } = require('./errors');
const { rmSafe } = require('./jobs');
const { parseSlt } = require('./parse');
const { expandSelection } = require('./select');
const { safeTarget, resolveName } = require('./fsutil');

/** Output formats. `compressType` / `compressor` mark two-step (tar, then compress). */
const FORMATS = {
  '7z': { ext: '.7z', type: '7z', encrypt: true, volumes: true, methods: ['lzma2', 'ppmd', 'bzip2', 'deflate', 'copy'] },
  zip: { ext: '.zip', type: 'zip', encrypt: true, volumes: true, methods: ['deflate', 'bzip2', 'lzma', 'ppmd', 'copy'] },
  tar: { ext: '.tar', type: 'tar' },
  'tar.gz': { ext: '.tar.gz', type: 'tar', compressType: 'gzip' },
  'tar.bz2': { ext: '.tar.bz2', type: 'tar', compressType: 'bzip2' },
  'tar.xz': { ext: '.tar.xz', type: 'tar', compressType: 'xz' },
  'tar.zst': { ext: '.tar.zst', type: 'tar', compressor: 'zstd' },
};

/** Parsed listings cached per archive path so folder selections can be expanded. */
const listCache = new Map();

function formats() {
  return Object.entries(FORMATS).map(([id, s]) => ({
    id,
    ext: s.ext,
    encrypt: !!s.encrypt,
    volumes: !!s.volumes,
    methods: s.methods || [],
    needsTool: s.compressor ? 'zstd' : null,
  }));
}

function sevenZip() {
  const p = tools.paths().sevenZip;
  if (!p) throw new ArchiveError('ENGINE_MISSING', '7-Zip engine not found. Run "npm install".');
  return p;
}

/** Split volumes are named <name>.001, <name>.002, ... */
function volumeFiles(out, volumeSize) {
  if (!volumeSize) return fs.existsSync(out) ? [out] : [];
  const dir = path.dirname(out);
  const base = path.basename(out);
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(base + '.') && /\.\d{3}$/.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

/** Remove an archive and its volumes and PAR2 files. Used on failure and before overwrite. */
function removeArtifacts(out) {
  const dir = path.dirname(out);
  const base = path.basename(out);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const mine =
      n === base ||
      (n.startsWith(base + '.') && (/\.\d{3}$/.test(n) || /\.par2$/i.test(n)));
    if (mine) rmSafe(path.join(dir, n));
  }
}

function writeListFile(names, job) {
  const file = path.join(os.tmpdir(), `shonchoy-list-${randomUUID()}.txt`);
  const sep = process.platform === 'win32' ? '\\' : '/';
  fs.writeFileSync(file, names.map((n) => n.split('/').join(sep)).join('\n'), 'utf8');
  job.temps.push(file);
  return file;
}

async function listWith7z(file, password) {
  const res = await proc.run(sevenZip(), args.buildListArgs({ archive: file, password }));
  proc.ensureOk(res, { hadPassword: !!password });
  return parseSlt(res.out);
}

/** Open an archive and return its listing. Throws PASSWORD_REQUIRED when needed. */
async function openArchive(file, password) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new ArchiveError('NOT_FOUND', 'File not found.');
  const kind = detect.detectKind(abs);
  if (!kind) {
    throw new ArchiveError(
      'UNSUPPORTED',
      'Not a recognized archive. Supported: 7z, ZIP, RAR, TAR, GZ, BZ2, XZ, ZST.'
    );
  }
  if (kind === 'par2') {
    return { path: abs, name: path.basename(abs), kind, label: detect.LABELS.par2, recovery: true, entries: [] };
  }

  let entries;
  if (kind === 'rar') {
    entries = await rarEngine.list(abs, password);
  } else if (kind === 'zst') {
    entries = [
      {
        name: path.basename(abs).replace(/\.zst$/i, ''),
        kind: 'file',
        size: 0,
        packed: null,
        modified: 0,
        encrypted: false,
      },
    ];
  } else if (kind === 'tar.zst') {
    const tmp = path.join(os.tmpdir(), `shonchoy-${randomUUID()}.tar`);
    try {
      await zstd.decompress(abs, tmp, null);
      entries = await listWith7z(tmp, undefined);
    } finally {
      rmSafe(tmp);
    }
  } else {
    entries = await listWith7z(abs, password);
  }

  listCache.set(abs, entries);
  return {
    path: abs,
    name: path.basename(abs),
    kind,
    label: detect.LABELS[kind] || kind.toUpperCase(),
    recovery: false,
    entries,
    encrypted: entries.some((e) => e.encrypted),
    totalSize: entries.reduce((s, e) => s + (e.kind === 'file' ? e.size : 0), 0),
    onDiskSize: fs.statSync(abs).size,
  };
}

async function entriesFor(archive, password) {
  const key = path.resolve(archive);
  if (listCache.has(key)) return listCache.get(key);
  return (await openArchive(key, password)).entries;
}

/** Create an archive. ctx = { job, progress(percent, label) }. */
async function createArchive(o, ctx) {
  const { job, progress } = ctx;
  const spec = FORMATS[o.format];
  if (!spec) throw new ArchiveError('UNSUPPORTED', `Unknown format: ${o.format}`);
  const sources = (o.sources || []).map((p) => path.resolve(p));
  if (!sources.length) throw new ArchiveError('EMPTY', 'Add at least one file or folder.');
  if (!o.out) throw new ArchiveError('NO_OUTPUT', 'Choose where to save the archive.');
  if (o.password && !spec.encrypt) {
    throw new ArchiveError('NO_ENCRYPTION', `${o.format} cannot be password protected. Use 7z or ZIP.`);
  }
  if (o.volumeSize && !spec.volumes) {
    throw new ArchiveError('NO_VOLUMES', `${o.format} does not support volumes. Use 7z or ZIP.`);
  }
  if (spec.compressor === 'zstd') zstd.requireZstd();
  if ((o.recoveryPercent || 0) > 0) par2.requirePar2();

  const exe = sevenZip();
  let out = path.resolve(o.out);
  if (!out.toLowerCase().endsWith(spec.ext)) out += spec.ext;
  if (fs.existsSync(out)) {
    if (!o.overwrite) throw new ArchiveError('EXISTS', `${path.basename(out)} already exists.`);
    // 7-Zip would update an existing archive instead of replacing it, so remove it first.
    removeArtifacts(out);
  }

  const level = args.clampLevel(o.level);
  const excludes = o.excludes || [];
  try {
    if (spec.compressType || spec.compressor) {
      const tmpTar = path.join(os.tmpdir(), `shonchoy-${randomUUID()}.tar`);
      job.temps.push(tmpTar);
      await proc.runOk(
        exe,
        args.buildCreateArgs({ type: 'tar', level: 0, out: tmpTar, sources, excludes }),
        { job, onProgress: (p) => progress(p * 0.5, 'Bundling') }
      );
      if (spec.compressor === 'zstd') {
        progress(50, 'Compressing');
        await zstd.compress(tmpTar, out, level, job);
      } else {
        await proc.runOk(
          exe,
          args.buildCreateArgs({ type: spec.compressType, level, out, sources: [tmpTar] }),
          { job, onProgress: (p) => progress(50 + p * 0.5, 'Compressing') }
        );
      }
    } else {
      await proc.runOk(
        exe,
        args.buildCreateArgs({
          type: spec.type,
          level,
          method: o.method,
          password: o.password,
          encryptNames: o.encryptNames,
          volumeSize: o.volumeSize,
          solid: o.solid,
          excludes,
          out,
          sources,
        }),
        { job, onProgress: (p) => progress(p, 'Compressing') }
      );
    }
    job.check();

    const parts = volumeFiles(out, o.volumeSize);
    const testTarget = o.volumeSize ? parts[0] : out;
    if (o.verify) {
      progress(0, 'Verifying');
      await testArchive({ archive: testTarget, password: o.password }, ctx);
    }
    if ((o.recoveryPercent || 0) > 0) {
      progress(0, 'Creating recovery data');
      await par2.create(parts, o.recoveryPercent, `${out}.par2`, {
        job,
        onProgress: (p) => progress(p, 'Creating recovery data'),
      });
    }
    progress(100, 'Done');
    return {
      out,
      parts,
      bytes: parts.reduce((s, f) => s + fs.statSync(f).size, 0),
      recovery: (o.recoveryPercent || 0) > 0,
    };
  } catch (e) {
    removeArtifacts(out);
    throw e;
  }
}

/** Extract an archive. ctx = { job, progress }. */
async function extractArchive(o, ctx) {
  const { job, progress } = ctx;
  const kind = detect.detectKind(o.archive);
  if (!kind) throw new ArchiveError('UNSUPPORTED', 'Not a recognized archive.');
  if (kind === 'par2') {
    throw new ArchiveError('UNSUPPORTED', 'PAR2 files are recovery data. Use the Recovery tab.');
  }
  if (!o.dest) throw new ArchiveError('NO_OUTPUT', 'Choose a destination folder.');
  const dest = path.resolve(o.dest);
  fs.mkdirSync(dest, { recursive: true });
  const overwrite = ['rename', 'replace', 'skip'].includes(o.overwrite) ? o.overwrite : 'rename';

  if (kind === 'rar') {
    const entries = await entriesFor(o.archive, o.password);
    const names = expandSelection(o.selected, entries);
    if (o.selected && o.selected.length && names && names.length === 0) {
      throw new ArchiveError('EMPTY_SELECTION', 'Nothing to extract in that selection.');
    }
    const r = await rarEngine.extract({
      file: o.archive,
      dest,
      names,
      password: o.password,
      overwrite,
      onProgress: progress,
      job,
    });
    return { dest, extracted: r.extracted, skipped: r.skipped, unsafe: r.unsafe };
  }

  if (kind === 'zst') {
    // Single compressed file: decompress it into the destination.
    const name = path.basename(o.archive).replace(/\.zst$/i, '') || 'output';
    const target = resolveName(path.join(dest, name), overwrite);
    if (!target) return { dest, extracted: 0, skipped: 1, unsafe: [] };
    await zstd.decompress(path.resolve(o.archive), target, job);
    progress(100, 'Done');
    return { dest, extracted: 1, skipped: 0, unsafe: [] };
  }

  const entries = await entriesFor(o.archive, o.password);
  const names = expandSelection(o.selected, entries);
  if (o.selected && o.selected.length && names && names.length === 0) {
    throw new ArchiveError('EMPTY_SELECTION', 'Nothing to extract in that selection.');
  }

  let target = path.resolve(o.archive);
  if (kind === 'tar.zst') target = await zstd.toTempTar(target, job);

  const listFile = names ? writeListFile(names, job) : null;
  await proc.runOk(
    sevenZip(),
    args.buildExtractArgs({ archive: target, dest, overwrite, password: o.password, listFile }),
    { job, hadPassword: !!o.password, onProgress: (p) => progress(p, 'Extracting') }
  );
  return {
    dest,
    extracted: names ? names.length : entries.filter((e) => e.kind !== 'dir').length,
    skipped: 0,
    unsafe: [],
  };
}

/** Read every byte of an archive and verify checksums. */
async function testArchive(o, ctx = {}) {
  const job = ctx.job || null;
  const progress = ctx.progress || (() => {});
  const file = path.resolve(o.archive);
  const kind = detect.detectKind(file);
  if (!kind) throw new ArchiveError('UNSUPPORTED', 'Not a recognized archive.');
  if (kind === 'par2') throw new ArchiveError('UNSUPPORTED', 'PAR2 files are recovery data. Use the Recovery tab.');
  if (kind === 'rar') {
    await rarEngine.test({ file, password: o.password, job });
    return { ok: true };
  }
  if (kind === 'zst' || kind === 'tar.zst') {
    await zstd.test(file, job);
    return { ok: true };
  }
  await proc.runOk(sevenZip(), args.buildTestArgs({ archive: file, password: o.password }), {
    job,
    hadPassword: !!o.password,
    onProgress: (p) => progress(p, 'Testing'),
  });
  return { ok: true };
}

/** Check a PAR2 recovery set against its files. */
function recoveryVerify(parFile, ctx = {}) {
  return par2.verify(path.resolve(parFile), { job: ctx.job, onProgress: ctx.progress });
}

/** Repair files using a PAR2 recovery set. */
function recoveryRepair(parFile, ctx = {}) {
  return par2.repair(path.resolve(parFile), { job: ctx.job, onProgress: ctx.progress });
}

module.exports = {
  FORMATS,
  formats,
  openArchive,
  createArchive,
  extractArchive,
  testArchive,
  recoveryVerify,
  recoveryRepair,
  safeTarget,
};
