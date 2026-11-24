'use strict';

const fs = require('fs');
const path = require('path');
const { safeRelPath } = require('./parse');

/** Size of a file, or total size and file count of a folder tree. */
async function sizeOf(p) {
  const st = await fs.promises.stat(p);
  if (!st.isDirectory()) return { size: st.size, isDir: false, files: 1 };
  let size = 0;
  let files = 0;
  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          size += (await fs.promises.stat(full)).size;
          files++;
        } catch {
          /* unreadable file, skip */
        }
      }
    }
  }
  await walk(p);
  return { size, isDir: true, files };
}

/** Absolute destination for a member name, or null if it would escape dest. */
function safeTarget(dest, name) {
  const clean = safeRelPath(name);
  if (!clean) return null;
  const root = path.resolve(dest);
  const target = path.resolve(root, clean);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Apply the overwrite policy. Returns the path to write, or null to skip. */
function resolveName(target, overwrite) {
  if (!fs.existsSync(target) || overwrite === 'replace') return target;
  if (overwrite === 'skip') return null;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let n = 2; n < 100000; n++) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = { sizeOf, safeTarget, resolveName };
