# Shonchoy 2.0

**Free, open-source, offline archive suite for Windows.**
Developed by **Muhammad Hasan Zarif**. Licensed under the MIT License.

Shonchoy is an Electron desktop app. It creates and opens 7z, ZIP, TAR and its
compressed variants, and reads RAR. It can encrypt, split archives into volumes,
and add PAR2 recovery data. It runs entirely on your machine: no account, no
telemetry, no internet connection.

---

## What it does

**Create**
- 7z (LZMA2, PPMd, BZip2, Deflate, Store), with AES-256 encryption and optional encrypted file names
- ZIP (Deflate, BZip2, LZMA, PPMd, Store), with AES-256 encryption
- TAR, TAR.GZ, TAR.BZ2, TAR.XZ, and TAR.ZST (Zstandard)
- Split into volumes (10 MB to 8 GB) for 7z and ZIP
- PAR2 recovery data (5%, 10% or 20%) so damaged archives can be repaired
- Verify after creating, skip-name patterns, solid mode, compression level 0–9
- Drag and drop files or folders anywhere in the window
- Output files are written only when the job succeeds. A cancelled or failed job leaves nothing behind.

**Open and extract**
- Browse archives as folders with breadcrumbs, search across the whole archive, and see size, packed size, percentage saved, date, and lock status
- Extract everything or only the selected files and folders
- Choose what to do with existing files: keep both, replace, or skip
- Enter a password when an archive needs one
- Path-traversal protection: entries that would escape the destination (`../`, absolute paths, drive letters) are blocked
- Test (F5) reads every byte and checks checksums

**Recovery**
- Check a PAR2 set (intact, repairable, or unrepairable) and repair damaged archives

**Experience**
- Light, dark, and system themes
- Keyboard shortcuts: Ctrl+Enter, Ctrl+O, Ctrl+A, F5, F1, Esc
- Double-click or "Open with" an archive: Shonchoy opens it. A second launch hands its files to the running window.
- Format detection reads file signatures, so a mis-named file still opens correctly

---

## Honest scope

These are the limits, stated plainly:

- **RAR is read-only.** The RAR format is proprietary, and creating RAR archives requires WinRAR's commercial encoder. Shonchoy reads and extracts RAR (including encrypted RAR) using node-unrar-js, but it cannot create RAR files.
- **Zstandard needs the zstd tool.** Put `zstd.exe` in `resources/bin` (see that folder's README). Without it, TAR.ZST and `.zst` are disabled and the UI says why.
- **Recovery needs par2cmdline.** Put `par2.exe` in `resources/bin`. Without it, recovery options are disabled.
- **Encryption is not available for TAR-family formats.** TAR has no encryption standard. Use 7z or ZIP.
- **Passwords are passed to the engine as command-line arguments.** Other programs running as the same user can see them in the process list while the job runs. This is a known limitation of the 7-Zip command-line interface, and it matters on shared machines.
- **Selective extraction of folders** works by expanding each folder into its files. Empty folders inside the selection are recreated only when they contain files.
- **Progress on RAR and zstd operations is indeterminate** because those engines do not report percentages.
- **Not yet included:** drag-out to Explorer, context-menu integration, Zstandard for 7z containers, and a benchmark tool. These are planned.

---

## Run from source

Requirements: **Node.js 20 or newer** and Windows 10/11 (macOS and Linux should also run it, but Windows is the target).

```bat
cd Shonchoy
npm install
npm start
```

`npm install` downloads Electron, the 7-Zip engine (`7zip-bin`), and the RAR reader (`node-unrar-js`). It needs internet access once. After that, Shonchoy runs offline.

Optional: add `zstd.exe` and `par2.exe` to `resources/bin` for TAR.ZST and PAR2 support.

## Build a Windows portable app

```bat
npm install
npm run dist
```

The output is in `dist\`: a single portable `Shonchoy-2.0.0-x64.exe`. It runs without installation.

## Run the tests

```bat
npm test
```

The test suite covers format detection, command builders, the listing parser, error classification, path-safety rules, overwrite policy, and selection expansion. These tests run without Electron or the external engines.

---

## Project layout

```
Shonchoy/
├── main.js                  Electron main process: window, IPC, jobs, file-open routing
├── preload.js               Secure bridge. The UI never gets Node or Electron objects.
├── package.json             Dependencies and electron-builder config
├── src/
│   ├── engine/
│   │   ├── archive.js       Open, create, extract, test, recovery (orchestration)
│   │   ├── args.js          Pure builders for 7-Zip command lines
│   │   ├── parse.js         Pure parsers: 7-Zip listings, progress, error codes, paths
│   │   ├── detect.js        Format detection by file signature
│   │   ├── select.js        Folder selection expansion
│   │   ├── proc.js          Child process runner with progress and cancel
│   │   ├── jobs.js          Job registry, cancellation, temp-file cleanup
│   │   ├── rar.js           RAR reading and extraction
│   │   ├── zstd.js          zstd wrapper (optional binary)
│   │   ├── par2.js          PAR2 wrapper (optional binary)
│   │   ├── fsutil.js        Sizes, safe targets, overwrite policy
│   │   ├── tools.js         Locates bundled engines
│   │   └── errors.js        Error type with stable codes
│   └── renderer/
│       ├── index.html       Layout
│       ├── styles.css       Light, dark, and system themes
│       └── app.js           UI logic
├── assets/                  Logo (SVG, PNG) and Windows icon
├── resources/bin/           Optional zstd.exe and par2.exe go here
└── tests/engine.test.js     Unit tests for the pure engine logic
```

## Design principles

1. **Never lose data.** Existing archives are removed only after you confirm. Failed or cancelled jobs clean up partial output.
2. **Never trust an archive.** Every entry is checked before it touches disk.
3. **Never freeze the window.** All engine work runs in child processes or background jobs, and progress streams back.
4. **Stay offline and dependency-light.** No telemetry. The engines are standard, well-known tools.
5. **Be honest about limits.** Unsupported operations are disabled with a reason, not silently skipped.

## Contributing

Keep the engine free of UI code. Put new parsing and argument logic in the pure modules so it can be tested without Electron. Add a test for every new error code.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 **Muhammad Hasan Zarif**

Third-party components keep their own licenses: 7-Zip (LGPL with unRAR restriction), node-unrar-js (unRAR license), Electron (MIT), and optionally zstd (BSD) and par2cmdline (GPL). Review them before distributing a build.
