"""
Shonchoy core engine.

Pure Python standard library only. No network access, no telemetry,
no third-party runtime dependencies. Every operation runs offline.
"""
from __future__ import annotations

import fnmatch
import os
import re
import tarfile
import threading
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable, Optional

CHUNK = 1024 * 1024  # 1 MiB streaming chunk

ProgressFn = Callable[[int, int, str], None]


class Cancelled(Exception):
    """Raised inside a worker when the user presses Cancel."""


# format id -> (label, output extension)
FORMATS = {
    "zip-deflate": ("ZIP · Deflate (most compatible)", ".zip"),
    "zip-bzip2": ("ZIP · BZip2 (smaller, slower)", ".zip"),
    "zip-lzma": ("ZIP · LZMA (smallest ZIP, slowest)", ".zip"),
    "zip-store": ("ZIP · Store (no compression, fastest)", ".zip"),
    "tar.gz": ("TAR.GZ (fast, Linux standard)", ".tar.gz"),
    "tar.bz2": ("TAR.BZ2 (good ratio)", ".tar.bz2"),
    "tar.xz": ("TAR.XZ (strong compression)", ".tar.xz"),
    "tar": ("TAR (bundle only, no compression)", ".tar"),
}

ZIP_METHODS = {
    "deflate": zipfile.ZIP_DEFLATED,
    "bzip2": zipfile.ZIP_BZIP2,
    "lzma": zipfile.ZIP_LZMA,
    "store": zipfile.ZIP_STORED,
}

