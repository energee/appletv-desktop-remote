import { app, BrowserWindow, powerMonitor, globalShortcut, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';
import ATVService from './atv_service.js';
import type { Menubar } from 'menubar';
import type { ATVKeyName } from '../shared/types';

declare global {
  var atvService: ATVService;
  var MB: Menubar | null;
}

const remoteMain = require('@electron/remote/main');
const menubar = require('menubar').menubar;

remoteMain.initialize();

let win: BrowserWindow | null = null;
let hotkeyWindow: BrowserWindow | null = null;
let mb!: Menubar;

process.env['MYPATH'] = path.join(
  process.env.APPDATA ||
    (process.platform === 'darwin'
      ? process.env.HOME + '/Library/Application Support'
      : process.env.HOME + '/.local/share'),
  'ATV Remote',
);

const atvService = new ATVService();
global.atvService = atvService;

const preloadWindow = true;
const readyEvent = preloadWindow ? 'ready' : 'after-create-window';

const volumeButtons = ['VolumeUp', 'VolumeDown', 'VolumeMute'] as const;
let handleVolumeButtonsGlobal = false;

console.log = function (...args: unknown[]) {
  const txt = util.format(...args) + '\n';
  process.stdout.write(txt);
  sendToRenderer('mainLog', txt);
};

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send(channel, ...args);
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('second instance tried to open');
    showWindow();
  });
}

