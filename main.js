'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const archive = require('./src/engine/archive');
const tools = require('./src/engine/tools');
const fsutil = require('./src/engine/fsutil');
const { Job, getJob } = require('./src/engine/jobs');
const { ArchiveError } = require('./src/engine/errors');

let mainWindow = null;
let pendingOpen = [];

const ARCHIVE_FILTERS = [
  {
    name: 'Archives',
    extensions: ['7z', 'zip', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'par2', '001'],
  },
  { name: 'All files', extensions: ['*'] },
];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1417',
    title: 'Shonchoy',
    icon: path.join(__dirname, 'assets', 'shonchoy.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingOpen.length) {
      mainWindow.webContents.send('external:open', pendingOpen);
      pendingOpen = [];
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Paths passed on the command line (for "Open with" and double-click). */
function fileArgs(argv) {
  const rest = argv.slice(app.isPackaged ? 1 : 2);
  return rest.filter((a) => path.isAbsolute(a) && fs.existsSync(a));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const files = fileArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length) mainWindow.webContents.send('external:open', files);
    }
  });

  app.whenReady().then(() => {
    pendingOpen = fileArgs(process.argv);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function ownerWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}

/** Wrap a handler so errors come back as { ok:false, code, message } instead of throwing. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return { ok: true, data: await fn(event, payload ?? {}) };
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'FAILED',
        message: err.message || String(err),
      };
    }
  });
}

/**
 * Run a long operation as a Job. The renderer learns the job id immediately
 * (for Cancel) and receives progress events until the job finishes.
 */
async function runJob(event, kind, fn) {
  const job = new Job(kind);
  const sender = event.sender;
  sender.send('job:started', { id: job.id, kind });
  const progress = (percent, label = '') => {
    if (sender.isDestroyed()) return;
    sender.send('job:progress', {
      id: job.id,
      percent: Math.max(0, Math.min(100, Number(percent) || 0)),
      label,
    });
  };
  try {
    return await fn({ job, progress });
  } finally {
    job.cleanup();
  }
}

handle('tools:status', () => tools.status());
handle('archive:formats', () => archive.formats());

handle('dialog:pickFiles', async (event) => {
  const r = await dialog.showOpenDialog(ownerWindow(event), {
    title: 'Add files',
    properties: ['openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

handle('dialog:pickFolder', async (event) => {
  const r = await dialog.showOpenDialog(ownerWindow(event), {
    title: 'Add a folder',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:pickArchive', async (event) => {
  const r = await dialog.showOpenDialog(ownerWindow(event), {
    title: 'Open archive',
    properties: ['openFile'],
    filters: ARCHIVE_FILTERS,
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:pickFolderDest', async (event) => {
  const r = await dialog.showOpenDialog(ownerWindow(event), {
    title: 'Choose destination folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:pickSave', async (event, { defaultName, ext }) => {
  const r = await dialog.showSaveDialog(ownerWindow(event), {
    title: 'Save archive as',
    defaultPath: defaultName,
    filters: [{ name: 'Archive', extensions: [ext.replace(/^\./, '')] }],
  });
  return r.canceled ? null : r.filePath;
});

handle('fs:inspect', async (_event, { paths }) => {
  const out = [];
  for (const p of paths || []) {
    try {
      const info = await fsutil.sizeOf(p);
      out.push({ path: p, name: path.basename(p), ...info });
    } catch {
      out.push({ path: p, name: path.basename(p), size: 0, isDir: false, files: 0, missing: true });
    }
  }
  return out;
});

handle('archive:open', (_event, { path: p, password }) => archive.openArchive(p, password));

handle('archive:create', (event, opts) =>
  runJob(event, 'create', (ctx) => archive.createArchive(opts, ctx))
);

handle('archive:extract', (event, opts) =>
  runJob(event, 'extract', (ctx) => archive.extractArchive(opts, ctx))
);

handle('archive:test', (event, opts) =>
  runJob(event, 'test', (ctx) => archive.testArchive(opts, ctx))
);

handle('recovery:verify', (event, { path: p }) =>
  runJob(event, 'verify', (ctx) => archive.recoveryVerify(p, ctx))
);

handle('recovery:repair', (event, { path: p }) =>
  runJob(event, 'repair', (ctx) => archive.recoveryRepair(p, ctx))
);

handle('job:cancel', (_event, { id }) => {
  const job = getJob(id);
  if (job) job.cancel();
  return true;
});

handle('shell:reveal', (_event, { path: p }) => {
  if (!p || !fs.existsSync(p)) throw new ArchiveError('NOT_FOUND', 'That item no longer exists.');
  shell.showItemInFolder(p);
  return true;
});

handle('shell:openFolder', async (_event, { path: p }) => {
  if (!p || !fs.existsSync(p)) throw new ArchiveError('NOT_FOUND', 'That folder no longer exists.');
  const err = await shell.openPath(p);
  if (err) throw new ArchiveError('FAILED', err);
  return true;
});
