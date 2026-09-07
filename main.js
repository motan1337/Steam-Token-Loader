'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const steam = require('./steam');

let win = null;
let elevated = false;

// Full administrator token? 
function checkElevated() {
  return new Promise((resolve) => {
    execFile('net', ['session'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

// UAC
function relaunchAsAdmin() {
  const exe = process.execPath;
  const args = process.argv.slice(1);
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const psArgs = argList.length ? ` -ArgumentList ${argList}` : '';
  const cmd = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'${psArgs} -Verb RunAs`;
  try {
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true }).unref();
    return true;
  } catch (_) {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 520,
    minWidth: 380,
    minHeight: 440,
    backgroundColor: '#141416',
    title: 'Steam Token Loader',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

const fail = (e) => ({ ok: false, error: (e && e.message) || String(e) });
const done = (data) => ({ ok: true, data });

ipcMain.handle('status', async () => {
  let steamFound = true;
  try {
    await steam.getSteamPath();
  } catch (_) {
    steamFound = false;
  }
  return done({ elevated, steamFound });
});

ipcMain.handle('login', async (_evt, line) => {
  try {
    const acc = steam.buildAccount(line); // id----token or a bare token
    const msg = await steam.loginAccount(acc);
    return done({ message: msg, client_audience: acc.client_audience });
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('restart-admin', async () => {
  if (relaunchAsAdmin()) {
    setTimeout(() => app.quit(), 300);
    return done(true);
  }
  return fail(new Error('Could not relaunch as Administrator.'));
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    elevated = await checkElevated();
    if (!elevated && app.isPackaged) {
      if (relaunchAsAdmin()) {
        app.quit();
        return;
      }
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