function createHotkeyWindow(): void {
  hotkeyWindow = new BrowserWindow({
    width: 400,
    height: 340,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  remoteMain.enable(hotkeyWindow.webContents);
  hotkeyWindow.loadFile(path.join(__dirname, '..', 'hotkey.html'));
  hotkeyWindow.setMenu(null);
  hotkeyWindow.on('closed', () => {
    hotkeyWindow = null;
    registerHotkeys();
  });
}

function createWindow(): void {
  mb = menubar({
    preloadWindow,
    showDockIcon: false,
    browserWindow: {
      width: 280,
      height: 420,
      alwaysOnTop: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    },
  });
  global.MB = mb;

  mb.on(readyEvent, () => {
    remoteMain.enable(mb.window!.webContents);
    win = mb.window ?? null;

    win!.on('close', () => {
      console.log('window closed, quitting');
      app.exit();
    });

    // Override menubar's 100ms blur-to-hide with a longer delay
    win!.removeAllListeners('blur');
    // @ts-expect-error accessing private menubar property to clear blur timer
    if (mb._blurTimeout) { clearTimeout(mb._blurTimeout); mb._blurTimeout = null; }
    let blurTimeout: ReturnType<typeof setTimeout> | null = null;
    win!.on('blur', () => {
      if (!win) return;
      if (win.isAlwaysOnTop()) {
        mb.emit('focus-lost');
        return;
      }
      if (blurTimeout) clearTimeout(blurTimeout);
      blurTimeout = setTimeout(() => {
        mb.hideWindow();
      }, 400);
    });
    win!.on('focus', () => {
      if (blurTimeout) {
        clearTimeout(blurTimeout);
        blurTimeout = null;
      }
    });

    win!.on('show', () => {
      sendToRenderer('shortcutWin');
      if (handleVolumeButtonsGlobal) handleVolume();
    });

    win!.on('hide', () => {
      if (handleVolumeButtonsGlobal) unhandleVolume();
    });

    win!.webContents.on('will-navigate', (_e, url) => {
      console.log(`will-navigate`, url);
    });

    ipcMain.handle('loadHotkeyWindow', () => {
      createHotkeyWindow();
    });
    ipcMain.handle('quit', () => {
      atvService.destroy();
      app.exit();
    });
    ipcMain.handle('alwaysOnTop', (_event, arg: string) => {
      const tf = arg === 'true';
      console.log(`setting alwaysOnTop: ${tf}`);
      mb.window!.setAlwaysOnTop(tf);
    });
    ipcMain.handle('hideWindow', () => {
      console.log('hiding window');
      mb.hideWindow();
    });

    // ATV Service IPC Handlers
    ipcMain.handle('atv:scan', () => atvService.scan());

    ipcMain.handle('atv:startPair', async (_event, deviceLabel: string) => {
      try {
        await atvService.startPair(deviceLabel);
      } catch (err: unknown) {
        console.log('startPair error:', (err as Error).message);
        throw err;
      }
    });

    ipcMain.handle('atv:finishPair', (_event, pin: string) => atvService.finishPair(pin));

    ipcMain.handle('atv:connect', async (_event, creds) => {
      try {
        await atvService.connect(creds);
      } catch (err: unknown) {
        console.warn('Connect failed:', (err as Error).message);
      }
    });

    ipcMain.handle('atv:disconnect', () => atvService.disconnect());

    ipcMain.handle('atv:sendKey', (_event, key: string, _action?: string) => {
      return atvService.sendKey(key as ATVKeyName);
    });

    ipcMain.handle('atv:isConnected', () => atvService.isConnected());

    // Forward ATVService events to renderer
    atvService.on('connected', () => sendToRenderer('atv:connected'));
    atvService.on('connection-failure', () => sendToRenderer('atv:connection-failure'));
    atvService.on('connection-lost', () => sendToRenderer('atv:connection-lost'));
    atvService.on('disconnected', () => sendToRenderer('atv:disconnected'));
    atvService.on('now-playing', (info) => sendToRenderer('atv:now-playing', info));

    powerMonitor.addListener('resume', () => {
      sendToRenderer('powerResume');
    });
  });
}

function showWindow(): void {
  try {
    app.show();
  } catch (_err) {
    // this happens in windows, doesn't seem to affect anything though
  }
  mb.showWindow();
  setTimeout(() => {
    if (mb.window) mb.window.focus();
  }, 200);
}

function hideWindow(): void {
  mb.hideWindow();
  try {
    app.hide();
  } catch (_err) {
    // not sure if this affects windows like app.show does.
  }
}

function unhandleVolume(): void {
  for (const btn of volumeButtons) {
    console.log(`unregister: ${btn}`);
    globalShortcut.unregister(btn);
  }
}

function handleVolume(): void {
  const keys: Record<string, string> = {
    VolumeUp: 'volume_up',
    VolumeDown: 'volume_down',
    VolumeMute: 'volume_mute',
  };
  for (const btn of volumeButtons) {
    console.log(`register: ${btn}`);
    globalShortcut.register(btn, () => {
      const key = keys[btn];
      console.log(`sending ${key} for ${btn}`);
      sendToRenderer('sendCommand', key);
    });
  }
}

function registerHotkeys(): void {
  const hotkeyPath = path.join(process.env['MYPATH']!, 'hotkey.txt');
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    console.log(`Error unregistering hotkeys: ${err}`);
  }
  let registered = false;
  if (fs.existsSync(hotkeyPath)) {
    const raw = fs.readFileSync(hotkeyPath, { encoding: 'utf-8' }).trim();
    let hotkeys: string[];
    if (raw.indexOf(',') > -1) {
      hotkeys = raw.split(',').map((el) => el.trim());
    } else {
      hotkeys = [raw];
    }
    console.log(`Registering custom hotkeys: ${hotkeys}`);
    const results = hotkeys.map((hotkey) => {
      console.log(`Registering hotkey: ${hotkey}`);
      return globalShortcut.register(hotkey, () => {
        if (mb.window!.isVisible()) {
          hideWindow();
        } else {
          showWindow();
        }
        sendToRenderer('shortcutWin');
      });
    });
    if (results.every((ok) => ok)) {
      registered = true;
    } else {
      results.forEach((ok, idx) => {
        if (!ok) console.log(`Error registering hotkey: ${hotkeys[idx]}`);
      });
      console.log(`Error registering hotkeys: ${hotkeys}`);
    }
  }
  if (!registered) {
    globalShortcut.registerAll(['Super+Shift+R', 'Command+Control+R'], () => {
      if (mb.window!.isVisible()) {
        hideWindow();
      } else {
        showWindow();
      }
      sendToRenderer('shortcutWin');
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  registerHotkeys();

  const version = app.getVersion();
  app.setAboutPanelOptions({
    applicationName: 'ATV Remote',
    applicationVersion: version,
    version,
    credits: 'Ted Slesinski',
    copyright: '\u00A9 2026',
    website: 'https://github.com/energee',
  });
});

app.on('before-quit', () => {
  atvService.destroy();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
