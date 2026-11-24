'use strict';

const tools = require('./tools');
const proc = require('./proc');
const { ArchiveError } = require('./errors');

function requirePar2() {
  const p = tools.paths().par2;
  if (!p) {
    throw new ArchiveError(
      'TOOL_MISSING',
      'PAR2 recovery tool is not installed. Put par2.exe in resources/bin (see resources/bin/README.txt).'
    );
  }
  return p;
}

function tail(text) {
  return String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ');
}

/** Create recovery data. percent = redundancy (e.g. 10 means ~10% extra). */
async function create(files, percent, outPar2, { job, onProgress } = {}) {
  const r = Math.max(1, Math.min(100, Math.round(Number(percent) || 0)));
  const res = await proc.run(requirePar2(), ['c', `-r${r}`, outPar2, ...files], { job, onProgress });
  if (res.code !== 0) throw new ArchiveError('RECOVERY_FAILED', tail(res.text));
  return { par2: outPar2 };
}

/**
 * Check a PAR2 set. par2cmdline exit codes: 0 intact, 1 damaged but repairable,
 * 2 damaged and not repairable.
 */
async function verify(parFile, { job, onProgress } = {}) {
  const res = await proc.run(requirePar2(), ['v', parFile], { job, onProgress });
  const status = { 0: 'intact', 1: 'repairable', 2: 'unrepairable' }[res.code];
  if (!status) throw new ArchiveError('RECOVERY_FAILED', tail(res.text));
  return { status, text: tail(res.text) };
}

/** Repair damaged files using the PAR2 set. */
async function repair(parFile, { job, onProgress } = {}) {
  const res = await proc.run(requirePar2(), ['r', parFile], { job, onProgress });
  if (res.code === 0) return { status: 'repaired', text: tail(res.text) };
  throw new ArchiveError('RECOVERY_FAILED', tail(res.text) || 'Repair was not possible.');
}

module.exports = { requirePar2, create, verify, repair };
