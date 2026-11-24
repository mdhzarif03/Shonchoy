'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const { ArchiveError } = require('./errors');

const registry = new Map();

function rmSafe(p) {
  try {
    fs.rmSync(p, { force: true, recursive: true });
  } catch {
    /* best effort */
  }
}

/** One running user operation. Owns its child process and temporary files. */
class Job {
  constructor(kind) {
    this.id = randomUUID();
    this.kind = kind;
    this.child = null;
    this.cancelled = false;
    this.temps = [];
    registry.set(this.id, this);
  }

  cancel() {
    this.cancelled = true;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* process already gone */
      }
    }
  }

  check() {
    if (this.cancelled) throw new ArchiveError('CANCELLED', 'Cancelled');
  }

  cleanup() {
    for (const f of this.temps) rmSafe(f);
    this.temps = [];
    registry.delete(this.id);
  }
}

function getJob(id) {
  return registry.get(id);
}

module.exports = { Job, getJob, rmSafe };
