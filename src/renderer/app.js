'use strict';

/* global window, document, localStorage */
const api = window.shonchoy;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const MAX_ROWS = 2000;
const ARCHIVE_RE = /\.(7z|zip|rar|tar|gz|tgz|bz2|tbz2|xz|txz|zst|par2)$|\.\d{3}$/i;

const FORMAT_INFO = {
  '7z': {
    label: '7z · best ratio',
    hint: 'LZMA2 compression, AES-256 encryption, encrypted file names, and volumes.',
    methods: [['lzma2', 'LZMA2 (best)'], ['ppmd', 'PPMd (text and code)'], ['bzip2', 'BZip2'], ['deflate', 'Deflate'], ['copy', 'Store (no compression)']],
  },
  zip: {
    label: 'ZIP · most compatible',
    hint: 'Opens on any computer or phone. AES-256 encryption and volumes supported.',
    methods: [['deflate', 'Deflate'], ['bzip2', 'BZip2'], ['lzma', 'LZMA'], ['ppmd', 'PPMd'], ['copy', 'Store']],
  },
  'tar.zst': { label: 'TAR.ZST · fast and strong', hint: 'Zstandard compression. Needs the bundled zstd tool. No encryption.', methods: [] },
  'tar.xz': { label: 'TAR.XZ · strongest', hint: 'Very high compression, slower to create. No encryption.', methods: [] },
  'tar.gz': { label: 'TAR.GZ · Linux standard', hint: 'Fast and widely used on Linux and macOS. No encryption.', methods: [] },
  'tar.bz2': { label: 'TAR.BZ2', hint: 'Good compression with moderate speed. No encryption.', methods: [] },
  tar: { label: 'TAR · no compression', hint: 'Bundles files without compressing them. No encryption.', methods: [] },
};

const ERRORS = {
  PASSWORD_REQUIRED: 'This archive is password protected.',
  WRONG_PASSWORD: 'That password is incorrect.',
  CORRUPT: 'The archive is damaged or incomplete. If you have PAR2 recovery data, try the Recovery tab.',
  UNSUPPORTED: 'This file type is not supported.',
  UNSUPPORTED_METHOD: 'This archive uses a compression method that is not available in Shonchoy.',
  TOOL_MISSING: 'A required tool is missing from this installation.',
  ENGINE_MISSING: 'The compression engine could not be found. Reinstall Shonchoy or run "npm install".',
  DISK_FULL: 'There is not enough free disk space.',
  ACCESS_DENIED: 'Access was denied. Check permissions, or close the file if another program has it open.',
  CANCELLED: 'Cancelled. Partial files were removed.',
  EMPTY_SELECTION: 'Nothing to extract in that selection.',
  RECOVERY_FAILED: 'The recovery data could not repair this set.',
  NOT_FOUND: 'That file no longer exists.',
  NO_ENCRYPTION: 'This format cannot be password protected. Use 7z or ZIP.',
  NO_VOLUMES: 'This format does not support volumes. Use 7z or ZIP.',
};

const S = {
  queue: [],
  formats: [],
  tools: { sevenZip: false, zstd: false, par2: false },
  open: null,
  password: null,
  prefix: '',
  selected: new Set(),
  rows: [],
  folderSizes: new Map(),
  busy: false,
  jobId: null,
  title: '',
  outTouched: false,
  parPath: null,
};

/* ---------------- helpers ---------------- */

function fmtSize(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sepOf(p) {
  return p.includes('\\') ? '\\' : '/';
}
function dirOf(p) {
  return p.replace(/[\\/][^\\/]*$/, '');
}
function baseOf(p) {
  return p.split(/[\\/]/).pop();
}
function joinPath(dir, name) {
  return dir + sepOf(dir) + name;
}
function stripArchiveExt(name) {
  return name.replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|tzst|7z|zip|rar|tar|gz|bz2|xz|zst)(\.001)?$/i, '') || name;
}

function setStatus(msg) {
  $('#status').textContent = msg;
}

let toastTimer = null;
function toast(msg, type = '', action = null) {
  const t = $('#toast');
  t.className = `toast ${type}`;
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.style.marginLeft = '12px';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      t.classList.add('hidden');
      action.fn();
    });
    t.appendChild(b);
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), type === 'error' ? 7000 : 4500);
}

