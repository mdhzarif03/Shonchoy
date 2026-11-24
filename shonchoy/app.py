"""Shonchoy desktop interface (Tkinter / ttk). Works fully offline."""
from __future__ import annotations

import ctypes
import os
import queue
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import tkinter as tk
from tkinter import ttk, filedialog, messagebox

from . import APP_NAME, AUTHOR, LICENSE, __version__
from . import core

ASSETS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / "assets"

# Palette
BG = "#EEF2F5"        # window / tab strip
PANEL = "#FFFFFF"     # cards and pages
TEXT = "#1F2937"
MUTED = "#6B7280"
ACCENT = "#0F766E"
ACCENT_HOVER = "#0D9488"
BORDER = "#D1D5DB"
FONT = "Segoe UI"

FORMAT_HINTS = {
    "zip-deflate": "Opens on any computer or phone. The safe default for sharing.",
    "zip-bzip2": "Usually 10–15% smaller than Deflate. Slower to create. Some built-in tools can't open BZip2 ZIPs; Shonchoy can.",
    "zip-lzma": "Smallest ZIP files, slowest to create. Some built-in tools can't open LZMA ZIPs; Shonchoy can.",
    "zip-store": "No compression, so it's the fastest. Good for photos and videos that are already compressed.",
    "tar.gz": "Fast and widely used on Linux and macOS.",
    "tar.bz2": "Good compression with moderate speed.",
    "tar.xz": "Very strong compression, slower to create.",
    "tar": "Bundles files without compressing them.",
}

POLICY = {
    "Rename duplicates": "rename",
    "Replace existing": "replace",
    "Skip existing": "skip",
}

ARCHIVE_FILETYPES = [
    ("Archives", "*.zip *.tar *.tar.gz *.tgz *.tar.bz2 *.tbz2 *.tar.xz *.txz"),
    ("All files", "*.*"),
]


def _apply_style(root: tk.Tk) -> None:
    s = ttk.Style(root)
    try:
        s.theme_use("clam")
    except tk.TclError:
        pass
    s.configure(".", background=PANEL, foreground=TEXT, font=(FONT, 10))
    s.configure("TFrame", background=PANEL)
    s.configure("TLabel", background=PANEL, foreground=TEXT)
    s.configure("Muted.TLabel", background=PANEL, foreground=MUTED)
    s.configure("Header.TFrame", background=ACCENT)
    s.configure("Header.TLabel", background=ACCENT)
    s.configure("HeaderTitle.TLabel", background=ACCENT, foreground="white", font=(FONT, 18, "bold"))
    s.configure("HeaderSub.TLabel", background=ACCENT, foreground="#CCFBF1", font=(FONT, 10))
    s.configure("TButton", padding=(12, 6), background=PANEL, foreground=TEXT,
                bordercolor=BORDER, focusthickness=0)
    s.map("TButton", background=[("active", "#E5E7EB"), ("disabled", "#F3F4F6")],
          foreground=[("disabled", "#9CA3AF")])
    s.configure("Accent.TButton", background=ACCENT, foreground="white",
                bordercolor=ACCENT, font=(FONT, 10, "bold"))
    s.map("Accent.TButton", background=[("active", ACCENT_HOVER), ("disabled", "#99C7C3")],
          foreground=[("disabled", "white")])
    s.configure("TNotebook", background=BG, borderwidth=0)
    s.configure("TNotebook.Tab", padding=(18, 8), font=(FONT, 10), background=BG)
    s.map("TNotebook.Tab", background=[("selected", PANEL), ("!selected", BG)],
          foreground=[("selected", ACCENT)])
    s.configure("TLabelframe", background=PANEL, bordercolor=BORDER)
    s.configure("TLabelframe.Label", background=PANEL, foreground=ACCENT, font=(FONT, 10, "bold"))
    s.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT,
                rowheight=26, bordercolor=BORDER)
    s.configure("Treeview.Heading", background=BG, foreground=MUTED, font=(FONT, 9, "bold"),
                relief="flat")
    s.map("Treeview", background=[("selected", ACCENT)], foreground=[("selected", "white")])
    s.map("Treeview.Heading", background=[("active", "#E5E7EB")])
    s.configure("TEntry", fieldbackground=PANEL, bordercolor=BORDER, padding=4)
    s.configure("TCombobox", fieldbackground=PANEL, bordercolor=BORDER, padding=3)
    s.configure("TSpinbox", fieldbackground=PANEL, bordercolor=BORDER, padding=3)
    s.configure("Accent.Horizontal.TProgressbar", background=ACCENT, troughcolor="#E5E7EB",
                bordercolor="#E5E7EB", thickness=12)


