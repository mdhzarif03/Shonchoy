# Shonchoy

**Fast · free · open source · offline archive utility for Windows.**

Developed by **Muhammad Hasan Zarif**. Licensed under the MIT License.

Shonchoy is a lightweight archive manager. It needs no internet connection, has no ads, collects no telemetry, and has no runtime dependencies beyond Python's standard library. The single-file Windows build is a portable `.exe`.

---

## Features (v1.0.0)

**Compress**
- ZIP with Deflate, BZip2, LZMA or Store methods
- TAR, TAR.GZ, TAR.BZ2 and TAR.XZ
- Compression level 0–9
- Add multiple files and whole folders at once
- Live size estimate for everything you add. Calculation runs in the background, so the window never freezes.
- Skip names with wildcards such as `*.tmp`, `Thumbs.db`, `desktop.ini`
- Smart default output name and folder
- Safe writing: output goes to `name.part` and is renamed only on success, so a cancelled or failed job never leaves a broken archive behind
- Overwrite confirmation

**Open and extract**
- Browse archive contents as a folder tree
- Live search filter
- Multi-select, then extract only what you picked (a folder selection includes everything inside it)
- Choose what to do with duplicates: rename, replace or skip
- Size, packed size, percentage saved and modified date for every entry
- **Zip-slip protection**: entries that try to escape the destination folder (`../`, absolute paths, drive letters) are blocked and reported
- **Test integrity** (F5): reads every file end to end, verifying ZIP CRCs and TAR compressor checksums

**Experience**
- One window, two tabs, a single progress bar with speed and a Cancel button
- Keyboard shortcuts (Ctrl+Enter, Ctrl+O, F5, Delete, Esc, F1)
- Command-line support: `Shonchoy.exe archive.zip` opens it, and `Shonchoy.exe a.txt folder` adds those items to a new archive
- Shonchoy logo built into the app header and the Windows icon

---

## Honest scope

Shonchoy v1.0 focuses on the formats and workflows that work reliably with the Python standard library. It does **not yet** include:

- RAR and 7z reading or writing
- Password encryption (AES). ZIP encryption needs a third-party library, which this build deliberately avoids.
- Zstandard, multi-volume archives and recovery records
- Drag and drop from Explorer (planned)
- Dark theme (planned)

These are on the roadmap. Shonchoy is designed so that each one can be added as a self-contained module without touching the UI.

---

## Install and run from source

Requires **Python 3.9 or newer** on Windows, macOS or Linux. Tkinter ships with the official Python installer.

```bat
python run_shonchoy.py
python run_shonchoy.py "C:\Users\me\Downloads\photos.zip"
```

## Build a standalone Windows executable

Double-click `build_windows.bat`, or run it from a terminal. The output is `dist\Shonchoy.exe`, a single portable file. You can copy it to a USB drive and run it without installing anything.

## Run the tests

```bat
python -m unittest discover -s tests -v
```

## Regenerate the logo

```bat
python tools\make_icon.py
```

The vector source is `assets/shonchoy.svg`.

---

## Project layout

```
Shonchoy/
├── run_shonchoy.py          launcher (used for source runs and PyInstaller)
├── build_windows.bat        one-click build of Shonchoy.exe
├── shonchoy/
│   ├── __init__.py          version and developer info
│   ├── core.py              archive engine: create, list, extract, test
│   ├── app.py               Tkinter interface
│   └── __main__.py          python -m shonchoy
├── tools/make_icon.py       dependency-free logo and icon generator
├── assets/                  logo (SVG, PNG) and Windows icon (ICO)
├── tests/test_core.py       engine test suite
├── LICENSE
└── README.md
```

## Design principles

1. **Never lose data.** Writes go to temporary files first. Cancelled jobs clean up after themselves.
2. **Never trust archives.** Path traversal is blocked, and every entry is validated before it touches disk.
3. **Never freeze the UI.** All disk work runs on background threads, and progress is streamed back.
4. **Stay offline.** The app contains no network code.

## Contributing

Pull requests are welcome. Keep the engine free of GUI code and keep runtime dependencies at zero where possible.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 **Muhammad Hasan Zarif**
