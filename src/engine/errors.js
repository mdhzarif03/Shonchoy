'use strict';

/** Error carrying a stable machine-readable code the UI can translate. */
class ArchiveError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

module.exports = { ArchiveError };