def _open_folder(path) -> None:
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # noqa: S606 (opens Explorer on a user-chosen folder)
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except OSError:
        pass


def _short(name: str, limit: int = 60) -> str:
    return name if len(name) <= limit else "…" + name[-(limit - 1):]


class ShonchoyApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_NAME} · Archive Utility")
        self.geometry("1040x700")
        self.minsize(900, 600)
        self.configure(bg=BG)
        _apply_style(self)
        self._set_icon()

        self.queue: queue.Queue = queue.Queue()
        self.busy = False
        self.cancel_event: threading.Event | None = None
        self._task_title = ""
        self._task_start = 0.0
        self._actions: list = []

        self._build_header()
        self._build_statusbar()

        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=14, pady=(10, 0))
        self.compress_tab = CompressTab(self.notebook, self)
        self.extract_tab = ExtractTab(self.notebook, self)
        self.notebook.add(self.compress_tab, text="  Compress  ")
        self.notebook.add(self.extract_tab, text="  Open & Extract  ")

        self.bind_all("<Control-Return>", self._primary_action)
        self.bind_all("<Control-o>", lambda e: self.extract_tab.choose_archive())
        self.bind_all("<Escape>", lambda e: self.cancel_task())
        self.bind_all("<F5>", lambda e: self.extract_tab.test_archive())
        self.bind_all("<F1>", lambda e: self.show_about())
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(50, self._pump)

    # ----- chrome -----------------------------------------------------------

    def _set_icon(self) -> None:
        try:
            if sys.platform == "win32":
                self.iconbitmap(str(ASSETS / "shonchoy.ico"))
            else:
                self._icon_img = tk.PhotoImage(file=str(ASSETS / "shonchoy-64.png"))
                self.iconphoto(True, self._icon_img)
        except tk.TclError:
            pass

    def _build_header(self) -> None:
        head = ttk.Frame(self, style="Header.TFrame", padding=(18, 12))
        head.pack(side="top", fill="x")
        try:
            self._logo = tk.PhotoImage(file=str(ASSETS / "shonchoy-64.png"))
            ttk.Label(head, image=self._logo, style="Header.TLabel").pack(side="left", padx=(0, 14))
        except tk.TclError:
            pass
        text = ttk.Frame(head, style="Header.TFrame")
        text.pack(side="left")
        ttk.Label(text, text=APP_NAME, style="HeaderTitle.TLabel").pack(anchor="w")
        ttk.Label(text, text=f"Fast · free · open source · offline  ·  by {AUTHOR}",
                  style="HeaderSub.TLabel").pack(anchor="w")
        ttk.Button(head, text="About  (F1)", command=self.show_about).pack(side="right")

    def _build_statusbar(self) -> None:
        bar = ttk.Frame(self, padding=(14, 8))
        bar.pack(side="bottom", fill="x")
        self.status_var = tk.StringVar(value="Ready · everything runs locally on your computer")
        ttk.Label(bar, textvariable=self.status_var, style="Muted.TLabel").pack(side="left")
        self.cancel_btn = ttk.Button(bar, text="Cancel  (Esc)", command=self.cancel_task,
                                     state="disabled")
        self.cancel_btn.pack(side="right")
        self.progress = ttk.Progressbar(bar, style="Accent.Horizontal.TProgressbar",
                                        length=300, maximum=100)
        self.progress.pack(side="right", padx=12)

    # ----- task engine ------------------------------------------------------

    def register_action(self, widget) -> None:
        self._actions.append(widget)

    def _set_busy_ui(self, busy: bool) -> None:
        state = "disabled" if busy else "normal"
        for w in self._actions:
            w.configure(state=state)
        self.cancel_btn.configure(state="normal" if busy else "disabled")

    def start_task(self, title, work, on_success) -> None:
        """Run work(progress, cancel) on a background thread; on_success(result) runs on the UI thread."""
        if self.busy:
            messagebox.showinfo(APP_NAME, "Please wait. Another job is still running.")
            return
        self.busy = True
        self.cancel_event = threading.Event()
        self._task_title = title
        self._task_start = time.time()
        self.progress.configure(value=0)
        self.status_var.set(title + "…")
        self._set_busy_ui(True)
        cancel = self.cancel_event

        def progress(done, total, name):
            self.queue.put(("progress", done, total, name))

        def target():
            try:
                result = work(progress, cancel)
                self.queue.put(("done", on_success, result))
            except core.Cancelled:
                self.queue.put(("cancelled",))
            except Exception as exc:  # surfaced to the user, never crashes the UI
                self.queue.put(("error", str(exc) or exc.__class__.__name__))

        threading.Thread(target=target, daemon=True).start()

    def cancel_task(self) -> None:
        if self.busy and self.cancel_event is not None:
            self.cancel_event.set()
            self.status_var.set("Cancelling…")

    def _finish(self) -> None:
        self.busy = False
        self.cancel_event = None
        self.progress.configure(value=0)
        self._set_busy_ui(False)

    def _handle(self, msg) -> None:
        kind = msg[0]
        if kind == "progress":
            _, done, total, name = msg
            pct = (done * 100 / total) if total else 0
            elapsed = max(time.time() - self._task_start, 0.001)
            speed = done / elapsed
            self.progress.configure(value=min(pct, 100))
            self.status_var.set(
                f"{self._task_title}  {pct:3.0f}%   {core.human_size(speed)}/s   {_short(name)}")
        elif kind == "done":
            self._finish()
            msg[1](msg[2])
        elif kind == "cancelled":
            self._finish()
            self.status_var.set("Cancelled. Partial files were removed.")
        elif kind == "error":
            self._finish()
            self.status_var.set("Something went wrong. Nothing was lost.")
            messagebox.showerror(APP_NAME, msg[1])
        elif kind == "call":
            msg[1]()

    def _pump(self) -> None:
        while True:
            try:
                msg = self.queue.get_nowait()
            except queue.Empty:
                break
            try:
                self._handle(msg)
            except Exception as exc:  # keep the event loop alive no matter what
                messagebox.showerror(APP_NAME, str(exc))
        self.after(50, self._pump)

    def _primary_action(self, _event=None):
        if self.notebook.index(self.notebook.select()) == 0:
            self.compress_tab.create_archive()
        else:
            self.extract_tab.extract()
        return "break"

    def show_about(self) -> None:
        messagebox.showinfo(
            "About Shonchoy",
            f"{APP_NAME} {__version__}\n"
            "A fast, free, open-source, offline archive utility for Windows.\n\n"
            f"Developer: {AUTHOR}\nLicense: {LICENSE}\n\n"
            "No ads. No telemetry. No internet connection needed.\n\n"
            "Shortcuts\n"
            "  Ctrl+Enter   Create or extract\n"
            "  Ctrl+O       Open archive\n"
            "  F5           Test archive integrity\n"
            "  Delete       Remove selected item\n"
            "  Esc          Cancel the running job",
        )

    def _on_close(self) -> None:
        if self.busy and not messagebox.askyesno(
                APP_NAME, "A job is still running. Cancel it and quit?"):
            return
        self.cancel_task()
        self.destroy()