function friendly(res) {
  return ERRORS[res.code] || res.message || 'Something went wrong.';
}

function showError(res) {
  const msg = friendly(res);
  setStatus(msg);
  toast(msg, 'error');
}

/* ---------------- tabs and theme ---------------- */

function showTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value;
  localStorage.setItem('theme', value);
  $('#theme').value = value;
}

/* ---------------- tools and formats ---------------- */

function renderTools() {
  const t = S.tools;
  const missing = [];
  if (!t.sevenZip) missing.push('7-Zip engine');
  if (!t.zstd) missing.push('zstd');
  if (!t.par2) missing.push('PAR2');
  const chip = $('#tools');
  chip.textContent = `7-Zip ${t.sevenZip ? '✓' : '✗'} · zstd ${t.zstd ? '✓' : '✗'} · PAR2 ${t.par2 ? '✓' : '✗'} · RAR read ✓`;
  chip.classList.toggle('warn', missing.length > 0);
  chip.title = missing.length ? `Missing: ${missing.join(', ')}. See resources/bin/README.txt` : 'All engines available';
  if (!t.sevenZip) toast('The 7-Zip engine is missing. Run "npm install" and restart Shonchoy.', 'error');

  // Recovery levels need PAR2.
  $$('#recovery option').forEach((o) => {
    if (o.value !== '0') o.disabled = !t.par2;
  });
  if (!t.par2) $('#recovery').value = '0';
}

function fillFormats() {
  const sel = $('#fmt');
  sel.innerHTML = '';
  for (const f of S.formats) {
    const info = FORMAT_INFO[f.id];
    if (!info) continue;
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = info.label;
    if (f.needsTool === 'zstd' && !S.tools.zstd) {
      o.disabled = true;
      o.textContent += ' (needs zstd)';
    }
    sel.appendChild(o);
  }
  sel.value = '7z';
  onFormatChange();
}

function currentSpec() {
  return S.formats.find((f) => f.id === $('#fmt').value) || { encrypt: false, volumes: false, ext: '.7z' };
}

function onFormatChange() {
  const id = $('#fmt').value;
  const info = FORMAT_INFO[id] || { hint: '', methods: [] };
  const spec = currentSpec();
  $('#fmt-hint').textContent = info.hint;

  const method = $('#method');
  method.innerHTML = '';
  if (info.methods.length) {
    for (const [value, label] of info.methods) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      method.appendChild(o);
    }
    method.disabled = false;
  } else {
    const o = document.createElement('option');
    o.textContent = 'Set by format';
    method.appendChild(o);
    method.disabled = true;
  }

  const canEncrypt = !!spec.encrypt;
  $('#pw').disabled = !canEncrypt;
  $('#pw2').disabled = !canEncrypt;
  $('#show-pw').disabled = !canEncrypt;
  $('#encnames').disabled = id !== '7z';
  if (!canEncrypt) {
    $('#pw').value = '';
    $('#pw2').value = '';
  }
  $('#volume').disabled = !spec.volumes;
  if (!spec.volumes) $('#volume').value = '';
  updateOutputName();
}

/* ---------------- create: queue ---------------- */

