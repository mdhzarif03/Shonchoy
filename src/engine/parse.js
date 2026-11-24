'use strict';

/** Normalise an archive member name for display and matching. */
function normPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
    .replace(/^\/+/, '');
}

/**
 * Return a safe relative path for writing under a destination folder,
 * or null when the name could escape it (absolute, drive-letter, or '..').
 */
function safeRelPath(name) {
  const n = String(name).replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** Last percentage printed in a chunk of engine output, or null. */
function lastPercent(text) {
  const re = /(\d{1,3}(?:\.\d+)?)%/g;
  let m;
  let last = null;
  while ((m = re.exec(String(text))) !== null) {
    const v = Number(m[1]);
    if (v >= 0 && v <= 100) last = v;
  }
  return last;
}

/** Map engine output to a stable error code. */
function classifyError(text, hadPassword = false) {
  const t = String(text);
  if (/wrong password|incorrect password/i.test(t)) {
    return hadPassword ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED';
  }
  if (/encrypted archive|enter password|password is required/i.test(t)) {
    return hadPassword ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED';
  }
  if (/unsupported method|unknown method/i.test(t)) return 'UNSUPPORTED_METHOD';
  if (/can not open the file as|cannot open the file as|is not supported archive/i.test(t)) {
    return 'UNSUPPORTED';
  }
  if (/data error|crc failed|headers error|unexpected end|is corrupt/i.test(t)) return 'CORRUPT';
  if (/not enough space|no space left|disk full/i.test(t)) return 'DISK_FULL';
  if (/access is denied|cannot open the file for writing|being used by another process/i.test(t)) {
    return 'ACCESS_DENIED';
  }
  return 'FAILED';
}

function toEntry(c) {
  const attr = c.Attributes || '';
  const isDir = c.Folder === '+' || /^D/.test(attr);
  const modified = c.Modified ? Date.parse(String(c.Modified).replace(' ', 'T')) : 0;
  const packed =
    c['Packed Size'] !== undefined && c['Packed Size'] !== '' ? Number(c['Packed Size']) : null;
  return {
    name: normPath(c.Path),
    kind: isDir ? 'dir' : 'file',
    size: Number(c.Size) || 0,
    packed,
    modified: Number.isFinite(modified) ? modified : 0,
    encrypted: c.Encrypted === '+',
    crc: c.CRC || '',
  };
}

/**
 * Parse the output of `7z l -slt`. Only the per-item blocks after the
 * 10-dash separator are used, so the archive-level header block is skipped.
 */
function parseSlt(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const sep = lines.findIndex((l) => /^-{10,}$/.test(l));
  const body = sep >= 0 ? lines.slice(sep + 1) : [];
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.Path) out.push(toEntry(cur));
    cur = null;
  };
  for (const line of body) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const m = /^([A-Za-z][A-Za-z ]*?) = (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Path') {
      flush();
      cur = {};
    }
    if (cur) cur[m[1]] = m[2];
  }
  flush();
  return out.filter((e) => e.name);
}

module.exports = { normPath, safeRelPath, lastPercent, classifyError, parseSlt };
