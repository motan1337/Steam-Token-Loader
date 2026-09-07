'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('status'),
  login: (line) => ipcRenderer.invoke('login', line),
  restartAdmin: () => ipcRenderer.invoke('restart-admin'),
});