function suggestOutput() {
  if (!S.queue.length) return '';
  const spec = currentSpec();
  const first = S.queue[0];
  const dir = dirOf(first.path);
  let base;
  if (S.queue.length === 1) {
    base = first.isDir ? first.name : first.name.replace(/\.[^.]+$/, '') || first.name;
  } else {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    base = `Archive-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  return joinPath(dir, base + spec.ext);
}

function updateOutputName() {
  if (!S.outTouched) $('#out').value = suggestOutput();
}

async function addPaths(paths) {
  const fresh = paths.filter((p) => p && !S.queue.some((q) => q.path === p));
  if (!fresh.length) return;
  const res = await api.inspect(fresh);
  if (!res.ok) return showError(res);
  for (const item of res.data) {
    if (item.missing) toast(`Skipped ${item.name}: not found.`, 'warn');
    else S.queue.push(item);
  }
  showTab('create');
  renderQueue();
}

function renderQueue() {
  const ul = $('#queue');
  ul.innerHTML = '';
  S.queue.forEach((it, i) => {
    const li = document.createElement('li');
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = it.isDir ? 'DIR' : (baseOf(it.name).split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    const info = document.createElement('div');
    info.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = it.name;
    const where = document.createElement('div');
    where.className = 'path';
    where.textContent = dirOf(it.path);
    info.append(name, where);
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = fmtSize(it.size);
    const x = document.createElement('button');
    x.className = 'x';
    x.title = 'Remove';
    x.textContent = '×';
    x.addEventListener('click', () => {
      S.queue.splice(i, 1);
      renderQueue();
    });
    li.append(ico, info, size, x);
    ul.appendChild(li);
  });

  $('#queue-empty').classList.toggle('hidden', S.queue.length > 0);
  const total = S.queue.reduce((s, q) => s + (q.size || 0), 0);
  $('#queue-summary').textContent = S.queue.length
    ? `${S.queue.length} item(s) · ${fmtSize(total)} before compression`
    : '';
  $('#create').disabled = S.queue.length === 0;
  updateOutputName();
}

function createOptions() {
  const pw = $('#pw').value;
  const pw2 = $('#pw2').value;
  if (pw && pw !== pw2) throw new Error('The two passwords do not match.');
  const spec = currentSpec();
  return {
    format: $('#fmt').value,
    sources: S.queue.map((q) => q.path),
    out: $('#out').value.trim(),
    level: Number($('#level').value),
    method: $('#method').value,
    password: spec.encrypt && pw ? pw : undefined,
    encryptNames: $('#encnames').checked,
    volumeSize: spec.volumes && $('#volume').value ? $('#volume').value : undefined,
    solid: $('#solid').checked,
    excludes: $('#excludes').value.split(',').map((s) => s.trim()).filter(Boolean),
    verify: $('#verify').checked,
    recoveryPercent: Number($('#recovery').value) || 0,
    overwrite: false,
  };
}

async function doCreate(overwrite = false) {
  if (S.busy) return toast('Please wait for the current task to finish.', 'warn');
  if (!S.queue.length) return toast('Add files or folders first.', 'warn');
  let opts;
  try {
    opts = createOptions();
  } catch (e) {
    return toast(e.message, 'warn');
  }
  if (!opts.out) return toast('Choose where to save the archive.', 'warn');
  if (opts.password && opts.password.length < 8) {
    toast('Tip: use at least 8 characters for a stronger password.', 'warn');
  }
  opts.overwrite = overwrite;

  const res = await runTask('Creating archive', () => api.create(opts));
  if (!res) return;
  if (!res.ok && res.code === 'EXISTS') {
    if (window.confirm(`${baseOf(opts.out)} already exists. Replace it?`)) return doCreate(true);
    return;
  }
  if (!res.ok) return showError(res);

  const d = res.data;
  const msg = `Created ${baseOf(d.out)} · ${fmtSize(d.bytes)}${d.recovery ? ' · with PAR2 recovery' : ''}`;
  setStatus(msg);
  toast(msg, '', { label: 'Show in folder', fn: () => api.reveal(d.out) });
}

/* ---------------- open and browse ---------------- */

function computeFolderSizes(entries) {
  const m = new Map();
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const parts = e.name.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc += `${parts[i]}/`;
      const cur = m.get(acc) || { size: 0, packed: 0 };
      cur.size += e.size || 0;
      cur.packed += e.packed || 0;
      m.set(acc, cur);
    }
  }
  return m;
}

async function openArchive(path, password) {
  const res = await runTask('Reading archive', () => api.open(path, password));
  if (!res) return;
  if (!res.ok) {
    if (res.code === 'PASSWORD_REQUIRED' || res.code === 'WRONG_PASSWORD') {
      const pw = await askPassword(
        res.code === 'WRONG_PASSWORD' ? 'Wrong password' : 'Password required',
        `Enter the password for ${baseOf(path)}.`
      );
      if (pw) return openArchive(path, pw);
      return;
    }
    return showError(res);
  }
  const info = res.data;
  if (info.recovery) {
    setParPath(info.path);
    showTab('repair');
    toast('That is a PAR2 recovery file. You can check or repair with it here.');
    return;
  }
  S.password = password || null;
  loadArchive(info);
}

function loadArchive(info) {
  S.open = info;
  S.prefix = '';
  S.selected.clear();
  S.folderSizes = computeFolderSizes(info.entries);
  $('#find').value = '';

  const files = info.entries.filter((e) => e.kind === 'file');
  const folders = info.entries.filter((e) => e.kind === 'dir');
  const saved = info.totalSize ? Math.round(100 * (1 - info.onDiskSize / info.totalSize)) : 0;
  $('#arch-name').textContent = info.name;
  $('#arch-meta').textContent =
    `${info.label} · ${files.length} file(s) · ${folders.length} folder(s) · ` +
    `${fmtSize(info.totalSize)} unpacked · ${fmtSize(info.onDiskSize)} on disk · ${saved}% smaller` +
    (info.encrypted ? ' · 🔒 encrypted' : '');

  $('#dest').value = joinPath(dirOf(info.path), stripArchiveExt(info.name));
  renderBrowser();
  updateSelectionUI();
  showTab('open');
  setStatus(`Opened ${info.name}`);
}

function childrenOf(prefix) {
  const info = S.open;
  if (!info) return [];
  const map = new Map();
  for (const e of info.entries) {
    if (!e.name.startsWith(prefix)) continue;
    const rest = e.name.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1 && e.kind !== 'dir') {
      map.set(e.name, {
        key: e.name,
        label: rest,
        isDir: false,
        size: e.size,
        packed: e.packed,
        encrypted: e.encrypted,
        modified: e.modified,
      });
    } else {
      const segment = slash === -1 ? rest : rest.slice(0, slash);
      const key = `${prefix}${segment}/`;
      if (!map.has(key)) {
        const fs = S.folderSizes.get(key) || { size: 0, packed: 0 };
        map.set(key, {
          key,
          label: segment,
          isDir: true,
          size: fs.size,
          packed: fs.packed,
          encrypted: false,
          modified: 0,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
  });
}

function searchItems(q) {
  return S.open.entries
    .filter((e) => e.name.toLowerCase().includes(q))
    .map((e) => ({
      key: e.kind === 'dir' ? `${e.name}/` : e.name,
      label: e.name,
      isDir: e.kind === 'dir',
      size: e.kind === 'dir' ? (S.folderSizes.get(`${e.name}/`) || {}).size : e.size,
      packed: e.kind === 'dir' ? (S.folderSizes.get(`${e.name}/`) || {}).packed : e.packed,
      encrypted: e.encrypted,
      modified: e.modified,
    }));
}

function renderBrowser() {
  const tbody = $('#rows');
  tbody.innerHTML = '';
  if (!S.open) {
    S.rows = [];
    $('#rows-empty').classList.remove('hidden');
    $('#crumbs').innerHTML = '';
    updateSelectionUI();
    return;
  }
  const q = $('#find').value.trim().toLowerCase();
  const all = q ? searchItems(q) : childrenOf(S.prefix);
  S.rows = all.slice(0, MAX_ROWS);
  const frag = document.createDocumentFragment();
  for (const it of S.rows) frag.appendChild(rowEl(it, !!q));
  tbody.appendChild(frag);
  $('#rows-empty').classList.toggle('hidden', all.length > 0);
  $('#rows-empty').textContent = q ? 'No matches.' : 'This folder is empty.';
  renderCrumbs(q, all.length);
  updateSelectionUI();
}

function rowEl(it, searching) {
  const tr = document.createElement('tr');
  if (S.selected.has(it.key)) tr.classList.add('sel');

  const c0 = document.createElement('td');
  c0.className = 'chk';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = S.selected.has(it.key);
  cb.addEventListener('change', () => {
    toggleKey(it.key, cb.checked);
    tr.classList.toggle('sel', cb.checked);
  });
  c0.appendChild(cb);

  const name = document.createElement('td');
  name.className = `name${it.isDir && !searching ? ' dir' : ''}`;
  const shown = searching ? it.label : it.label;
  name.textContent = shown + (it.isDir ? '/' : '');
  name.title = it.key;
  if (it.isDir && !searching) {
    name.addEventListener('click', () => {
      S.prefix = it.key;
      renderBrowser();
    });
  }

  const size = document.createElement('td');
  size.className = 'num';
  size.textContent = it.isDir && !it.size ? '' : fmtSize(it.size);
  const packed = document.createElement('td');
  packed.className = 'num';
  packed.textContent = it.packed === null || it.packed === undefined ? '—' : fmtSize(it.packed);
  const saved = document.createElement('td');
  saved.className = 'num';
  saved.textContent = it.size && it.packed !== null && it.packed !== undefined
    ? `${Math.round(100 * (1 - it.packed / it.size))}%`
    : '—';
  const modified = document.createElement('td');
  modified.textContent = fmtDate(it.modified);
  const lock = document.createElement('td');
  lock.className = 'lock';
  lock.textContent = it.encrypted ? '🔒' : '';

  tr.append(c0, name, size, packed, saved, modified, lock);
  return tr;
}

function renderCrumbs(q, count) {
  const box = $('#crumbs');
  box.innerHTML = '';
  if (q) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = `Search results: ${count}${count > MAX_ROWS ? ` (showing first ${MAX_ROWS})` : ''}`;
    box.appendChild(span);
    return;
  }
  const mk = (label, prefix) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      S.prefix = prefix;
      renderBrowser();
    });
    return b;
  };
  box.appendChild(mk(S.open.name, ''));
  let acc = '';
  for (const seg of S.prefix.split('/').filter(Boolean)) {
    acc += `${seg}/`;
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    box.append(sep, mk(seg, acc));
  }
}

function toggleKey(key, on) {
  if (on) S.selected.add(key);
  else S.selected.delete(key);
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = S.selected.size;
  const hasArchive = !!S.open;
  $('#extract-sel').disabled = !hasArchive || n === 0;
  $('#extract-all').disabled = !hasArchive;
  $('#extract-sel').textContent = n ? `Extract selected (${n})` : 'Extract selected';
  const all = S.rows.length > 0 && S.rows.every((r) => S.selected.has(r.key));
  $('#select-all').checked = all;
  $('#select-all').indeterminate = !all && S.rows.some((r) => S.selected.has(r.key));
}

function selectAllShown(on) {
  for (const r of S.rows) {
    if (on) S.selected.add(r.key);
    else S.selected.delete(r.key);
  }
  renderBrowser();
}

/* ---------------- extract and test ---------------- */

async function extract(keys) {
  if (!S.open) return;
  const dest = $('#dest').value.trim();
  if (!dest) return toast('Choose a destination folder.', 'warn');
  const base = {
    archive: S.open.path,
    dest,
    selected: keys && keys.length ? keys : undefined,
    overwrite: $('#overwrite').value,
    password: S.password || undefined,
  };
  let res = await runTask('Extracting', () => api.extract(base));
  if (!res) return;
  if (!res.ok && (res.code === 'PASSWORD_REQUIRED' || res.code === 'WRONG_PASSWORD')) {
    const pw = await askPassword(
      res.code === 'WRONG_PASSWORD' ? 'Wrong password' : 'Password required',
      `Enter the password to extract ${S.open.name}.`
    );
    if (!pw) return;
    S.password = pw;
    base.password = pw;
    res = await runTask('Extracting', () => api.extract(base));
    if (!res) return;
  }
  if (!res.ok) return showError(res);

  const d = res.data;
  let msg = `Extracted ${d.extracted} item(s)`;
  if (d.skipped) msg += ` · ${d.skipped} skipped`;
  const unsafe = d.unsafe ? d.unsafe.length : 0;
  if (unsafe) msg += ` · ${unsafe} unsafe path(s) blocked`;
  setStatus(msg);
  toast(msg, unsafe ? 'warn' : '', { label: 'Open folder', fn: () => api.openFolder(dest) });
  if ($('#open-after').checked) api.openFolder(dest);
}

async function testArchive() {
  if (!S.open) return toast('Open an archive first.', 'warn');
  let res = await runTask('Testing', () => api.test({ archive: S.open.path, password: S.password || undefined }));
  if (!res) return;
  if (!res.ok && (res.code === 'PASSWORD_REQUIRED' || res.code === 'WRONG_PASSWORD')) {
    const pw = await askPassword('Password required', `Enter the password to test ${S.open.name}.`);
    if (!pw) return;
    S.password = pw;
    res = await runTask('Testing', () => api.test({ archive: S.open.path, password: pw }));
    if (!res) return;
  }
  if (!res.ok) return showError(res);
  setStatus(`${S.open.name}: all data verified`);
  toast('All data verified. No corruption found.');
}

/* ---------------- recovery tab ---------------- */

function setParPath(p) {
  S.parPath = p;
  $('#par-path').value = p;
  $('#par-verify').disabled = false;
  $('#par-repair').disabled = false;
  const r = $('#par-result');
  r.className = 'result';
  r.textContent = '';
}

function showParResult(text, cls) {
  const r = $('#par-result');
  r.className = `result ${cls}`;
  r.textContent = text;
}

async function parVerify() {
  if (!S.parPath) return;
  const res = await runTask('Checking recovery set', () => api.verify(S.parPath));
  if (!res) return;
  if (!res.ok) return showError(res);
  const s = res.data.status;
  if (s === 'intact') showParResult('All files are intact. Nothing needs repair.', 'ok');
  else if (s === 'repairable') showParResult('Damage found, and the recovery data can repair it. Click Repair.', '');
  else showParResult('Too much damage for this recovery set. Keep a copy and try another source.', 'bad');
}

async function parRepair() {
  if (!S.parPath) return;
  const res = await runTask('Repairing', () => api.repair(S.parPath));
  if (!res) return;
  if (!res.ok) return showParResult(friendly(res), 'bad');
  showParResult('Repair complete. Damaged files were rebuilt. Test them to confirm.', 'ok');
}

/* ---------------- tasks, progress, dialogs ---------------- */

function setBusy(on, title = '') {
  S.busy = on;
  S.title = title;
  S.jobId = null;
  document.body.classList.toggle('is-busy', on);
  $('#cancel').disabled = !on;
  $('#progress-wrap').classList.toggle('hidden', !on);
  const bar = $('#bar');
  bar.style.width = '0%';
  bar.classList.toggle('indeterminate', on);
  $('#pct').textContent = '';
  if (on) setStatus(`${title}…`);
}

async function runTask(title, fn) {
  if (S.busy) {
    toast('Please wait for the current task to finish.', 'warn');
    return null;
  }
  setBusy(true, title);
  try {
    return await fn();
  } finally {
    setBusy(false);
  }
}

function setProgress(percent, label) {
  const bar = $('#bar');
  bar.classList.remove('indeterminate');
  bar.style.width = `${percent}%`;
  $('#pct').textContent = `${Math.round(percent)}%`;
  setStatus(`${S.title}${label ? ` · ${label}` : ''}`);
}

function askPassword(title, hint) {
  return new Promise((resolve) => {
    const dlg = $('#pw-dialog');
    const input = $('#pw-input');
    $('#pw-title').textContent = title;
    $('#pw-hint').textContent = hint;
    input.value = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' && input.value ? input.value : null);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    setTimeout(() => input.focus(), 30);
  });
}

function showAbout() {
  window.alert(
    'Shonchoy 2.0.0\n\n' +
    'Free, open-source, offline archive suite for Windows.\n' +
    'Developer: Muhammad Hasan Zarif\n' +
    'License: MIT\n\n' +
    'Shortcuts:\n' +
    '  Ctrl+Enter  create or extract\n' +
    '  Ctrl+O      open archive\n' +
    '  F5          test archive\n' +
    '  Ctrl+A      select all shown items\n' +
    '  Esc         cancel the running task\n' +
    '  F1          this dialog'
  );
}

/* ---------------- opening files from outside ---------------- */

async function handleIncoming(paths) {
  if (!paths || !paths.length) return;
  if (paths.length === 1 && ARCHIVE_RE.test(paths[0])) {
    return openArchive(paths[0]);
  }
  return addPaths(paths);
}

/* ---------------- wiring ---------------- */

function wire() {
  $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#theme').addEventListener('change', (e) => applyTheme(e.target.value));
  $('#about').addEventListener('click', showAbout);
  $('#cancel').addEventListener('click', () => {
    if (S.jobId) api.cancel(S.jobId);
    setStatus('Cancelling…');
  });

  // Create tab
  $('#add-files').addEventListener('click', async () => {
    const r = await api.pickFiles();
    if (r.ok) addPaths(r.data);
  });
  $('#add-folder').addEventListener('click', async () => {
    const r = await api.pickFolder();
    if (r.ok && r.data) addPaths([r.data]);
  });
  $('#clear-queue').addEventListener('click', () => {
    S.queue = [];
    S.outTouched = false;
    renderQueue();
  });
  $('#fmt').addEventListener('change', onFormatChange);
  $('#level').addEventListener('input', (e) => {
    $('#level-val').textContent = e.target.value;
  });
  $('#show-pw').addEventListener('change', (e) => {
    $('#pw').type = e.target.checked ? 'text' : 'password';
    $('#pw2').type = e.target.checked ? 'text' : 'password';
  });
  $('#out').addEventListener('input', () => {
    S.outTouched = true;
  });
  $('#out-browse').addEventListener('click', async () => {
    const spec = currentSpec();
    const r = await api.pickSave(baseOf($('#out').value || `Archive${spec.ext}`), spec.ext);
    if (r.ok && r.data) {
      $('#out').value = r.data;
      S.outTouched = true;
    }
  });
  $('#create').addEventListener('click', () => doCreate(false));

  // Open tab
  $('#open-btn').addEventListener('click', async () => {
    const r = await api.pickArchive();
    if (r.ok && r.data) openArchive(r.data);
  });
  $('#find').addEventListener('input', renderBrowser);
  $('#select-all').addEventListener('change', (e) => selectAllShown(e.target.checked));
  $('#dest-browse').addEventListener('click', async () => {
    const r = await api.pickDestination();
    if (r.ok && r.data) $('#dest').value = r.data;
  });
  $('#extract-sel').addEventListener('click', () => extract(Array.from(S.selected)));
  $('#extract-all').addEventListener('click', () => extract(null));
  $('#test-btn').addEventListener('click', testArchive);

  // Recovery tab
  $('#par-pick').addEventListener('click', async () => {
    const r = await api.pickArchive();
    if (r.ok && r.data) setParPath(r.data);
  });
  $('#par-verify').addEventListener('click', parVerify);
  $('#par-repair').addEventListener('click', parRepair);

  // Global keys
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      primaryAction();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      $('#open-btn').click();
    } else if (e.key === 'F5') {
      e.preventDefault();
      if (S.open) testArchive();
    } else if (e.key === 'F1') {
      e.preventDefault();
      showAbout();
    } else if (e.key === 'Escape' && S.busy) {
      if (S.jobId) api.cancel(S.jobId);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a' && !typing && $('#tab-open').classList.contains('active')) {
      e.preventDefault();
      selectAllShown(true);
    }
  });

  // Drag and drop anywhere
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const showDrop = (on) => $('#dropzone').classList.toggle('hidden', !on);
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    showDrop(true);
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) showDrop(false);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    showDrop(false);
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    if (S.busy) return toast('Wait for the current task to finish, then drop again.', 'warn');
    const paths = api.pathsFromFiles(e.dataTransfer.files).filter(Boolean);
    handleIncoming(paths);
  });
}

function primaryAction() {
  const active = $$('.tab.active')[0]?.dataset.tab;
  if (active === 'create') doCreate(false);
  else if (active === 'open') {
    const keys = Array.from(S.selected);
    extract(keys.length ? keys : null);
  } else if (active === 'repair') parVerify();
}

/* ---------------- start ---------------- */

async function init() {
  applyTheme(localStorage.getItem('theme') || 'system');
  wire();

  api.onJobStarted(({ id }) => {
    S.jobId = id;
  });
  api.onProgress(({ percent, label }) => {
    if (!S.busy) return;
    setProgress(percent, label);
  });
  api.onExternalOpen((paths) => handleIncoming(paths));

  const t = await api.tools();
  if (t.ok) S.tools = t.data;
  const f = await api.formats();
  if (f.ok) S.formats = f.data;

  renderTools();
  fillFormats();
  renderQueue();
  renderBrowser();
  setStatus('Ready · everything runs on your computer');
}

init();
