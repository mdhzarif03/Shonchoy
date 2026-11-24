'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The renderer never gets Node or Electron objects. It only gets these functions.
const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

const listen = (channel, cb) => {
  const handler = (_event, msg) => cb(msg);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('shonchoy', {
  tools: call('tools:status'),
  formats: call('archive:formats'),

  pickFiles: call('dialog:pickFiles'),
  pickFolder: call('dialog:pickFolder'),
  pickArchive: call('dialog:pickArchive'),
  pickDestination: call('dialog:pickFolderDest'),
  pickSave: (defaultName, ext) => call('dialog:pickSave')({ defaultName, ext }),

  inspect: (paths) => call('fs:inspect')({ paths }),
  open: (path, password) => call('archive:open')({ path, password }),
  create: call('archive:create'),
  extract: call('archive:extract'),
  test: call('archive:test'),
  verify: (path) => call('recovery:verify')({ path }),
  repair: (path) => call('recovery:repair')({ path }),
  cancel: (id) => call('job:cancel')({ id }),

  reveal: (path) => call('shell:reveal')({ path }),
  openFolder: (path) => call('shell:openFolder')({ path }),

  // Electron 32+: the only way to get a real path from a dropped File object.
  pathsFromFiles: (files) => Array.from(files, (f) => webUtils.getPathForFile(f)),

  onJobStarted: (cb) => listen('job:started', cb),
  onProgress: (cb) => listen('job:progress', cb),
  onExternalOpen: (cb) => listen('external:open', cb),
});
