OPTIONAL ENGINE BINARIES
========================

Shonchoy works without these, but some formats and features need them:

  zstd.exe   Needed for TAR.ZST create/extract/test and .zst files.
             Get it from https://github.com/facebook/zstd/releases
             (zstd-v*-win64.zip). Copy zstd.exe into this folder.

  par2.exe   Needed for PAR2 recovery data (create, check, repair).
             Get par2cmdline from https://github.com/Parchive/par2cmdline/releases
             (Windows build). Copy par2.exe into this folder.

The main engine (7-Zip for 7z, ZIP, TAR, GZ, BZ2, XZ, encryption, volumes)
is installed automatically by "npm install" through the 7zip-bin package.

Shonchoy shows which engines it found in the top-right corner of the window.
Check the licenses of these tools before redistributing them with your build.
