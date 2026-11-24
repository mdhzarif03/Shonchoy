'use strict';

/**
 * RAR support is read-only. The RAR format is proprietary, and creating RAR
 * archives requires the commercial WinRAR encoder, which Shonchoy does not ship.
 * Reading uses node-unrar-js (WebAssembly build of the unrar library).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { ArchiveError } = require('./errors');
const { normPath, safeRelPath } = require('./parse');
const { safeTarget, resolveName } = require('./fsutil');
const { rmSafe } = require('./jobs');

function unrar() {
  try {
    return require('node-unrar-js');
  } catch {
    throw new ArchiveError('ENGINE_MISSING', 'RAR module is missing. Run "npm install" first.');
  }
}

function mapError(e) {
  const m = String((e && e.message) || e);
  if (/password/i.test(m)) {
    return new ArchiveError(/wrong|incorrect|invalid/i.test(m) ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED', m);
  }
  return new ArchiveError('CORRUPT', m);
}

async function open(file, password) {
  const scratch = path.join(os.tmpdir(), `shonchoy-rar-${randomUUID()}`);
  fs.mkdirSync(scratch, { recursive: true });
  try {
    const ex = await unrar().createExtractorFromFile({
      filepath: file,
      targetPath: scratch,
      password: password || undefined,
    });
    return { ex, scratch };
  } catch (e) {
    rmSafe(scratch);
    throw mapError(e);
  }
}

async function list(file, password) {
  const { ex, scratch } = await open(file, password);
  try {
    const headers = [...ex.getFileList().fileHeaders];
    return headers
      .map((h) => ({
        name: normPath(h.name),
        kind: h.flags.directory ? 'dir' : 'file',
        size: h.unpSize || 0,
        packed: typeof h.packSize === 'number' ? h.packSize : null,
        modified: h.time instanceof Date ? h.time.getTime() : 0,
        encrypted: !!h.flags.encrypted,
      }))
      .filter((e) => e.name);
  } catch (e) {
    throw mapError(e);
  } finally {
    rmSafe(scratch);
  }
}

/**
 * Extract selected names (or everything when names is null).
 * Files are written here, not by the library, so the overwrite policy applies.
 */
async function extract({ file, dest, names, password, overwrite = 'rename', onProgress, job }) {
  const { ex, scratch } = await open(file, password);
  const wanted = names ? new Set(names) : null;
  let extracted = 0;
  let skipped = 0;
  const unsafe = [];
  try {
    const headers = [...ex.getFileList().fileHeaders];
    const total = headers.filter((h) => !h.flags.directory && (!wanted || wanted.has(normPath(h.name)))).length || 1;
    let done = 0;
    for (const f of ex.extract().files) {
      if (job) job.check();
      const h = f.fileHeader;
      const name = normPath(h.name);
      if (wanted && !wanted.has(name)) continue;
      const target = safeTarget(dest, h.name);
      if (!target) {
        unsafe.push(h.name);
        continue;
      }
      if (h.flags.directory) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      const final = resolveName(target, overwrite);
      if (!final) {
        skipped++;
        continue;
      }
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.writeFileSync(final, Buffer.from(f.extraction));
      extracted++;
      done++;
      if (onProgress) onProgress(Math.min(99, Math.round((done * 100) / total)));
    }
    return { extracted, skipped, unsafe };
  } catch (e) {
    throw e instanceof ArchiveError ? e : mapError(e);
  } finally {
    rmSafe(scratch);
  }
}

/** Read every entry; the library verifies CRCs and throws on a mismatch. */
async function test({ file, password, job }) {
  const { ex, scratch } = await open(file, password);
  let checked = 0;
  try {
    for (const f of ex.extract().files) {
      if (job) job.check();
      void f;
      checked++;
    }
    return { checked };
  } catch (e) {
    throw e instanceof ArchiveError ? e : mapError(e);
  } finally {
    rmSafe(scratch);
  }
}

module.exports = { list, extract, test, safeRelPath };
