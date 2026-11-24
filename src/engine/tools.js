'use strict';

const fs = require('fs');
const path = require('path');

/** Folder holding optional bundled binaries (zstd, par2). */
function binDir() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'resources', 'bin');
}

function exeName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function findBundled(name) {
  const p = path.join(binDir(), exeName(name));
  return fs.existsSync(p) ? p : null;
}

/** 7-Zip engine comes from the 7zip-bin npm package (LGPL 7-Zip build). */
function find7zip() {
  try {
    const { path7za } = require('7zip-bin');
    const p = String(path7za).replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(p)) return p;
  } catch {
    /* package not installed */
  }
  return null;
}

function paths() {
  return {
    sevenZip: find7zip(),
    zstd: findBundled('zstd'),
    par2: findBundled('par2'),
  };
}

function status() {
  const p = paths();
  return {
    sevenZip: !!p.sevenZip,
    zstd: !!p.zstd,
    par2: !!p.par2,
    rar: true, // reading RAR uses the bundled node-unrar-js module
  };
}

module.exports = { paths, status, binDir };
