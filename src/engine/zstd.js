'use strict';

const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const tools = require('./tools');
const proc = require('./proc');
const { ArchiveError } = require('./errors');

function requireZstd() {
  const p = tools.paths().zstd;
  if (!p) {
    throw new ArchiveError(
      'TOOL_MISSING',
      'zstd is not installed. Put zstd.exe in resources/bin (see resources/bin/README.txt).'
    );
  }
  return p;
}

async function decompress(src, dst, job) {
  await proc.runOk(requireZstd(), ['-d', '-q', '-f', src, '-o', dst], { job });
}

/** Level 0-9 from the UI maps onto zstd levels 1-19. */
async function compress(src, dst, level, job) {
  const lvl = Math.max(1, Math.min(19, Math.round(level * 2) || 3));
  await proc.runOk(requireZstd(), ['-q', '-f', '-T0', `-${lvl}`, src, '-o', dst], { job });
}

/** zstd -t verifies the frame checksums of the whole file. */
async function test(src, job) {
  await proc.runOk(requireZstd(), ['-t', '-q', src], { job });
}

async function toTempTar(src, job) {
  const tmp = path.join(os.tmpdir(), `shonchoy-${randomUUID()}.tar`);
  if (job) job.temps.push(tmp);
  await decompress(src, tmp, job);
  return tmp;
}

module.exports = { requireZstd, decompress, compress, test, toTempTar };
