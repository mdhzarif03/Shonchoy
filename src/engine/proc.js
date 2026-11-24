'use strict';

const { spawn } = require('child_process');
const { ArchiveError } = require('./errors');
const { lastPercent, classifyError } = require('./parse');

/**
 * Run an engine executable. Resolves with { code, text, out, err } for any
 * exit code; rejects with ArchiveError('CANCELLED') when the job was cancelled.
 */
function run(exe, args, { job, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (job) job.check();
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) job.child = child;
    let out = '';
    let err = '';
    let last = -1;

    const feed = (chunk, isErr) => {
      const s = chunk.toString('utf8');
      if (isErr) err += s;
      else out += s;
      const pct = lastPercent(s);
      if (pct !== null && pct !== last && onProgress) {
        last = pct;
        onProgress(pct);
      }
    };

    child.stdout.on('data', (c) => feed(c, false));
    child.stderr.on('data', (c) => feed(c, true));
    child.on('error', (e) => {
      if (job) job.child = null;
      reject(new ArchiveError('ENGINE_MISSING', `Could not start engine: ${e.message}`));
    });
    child.on('close', (code) => {
      if (job) job.child = null;
      if (job && job.cancelled) return reject(new ArchiveError('CANCELLED', 'Cancelled'));
      resolve({ code, text: out + err, out, err });
    });
  });
}

/** Throw a coded ArchiveError for a non-success result. Exit code 1 is a warning. */
function ensureOk(res, { hadPassword = false } = {}) {
  if (res.code === 0 || res.code === 1) return res.code;
  const code = res.code === 255 ? 'CANCELLED' : classifyError(res.text, hadPassword);
  const detail = res.text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' · ');
  throw new ArchiveError(code, detail || `Engine exited with code ${res.code}`);
}

async function runOk(exe, args, opts = {}) {
  const res = await run(exe, args, opts);
  ensureOk(res, { hadPassword: !!opts.hadPassword });
  return res;
}

module.exports = { run, ensureOk, runOk };