_ARCHIVE_EXTS = (".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".zip", ".tar")


def _noop(*_args):
    pass


def human_size(n: Optional[float]) -> str:
    if n is None or n < 0:
        return "—"
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def path_size(path) -> int:
    """Total bytes of a file or folder tree (unreadable files are ignored)."""
    p = Path(path)
    if p.is_file():
        try:
            return p.stat().st_size
        except OSError:
            return 0
    total = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def norm_name(name: str) -> str:
    """Normalise an archive member name: forward slashes, no leading './' or slashes."""
    n = name.replace("\\", "/")
    while n.startswith("./"):
        n = n[2:]
    return n.strip("/")


def entry_key(name: str, is_dir: bool) -> str:
    n = norm_name(name)
    return n + "/" if (is_dir and n) else n


def safe_name(name: str) -> Optional[str]:
    """Return a safe relative path, or None if the member could escape the target folder."""
    n = name.replace("\\", "/")
    if n.startswith("/") or re.match(r"^[A-Za-z]:", n):
        return None
    parts = [p for p in n.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        return None
    return "/".join(parts)


def strip_archive_ext(name: str) -> str:
    low = name.lower()
    for ext in _ARCHIVE_EXTS:
        if low.endswith(ext) and len(name) > len(ext):
            return name[: -len(ext)]
    return Path(name).stem


def archive_kind(path) -> Optional[str]:
    p = Path(path)
    try:
        if zipfile.is_zipfile(p):
            return "zip"
        if tarfile.is_tarfile(p):
            return "tar"
    except OSError:
        return None
    return None


def is_archive(path) -> bool:
    return archive_kind(path) is not None


def format_label(path) -> str:
    if archive_kind(path) == "zip":
        return "ZIP"
    name = Path(path).name.lower()
    for ext, label in ((".tar.gz", "TAR.GZ"), (".tgz", "TAR.GZ"), (".tar.bz2", "TAR.BZ2"),
                       (".tbz2", "TAR.BZ2"), (".tar.xz", "TAR.XZ"), (".txz", "TAR.XZ")):
        if name.endswith(ext):
            return label
    return "TAR"


def suggest_output(sources: Iterable[str], fmt: str) -> str:
    srcs = [Path(s) for s in sources]
    if not srcs:
        return ""
    first = srcs[0]
    if len(srcs) == 1:
        base = first.name if first.is_dir() else first.stem
    else:
        base = f"Archive-{datetime.now():%Y%m%d-%H%M}"
    return str(first.parent / (base + FORMATS[fmt][1]))


@dataclass
class Entry:
    name: str                   # normalised path, no leading or trailing slash
    kind: str                   # "file" | "dir" | "link" | "other"
    size: int = 0               # uncompressed bytes
    packed: Optional[int] = None  # compressed bytes (ZIP only; None for TAR members)
    modified: float = 0.0

    @property
    def is_dir(self) -> bool:
        return self.kind == "dir"

    @property
    def key(self) -> str:
        return self.name + "/" if self.is_dir else self.name

    @property
    def ratio(self) -> Optional[float]:
        if self.packed is None or not self.size:
            return None
        return 100.0 * (1 - self.packed / self.size)


def _zip_time(dt_tuple) -> float:
    try:
        return datetime(*dt_tuple).timestamp()
    except (ValueError, OverflowError, OSError):
        return 0.0


def _set_mtime(path: Path, ts: float) -> None:
    if ts:
        try:
            os.utime(path, (ts, ts))
        except OSError:
            pass


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def collect(sources: Iterable[str], excludes: Iterable[str] = (), skip_path=None):
    """
    Walk the given files and folders.
    Returns a list of (path, archive_name, is_dir, size) tuples.
    """
    skip_resolved = Path(skip_path).resolve() if skip_path else None
    patterns = [p.strip() for p in excludes if p and p.strip()]

    def excluded(name: str) -> bool:
        return any(fnmatch.fnmatch(name, pat) for pat in patterns)

    items = []
    seen = set()

    def add(p: Path, arc: str, is_dir: bool, size: int):
        if skip_resolved is not None and not is_dir and p.resolve() == skip_resolved:
            return
        if arc in seen:
            return
        seen.add(arc)
        items.append((p, arc, is_dir, size))

    for src in sources:
        src = Path(src)
        if not src.exists():
            raise FileNotFoundError(str(src))
        if src.is_dir():
            if excluded(src.name):
                continue
            base = src.parent
            for root, dirs, files in os.walk(src):
                dirs[:] = sorted(d for d in dirs if not excluded(d))
                root_p = Path(root)
                arc_root = root_p.relative_to(base).as_posix()
                add(root_p, arc_root, True, 0)
                for f in sorted(files):
                    if excluded(f):
                        continue
                    fp = root_p / f
                    try:
                        if not fp.is_file():
                            continue
                        size = fp.stat().st_size
                    except OSError:
                        continue
                    add(fp, f"{arc_root}/{f}", False, size)
        else:
            if excluded(src.name):
                continue
            add(src, src.name, False, src.stat().st_size)
    return items


class _Tracked:
    """File wrapper that reports bytes read (used for TAR streaming progress)."""

    def __init__(self, f, on_read):
        self._f = f
        self._on_read = on_read

    def read(self, n=-1):
        data = self._f.read(n)
        self._on_read(len(data))
        return data


def _tar_mode(fmt: str, level: int):
    if fmt == "tar":
        return "w", {}
    if fmt == "tar.gz":
        return "w:gz", {"compresslevel": level}
    if fmt == "tar.bz2":
        return "w:bz2", {"compresslevel": max(1, level)}
    if fmt == "tar.xz":
        return "w:xz", {"preset": level}
    raise ValueError(f"Unknown TAR format: {fmt}")


def create_archive(out, sources, fmt="zip-deflate", level=6, excludes=(),
                   progress: Optional[ProgressFn] = None,
                   cancel: Optional[threading.Event] = None) -> dict:
    """Create an archive. Writes to <name>.part first and renames on success."""
    if fmt not in FORMATS:
        raise ValueError(f"Unknown format: {fmt}")
    progress = progress or _noop
    cancel = cancel or threading.Event()
    level = max(0, min(9, int(level)))

    out = Path(out)
    items = collect(sources, excludes, skip_path=out)
    if not items:
        raise ValueError("Nothing to archive. The selection is empty or everything was excluded.")
    total = sum(size for _p, _a, _d, size in items)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    state = {"done": 0}

    def bump(n: int, name: str):
        if cancel.is_set():
            raise Cancelled()
        state["done"] += n
        progress(state["done"], total, name)

    try:
        if fmt.startswith("zip-"):
            method = ZIP_METHODS[fmt[4:]]
            use_level = level if method in (zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2) else None
            with zipfile.ZipFile(tmp, "w", compression=method, compresslevel=use_level,
                                 allowZip64=True) as zf:
                for path, arc, is_dir, size in items:
                    if cancel.is_set():
                        raise Cancelled()
                    if is_dir:
                        zf.write(path, arc)
                        bump(0, arc)
                        continue
                    info = zipfile.ZipInfo.from_file(path, arc, strict_timestamps=False)
                    info.compress_type = method
                    if use_level is not None:
                        # zipfile.open('w') honours this private attribute on CPython 3.7+
                        info._compresslevel = use_level
                    with open(path, "rb") as src, \
                            zf.open(info, "w", force_zip64=size > 2**31 - 1) as dst:
                        while chunk := src.read(CHUNK):
                            dst.write(chunk)
                            bump(len(chunk), arc)
                    bump(0, arc)
        else:
            mode, kwargs = _tar_mode(fmt, level)
            with tarfile.open(tmp, mode, **kwargs) as tf:
                for path, arc, is_dir, size in items:
                    if cancel.is_set():
                        raise Cancelled()
                    ti = tf.gettarinfo(str(path), arc)
                    if is_dir:
                        tf.addfile(ti)
                        bump(0, arc)
                        continue
                    with open(path, "rb") as src:
                        tf.addfile(ti, _Tracked(src, lambda n, a=arc: bump(n, a)))
                    bump(0, arc)

        os.replace(tmp, out)
    except BaseException:
        _safe_unlink(tmp)
        raise

    return {
        "path": str(out),
        "size": out.stat().st_size,
        "source_bytes": total,
        "files": sum(1 for it in items if not it[2]),
    }


def list_archive(path) -> list:
    """Return a list of Entry objects for a ZIP or TAR-family archive."""
    path = Path(path)
    kind = archive_kind(path)
    entries = []
    if kind == "zip":
        with zipfile.ZipFile(path) as zf:
            for i in zf.infolist():
                name = norm_name(i.filename)
                if not name:
                    continue
                entries.append(Entry(
                    name=name,
                    kind="dir" if i.is_dir() else "file",
                    size=i.file_size,
                    packed=i.compress_size,
                    modified=_zip_time(i.date_time),
                ))
    elif kind == "tar":
        with tarfile.open(path) as tf:
            for m in tf.getmembers():
                name = norm_name(m.name)
                if not name:
                    continue
                if m.isdir():
                    k = "dir"
                elif m.isfile():
                    k = "file"
                elif m.issym() or m.islnk():
                    k = "link"
                else:
                    k = "other"
                entries.append(Entry(
                    name=name,
                    kind=k,
                    size=m.size if m.isfile() else 0,
                    packed=None,
                    modified=float(m.mtime or 0),
                ))
    else:
        raise ValueError("Not a supported archive.")
    return entries


def _emit(src, final: Path, name: str, tick) -> None:
    """Stream src into final. Removes the partial file on failure or cancel."""
    final.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(final, "wb") as dst:
            while chunk := src.read(CHUNK):
                dst.write(chunk)
                tick(len(chunk), name)
    except BaseException:
        _safe_unlink(final)
        raise


def extract_archive(path, dest, selected: Optional[Iterable[str]] = None,
                    overwrite: str = "rename",
                    progress: Optional[ProgressFn] = None,
                    cancel: Optional[threading.Event] = None) -> dict:
    """
    Extract an archive safely.

    selected: iterable of entry keys (files, or folders ending in '/'). None = everything.
    overwrite: 'rename' (name (2).ext), 'replace', or 'skip'.
    """
    if overwrite not in ("rename", "replace", "skip"):
        raise ValueError("overwrite must be rename, replace or skip")
    progress = progress or _noop
    cancel = cancel or threading.Event()
    path = Path(path)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    sel = set(selected) if selected else None
    state = {"done": 0, "total": 0}
    report = {"extracted": 0, "skipped": 0, "unsafe": [], "special": [], "errors": [], "bytes": 0}

    def tick(n: int, name: str):
        if cancel.is_set():
            raise Cancelled()
        state["done"] += n
        progress(state["done"], state["total"], name)

    def wanted(key: str) -> bool:
        if sel is None:
            return True
        return key in sel or any(s.endswith("/") and key.startswith(s) for s in sel)

    def target(name: str) -> Optional[Path]:
        clean = safe_name(name)
        if clean is None:
            return None
        t = (root / clean).resolve()
        if t != root and root not in t.parents:
            return None
        return t

    def free_name(t: Path) -> Optional[Path]:
        if not t.exists() or overwrite == "replace":
            return t
        if overwrite == "skip":
            return None
        n = 2
        while True:
            candidate = t.with_name(f"{t.stem} ({n}){t.suffix}")
            if not candidate.exists():
                return candidate
            n += 1

    if archive_kind(path) == "zip":
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            state["total"] = sum(i.file_size for i in infos if not i.is_dir())
            for info in infos:
                key = entry_key(info.filename, info.is_dir())
                if not key or not wanted(key):
                    continue
                t = target(info.filename)
                if t is None:
                    report["unsafe"].append(info.filename)
                    continue
                if info.is_dir():
                    try:
                        t.mkdir(parents=True, exist_ok=True)
                    except OSError as e:
                        report["errors"].append(f"{info.filename}: {e}")
                    continue
                final = free_name(t)
                if final is None:
                    report["skipped"] += 1
                    tick(info.file_size, info.filename)
                    continue
                try:
                    with zf.open(info) as src:
                        _emit(src, final, info.filename, tick)
                    _set_mtime(final, _zip_time(info.date_time))
                    report["extracted"] += 1
                except Cancelled:
                    raise
                except Exception as e:
                    report["errors"].append(f"{info.filename}: {e}")

    elif archive_kind(path) == "tar":
        with tarfile.open(path) as tf:
            members = tf.getmembers()
            state["total"] = sum(m.size for m in members if m.isfile())
            for m in members:
                key = entry_key(m.name, m.isdir())
                if not key or not wanted(key):
                    continue
                t = target(m.name)
                if t is None:
                    report["unsafe"].append(m.name)
                    continue
                if m.isdir():
                    try:
                        t.mkdir(parents=True, exist_ok=True)
                    except OSError as e:
                        report["errors"].append(f"{m.name}: {e}")
                    continue
                if not m.isfile():
                    report["special"].append(m.name)
                    continue
                final = free_name(t)
                if final is None:
                    report["skipped"] += 1
                    tick(m.size, m.name)
                    continue
                try:
                    src = tf.extractfile(m)
                    if src is None:
                        report["special"].append(m.name)
                        continue
                    with src:
                        _emit(src, final, m.name, tick)
                    _set_mtime(final, float(m.mtime or 0))
                    report["extracted"] += 1
                except Cancelled:
                    raise
                except Exception as e:
                    report["errors"].append(f"{m.name}: {e}")
    else:
        raise ValueError("Not a supported archive.")

    report["bytes"] = state["done"]
    return report


def test_archive(path, progress: Optional[ProgressFn] = None,
                 cancel: Optional[threading.Event] = None) -> dict:
    """Read every file end to end. ZIP CRC and TAR compressor checksums are verified."""
    progress = progress or _noop
    cancel = cancel or threading.Event()
    path = Path(path)
    errors = []
    checked = 0
    state = {"done": 0, "total": 0}

    def read_all(f, name):
        while chunk := f.read(CHUNK):
            if cancel.is_set():
                raise Cancelled()
            state["done"] += len(chunk)
            progress(state["done"], state["total"], name)

    kind = archive_kind(path)
    if kind == "zip":
        with zipfile.ZipFile(path) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            state["total"] = sum(i.file_size for i in infos)
            for info in infos:
                try:
                    with zf.open(info) as f:
                        read_all(f, info.filename)
                    checked += 1
                except Cancelled:
                    raise
                except Exception as e:
                    errors.append(f"{info.filename}: {e}")
    elif kind == "tar":
        with tarfile.open(path) as tf:
            members = [m for m in tf.getmembers() if m.isfile()]
            state["total"] = sum(m.size for m in members)
            for m in members:
                try:
                    f = tf.extractfile(m)
                    if f is not None:
                        with f:
                            read_all(f, m.name)
                    checked += 1
                except Cancelled:
                    raise
                except Exception as e:
                    errors.append(f"{m.name}: {e}")
    else:
        raise ValueError("Not a supported archive.")
    return {"checked": checked, "errors": errors, "bytes": state["done"]}