class CompressTab(ttk.Frame):
    def __init__(self, master, app: ShonchoyApp):
        super().__init__(master, padding=16)
        self.app = app
        self.sizes: dict[str, int | None] = {}   # abs path -> bytes (None while calculating)
        self._auto_out = True
        self._fmt_keys = list(core.FORMATS.keys())
        self._build()
        self._refresh()

    def _build(self) -> None:
        self.columnconfigure(0, weight=3)
        self.columnconfigure(1, weight=2)
        self.rowconfigure(1, weight=1)

        top = ttk.Frame(self)
        top.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Label(top, text="What do you want to compress?",
                  font=(FONT, 12, "bold")).pack(side="left")
        btns = ttk.Frame(top)
        btns.pack(side="right")
        for text, cmd in (("Add files…", self.add_files), ("Add folder…", self.add_folder),
                          ("Remove", self.remove_selected), ("Clear", self.clear)):
            b = ttk.Button(btns, text=text, command=cmd)
            b.pack(side="left", padx=(6, 0))
            self.app.register_action(b)

        wrap = ttk.Frame(self)
        wrap.grid(row=1, column=0, sticky="nsew")
        self.tree = ttk.Treeview(wrap, columns=("kind", "size", "where"), selectmode="extended")
        self.tree.heading("#0", text="Name", anchor="w")
        self.tree.heading("kind", text="Type", anchor="center")
        self.tree.heading("size", text="Size", anchor="e")
        self.tree.heading("where", text="Location", anchor="w")
        self.tree.column("#0", width=260, stretch=True)
        self.tree.column("kind", width=70, anchor="center", stretch=False)
        self.tree.column("size", width=100, anchor="e", stretch=False)
        self.tree.column("where", width=280, stretch=True)
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        self.tree.bind("<Delete>", lambda e: self.remove_selected())
        self.empty = ttk.Label(
            wrap, style="Muted.TLabel", justify="center",
            text="Nothing added yet.\n\nUse “Add files…” or “Add folder…” to start.")

        side = ttk.Frame(self, padding=(16, 0, 0, 0))
        side.grid(row=0, column=1, rowspan=2, sticky="nsew")
        ttk.Label(side, text="Format and options", font=(FONT, 12, "bold")).pack(anchor="w", pady=(0, 8))

        fmt_box = ttk.LabelFrame(side, text=" Format ", padding=12)
        fmt_box.pack(fill="x")
        self.fmt_combo = ttk.Combobox(
            fmt_box, state="readonly",
            values=[core.FORMATS[k][0] for k in self._fmt_keys])
        self.fmt_combo.current(0)
        self.fmt_combo.bind("<<ComboboxSelected>>", lambda e: self._on_format_change())
        self.fmt_combo.pack(fill="x")
        self.fmt_hint = ttk.Label(fmt_box, style="Muted.TLabel", wraplength=320, justify="left")
        self.fmt_hint.pack(anchor="w", pady=(8, 0))

        lvl = ttk.LabelFrame(side, text=" Compression level ", padding=12)
        lvl.pack(fill="x", pady=(12, 0))
        self.level_var = tk.IntVar(value=6)
        ttk.Spinbox(lvl, from_=0, to=9, width=5, textvariable=self.level_var,
                    state="readonly").pack(side="left")
        ttk.Label(lvl, text="  0 = fastest · 9 = smallest", style="Muted.TLabel").pack(side="left")

        out = ttk.LabelFrame(side, text=" Save archive as ", padding=12)
        out.pack(fill="x", pady=(12, 0))
        self.out_var = tk.StringVar()
        row = ttk.Frame(out)
        row.pack(fill="x")
        ttk.Entry(row, textvariable=self.out_var).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Browse…", command=self.browse_output).pack(side="left", padx=(6, 0))

        exc = ttk.LabelFrame(side, text=" Skip these names ", padding=12)
        exc.pack(fill="x", pady=(12, 0))
        self.exclude_var = tk.StringVar(value="Thumbs.db, desktop.ini, *.tmp")
        ttk.Entry(exc, textvariable=self.exclude_var).pack(fill="x")
        ttk.Label(exc, text="Comma-separated. Wildcards such as *.log work.",
                  style="Muted.TLabel").pack(anchor="w", pady=(4, 0))

        self.summary_var = tk.StringVar()
        ttk.Label(side, textvariable=self.summary_var, style="Muted.TLabel",
                  wraplength=330, justify="left").pack(anchor="w", pady=(14, 8))
        self.create_btn = ttk.Button(side, text="Create archive   (Ctrl+Enter)",
                                     style="Accent.TButton", command=self.create_archive)
        self.create_btn.pack(fill="x", ipady=6)
        self.app.register_action(self.create_btn)
        self._on_format_change()

    # ----- queue management ------------------------------------------------

    def add_files(self) -> None:
        paths = filedialog.askopenfilenames(title="Add files to the archive")
        if paths:
            self.add_paths(paths)

    def add_folder(self) -> None:
        path = filedialog.askdirectory(title="Add a folder to the archive")
        if path:
            self.add_paths([path])

    def add_paths(self, paths) -> None:
        added = []
        for p in paths:
            p = os.path.abspath(p)
            if p in self.sizes or not os.path.exists(p):
                continue
            self.sizes[p] = None
            name = os.path.basename(p) or p
            if os.path.isdir(p):
                kind = "Folder"
            else:
                kind = Path(p).suffix.upper().lstrip(".") or "File"
            self.tree.insert("", "end", iid=p, text=name,
                             values=(kind, "calculating…", os.path.dirname(p)))
            added.append(p)
        if added:
            self._auto_out = True
            threading.Thread(target=self._size_worker, args=(added,), daemon=True).start()
        self._refresh()

    def _size_worker(self, paths) -> None:
        for p in paths:
            size = core.path_size(p)
            self.app.queue.put(("call", lambda k=p, s=size: self._set_size(k, s)))

    def _set_size(self, key: str, size: int) -> None:
        if key not in self.sizes:
            return
        self.sizes[key] = size
        if self.tree.exists(key):
            self.tree.set(key, "size", core.human_size(size))
        self._refresh()

    def remove_selected(self) -> None:
        for iid in self.tree.selection():
            self.sizes.pop(iid, None)
            self.tree.delete(iid)
        self._auto_out = True
        self._refresh()

    def clear(self) -> None:
        self.sizes.clear()
        self.tree.delete(*self.tree.get_children())
        self._auto_out = True
        self._refresh()

    # ----- state -----------------------------------------------------------

    def _current_fmt(self) -> str:
        idx = self.fmt_combo.current()
        return self._fmt_keys[idx if idx >= 0 else 0]

    def _on_format_change(self) -> None:
        self.fmt_hint.configure(text=FORMAT_HINTS[self._current_fmt()])
        self._refresh()

    def _refresh(self) -> None:
        if self.sizes:
            self.empty.place_forget()
        else:
            self.empty.place(relx=0.5, rely=0.5, anchor="center")

        if self._auto_out:
            fmt = self._current_fmt()
            self.out_var.set(core.suggest_output(list(self.sizes.keys()), fmt) if self.sizes else "")

        n = len(self.sizes)
        if n == 0:
            self.summary_var.set("Add files or folders to see the size here.")
            self.create_btn.configure(state="disabled")
            return
        known = [v for v in self.sizes.values() if v is not None]
        pending = n - len(known)
        total = core.human_size(sum(known))
        text = f"{n} item(s) · {total} before compression"
        if pending:
            text += f" · still calculating {pending}"
        text += ("\n\nTip: text and code shrink a lot. Photos, videos and music barely shrink, "
                 "so use ZIP · Store for those to save time.")
        self.summary_var.set(text)
        self.create_btn.configure(state="normal" if not self.app.busy else "disabled")

    def browse_output(self) -> None:
        ext = core.FORMATS[self._current_fmt()][1]
        path = filedialog.asksaveasfilename(
            title="Save archive as", defaultextension=ext,
            initialfile=os.path.basename(self.out_var.get()) or ("Archive" + ext),
            filetypes=[("Archive", "*" + ext), ("All files", "*.*")])
        if path:
            self.out_var.set(path)
            self._auto_out = False

    # ----- actions ---------------------------------------------------------

    def create_archive(self) -> None:
        if not self.sizes:
            messagebox.showinfo(APP_NAME, "Add some files or folders first.")
            return
        fmt = self._current_fmt()
        ext = core.FORMATS[fmt][1]
        out = self.out_var.get().strip()
        if not out:
            messagebox.showwarning(APP_NAME, "Choose where to save the archive.")
            return
        if not out.lower().endswith(ext):
            out += ext
        if os.path.exists(out) and not messagebox.askyesno(
                APP_NAME, f"{Path(out).name} already exists.\n\nReplace it?"):
            return
        try:
            level = max(0, min(9, int(self.level_var.get())))
        except (tk.TclError, ValueError):
            level = 6
        excludes = self.exclude_var.get().split(",")
        sources = list(self.sizes.keys())

        def work(progress, cancel):
            return core.create_archive(out, sources, fmt, level, excludes, progress, cancel)

        def done(res):
            src, size = res["source_bytes"], res["size"]
            saved = 100 * (1 - size / src) if src else 0
            self.app.status_var.set(
                f"Created {Path(out).name} · {core.human_size(size)} · {saved:.0f}% smaller")
            if messagebox.askyesno(
                    APP_NAME,
                    f"Created {Path(out).name}\n\n"
                    f"{res['files']} file(s) · {core.human_size(src)} → {core.human_size(size)} "
                    f"({saved:.0f}% smaller)\n\nOpen the folder?"):
                _open_folder(Path(out).parent)

        self.app.start_task("Compressing", work, done)


