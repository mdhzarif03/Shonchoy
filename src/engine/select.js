'use strict';

/**
 * Turn UI selection keys into an explicit list of file names.
 * Keys ending in '/' are folders and expand to every file below them.
 * Returns null when no keys are given (meaning "everything").
 */
function expandSelection(keys, entries) {
  if (!keys || !keys.length) return null;
  const out = new Set();
  for (const k of keys) {
    if (!k.endsWith('/')) {
      out.add(k);
      continue;
    }
    for (const e of entries) {
      if (e.kind !== 'dir' && e.name.startsWith(k)) out.add(e.name);
    }
  }
  return [...out];
}

module.exports = { expandSelection };