class ExtractTab(ttk.Frame):
    def __init__(self, master, app: ShonchoyApp):
        super().__init__(master, padding=16)
        self.app = app
        self.archive: str | None = None
        self.entries: list[core.Entry] = []
        self._build()

    def _build(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(3, weight=1)

        head = ttk.Frame(self)
        head.grid(row=0, column=0, sticky="ew")
        self.open_btn = ttk.Button(head, text="Open archive…   (Ctrl+O)",
                                   style="Accent.TButton", command=self.choose_archive)
        self.open_btn.pack(side="left")
        self.app.register_action(self.open_btn)
        self.name_var = tk.StringVar(value="No archive open yet")
        ttk.Label(head, textvariable=self.name_var,
                  font=(FONT, 11, "bold")).pack(side="left", padx=14)

        self.info_var = tk.StringVar(value="Open a ZIP, TAR, TAR.GZ, TAR.XZ and more to browse its contents.")
        ttk.Label(self, textvariable=self.info_var, style="Muted.TLabel").grid(
            row=1, column=0, sticky="w", pady=(6, 8))

        f = ttk.Frame(self)
        f.grid(row=2, column=0, sticky="ew", pady=(0, 6))
        ttk.Label(f, text="Find:").pack(side="left")
        self.filter_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.filter_var, width=36).pack(side="left", padx=6)
        self.sel_var = tk.StringVar(value="")
        ttk.Label(f, textvariable=self.sel_var, style="Muted.TLabel").pack(side="right")
        sel_btn = ttk.Button(f, text="Select all", command=self.select_all)
        sel_btn.pack(side="right", padx=6)

        wrap = ttk.Frame(self)
        wrap.grid(row=3, column=0, sticky="nsew")
        self.tree = ttk.Treeview(wrap, columns=("size", "packed", "saved", "modified"),
                                 selectmode="extended")
        self.tree.heading("#0", text="Name", anchor="w")
        self.tree.heading("size", text="Size", anchor="e")
        self.tree.heading("packed", text="Packed", anchor="e")
        self.tree.heading("saved", text="Saved", anchor="center")
        self.tree.heading("modified", text="Modified", anchor="w")
        self.tree.column("#0", width=380, stretch=True)
        self.tree.column("size", width=100, anchor="e", stretch=False)
        self.tree.column("packed", width=100, anchor="e", stretch=False)
        self.tree.column("saved", width=80, anchor="center", stretch=False)
        self.tree.column("modified", width=150, stretch=False)
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        self.tree.bind("<<TreeviewSelect>>", lambda e: self._on_select())
        self.tree.bind("<Control-a>", lambda e: (self.select_all(), "break")[1])

        dest = ttk.LabelFrame(self, text=" Extract to ", padding=12)
        dest.grid(row=4, column=0, sticky="ew", pady=(10, 0))
        dest.columnconfigure(0, weight=1)
        self.dest_var = tk.StringVar()
        ttk.Entry(dest, textvariable=self.dest_var).grid(row=0, column=0, sticky="ew")
        browse = ttk.Button(dest, text="Browse…", command=self.browse_dest)
        browse.grid(row=0, column=1, padx=6)
        self.policy_var = tk.StringVar(value="Rename duplicates")
        ttk.Combobox(dest, state="readonly", width=20, values=list(POLICY.keys()),
                     textvariable=self.policy_var).grid(row=0, column=2)
        self.open_after = tk.BooleanVar(value=True)
        ttk.Checkbutton(dest, text="Open folder when finished",
                        variable=self.open_after).grid(row=1, column=0, sticky="w",
                                                       pady=(8, 0), columnspan=2)
        btns = ttk.Frame(dest)
        btns.grid(row=1, column=2, sticky="e", pady=(8, 0))
        self.test_btn = ttk.Button(btns, text="Test integrity   (F5)", command=self.test_archive)
        self.test_btn.pack(side="left")
        self.extract_btn = ttk.Button(btns, text="Extract   (Ctrl+Enter)", style="Accent.TButton",
                                      command=self.extract)
        self.extract_btn.pack(side="left", padx=(8, 0))
        for w in (sel_btn, browse, self.test_btn, self.extract_btn):
            self.app.register_action(w)

        self.filter_var.trace_add("write", lambda *_: self._populate())

    # ----- opening ---------------------------------------------------------

    def choose_archive(self) -> None:
        path = filedialog.askopenfilename(title="Open archive", filetypes=ARCHIVE_FILETYPES)
        if path:
            self.open_archive(path)

    def open_archive(self, path: str) -> None:
        if not core.is_archive(path):
            messagebox.showerror(APP_NAME, "This file isn't a supported archive (ZIP or TAR family).")
            return
        self.app.start_task("Reading archive",
                            lambda progress, cancel: core.list_archive(path),
                            lambda entries: self._load(path, entries))

    def _load(self, path: str, entries: list) -> None:
        self.archive = path
        self.entries = entries
        p = Path(path)
        self.name_var.set(p.name)
        files = [e for e in entries if e.kind == "file"]
        dirs = [e for e in entries if e.is_dir]
        unpacked = sum(e.size for e in files)
        on_disk = os.path.getsize(path)
        saved = (100 * (1 - on_disk / unpacked)) if unpacked else 0
        self.info_var.set(
            f"{core.format_label(path)} · {len(files)} file(s) · {len(dirs)} folder(s) · "
            f"{core.human_size(unpacked)} unpacked · {core.human_size(on_disk)} on disk · "
            f"{saved:.0f}% smaller")
        self.dest_var.set(str(p.parent / core.strip_archive_ext(p.name)))
        self.filter_var.set("")
        self._populate()
        self._on_select()
        self.app.status_var.set(f"Opened {p.name}")

    # ----- tree ------------------------------------------------------------

    def _ensure_dir(self, parts, opened: bool) -> str:
        if not parts:
            return ""
        iid = "/".join(parts) + "/"
        if self.tree.exists(iid):
            return iid
        parent = self._ensure_dir(parts[:-1], opened)
        self.tree.insert(parent, "end", iid=iid, text=parts[-1], open=opened,
                         values=("", "", "", ""))
        return iid

    def _populate(self) -> None:
        self.tree.delete(*self.tree.get_children())
        q = self.filter_var.get().strip().lower()
        opened = bool(q)
        for e in self.entries:
            if q and q not in e.name.lower():
                continue
            parts = [p for p in e.name.split("/") if p]
            if not parts:
                continue
            if e.is_dir:
                self._ensure_dir(parts, opened)
                continue
            parent = self._ensure_dir(parts[:-1], opened)
            ratio = e.ratio
            packed = core.human_size(e.packed) if e.packed is not None else "—"
            when = (datetime.fromtimestamp(e.modified).strftime("%Y-%m-%d %H:%M")
                    if e.modified else "—")
            self.tree.insert(parent, "end", iid=e.key, text=parts[-1],
                             values=(core.human_size(e.size), packed,
                                     f"{ratio:.0f}%" if ratio is not None else "—", when))

    def _all_iids(self):
        out = []
        stack = list(self.tree.get_children(""))
        while stack:
            iid = stack.pop()
            out.append(iid)
            stack.extend(self.tree.get_children(iid))
        return out

    def select_all(self) -> None:
        self.tree.selection_set(self._all_iids())

    def _on_select(self) -> None:
        sel = self.tree.selection()
        if not sel:
            self.sel_var.set("Nothing selected. Everything will be extracted.")
        else:
            self.sel_var.set(f"{len(sel)} item(s) selected")

    # ----- actions ---------------------------------------------------------

    def browse_dest(self) -> None:
        path = filedialog.askdirectory(title="Extract to folder")
        if path:
            self.dest_var.set(path)

    def extract(self) -> None:
        if not self.archive:
            messagebox.showinfo(APP_NAME, "Open an archive first.")
            return
        dest = self.dest_var.get().strip()
        if not dest:
            messagebox.showwarning(APP_NAME, "Choose a destination folder.")
            return
        sel = self.tree.selection()
        selected = set(sel) if sel else None
        policy = POLICY[self.policy_var.get()]
        archive = self.archive
        open_after = self.open_after.get()

        def work(progress, cancel):
            return core.extract_archive(archive, dest, selected, policy, progress, cancel)

        def done(rep):
            lines = [f"Extracted {rep['extracted']} file(s) to:", dest]
            notes = []
            if rep["skipped"]:
                notes.append(f"{rep['skipped']} skipped because they already existed")
            if rep["unsafe"]:
                notes.append(f"{len(rep['unsafe'])} unsafe path(s) blocked (possible path traversal)")
            if rep["special"]:
                notes.append(f"{len(rep['special'])} link or special item(s) not created")
            if rep["errors"]:
                notes.append(f"{len(rep['errors'])} error(s)")
            self.app.status_var.set(f"Extracted {rep['extracted']} file(s) · {core.human_size(rep['bytes'])}")
            if notes or rep["errors"]:
                detail = "\n".join(rep["errors"][:8])
                messagebox.showwarning(APP_NAME, "\n".join(lines) + "\n\n" + "\n".join(notes)
                                       + ("\n\n" + detail if detail else ""))
            if open_after:
                _open_folder(dest)

        self.app.start_task("Extracting", work, done)

    def test_archive(self) -> None:
        if not self.archive:
            messagebox.showinfo(APP_NAME, "Open an archive first.")
            return
        archive = self.archive

        def work(progress, cancel):
            return core.test_archive(archive, progress, cancel)

        def done(res):
            if res["errors"]:
                shown = "\n".join(res["errors"][:10])
                messagebox.showerror(APP_NAME,
                                     f"{len(res['errors'])} problem(s) found:\n\n{shown}")
                self.app.status_var.set("Integrity check found problems.")
            else:
                messagebox.showinfo(APP_NAME,
                                    f"All {res['checked']} file(s) verified. No corruption found.")
                self.app.status_var.set(f"Verified {res['checked']} file(s)")

        self.app.start_task("Testing integrity", work, done)


def main(argv=None) -> None:
    argv = list(argv or [])
    if sys.platform == "win32":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # crisp text on high-DPI screens
        except (AttributeError, OSError):
            pass
    app = ShonchoyApp()
    archives = [a for a in argv if os.path.isfile(a) and core.is_archive(a)]
    paths = [a for a in argv if os.path.exists(a)]
    if archives:
        app.after(100, lambda: app.extract_tab.open_archive(archives[0]))
    elif paths:
        app.after(100, lambda: app.compress_tab.add_paths(paths))
    app.mainloop()
