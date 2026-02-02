import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  powerMonitor,
  globalShortcut,
  ipcMain,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import ATVService from './atv_service.js';
import type { Menubar } from 'menubar';
import type { ATVKeyName } from '../shared/types';
import type { ContextMenuConfig } from '../shared/electron-api';

const menubar = require('menubar').menubar;

let win: BrowserWindow | null = null;
let hotkeyWindow: BrowserWindow | null = null;
let mb!: Menubar;
let lastContextMenu: Electron.Menu | null = null;

process.env['MYPATH'] = path.join(
  process.env.APPDATA ||
    (process.platform === 'darwin'
      ? process.env.HOME + '/Library/Application Support'
      : process.env.HOME + '/.local/share'),
  'ATV Remote',
);

const atvService = new ATVService();

const preloadWindow = true;
const readyEvent = preloadWindow ? 'ready' : 'after-create-window';

const preloadPath = path.join(__dirname, 'preload.js');
const preloadHotkeyPath = path.join(__dirname, 'preload-hotkey.js');

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
    showWindow();
  });
}

function createHotkeyWindow(): void {
  hotkeyWindow = new BrowserWindow({
    width: 400,
    height: 340,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadHotkeyPath,
    },
  });
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
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
      },
    },
  });

  mb.on(readyEvent, () => {
    win = mb.window ?? null;

    win!.on('close', () => {
      app.exit();
    });

    // Override menubar's 100ms blur-to-hide with a longer delay
    win!.removeAllListeners('blur');
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
      }, 200);
    });
    win!.on('focus', () => {
      if (blurTimeout) {
        clearTimeout(blurTimeout);
        blurTimeout = null;
      }
    });

    win!.on('show', () => {
      sendToRenderer('shortcutWin');
    });

    win!.webContents.on('will-navigate', () => {
      // block unexpected navigations
    });

    // --- IPC Handlers ---

    ipcMain.handle('loadHotkeyWindow', () => {
      createHotkeyWindow();
    });
    ipcMain.handle('quit', () => {
      atvService.destroy();
      app.exit();
    });
    ipcMain.handle('alwaysOnTop', (_event, arg: string) => {
      const tf = arg === 'true';
      if (mb.window && !mb.window.isDestroyed()) mb.window.setAlwaysOnTop(tf);
    });
    ipcMain.handle('hideWindow', () => {
      mb.hideWindow();
    });
    ipcMain.handle('showWindow', () => {
      showWindow();
    });

    // Theme
    ipcMain.handle('getTheme', () => {
      return nativeTheme.shouldUseDarkColors;
    });

    nativeTheme.on('updated', () => {
      sendToRenderer('theme:updated', nativeTheme.shouldUseDarkColors);
    });

    // Hotkey file IPC
    ipcMain.handle('hotkey:load', () => {
      const hotkeyPath = path.join(process.env['MYPATH']!, 'hotkey.txt');
      if (fs.existsSync(hotkeyPath)) {
        return fs.readFileSync(hotkeyPath, 'utf8').trim() || null;
      }
      return null;
    });

    ipcMain.handle('hotkey:save', (_event, combo: string) => {
      const hotkeyPath = path.join(process.env['MYPATH']!, 'hotkey.txt');
      const dir = process.env['MYPATH']!;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const existing = readHotkeys();
      if (existing.length > 1) {
        existing[0] = combo;
        fs.writeFileSync(hotkeyPath, existing.join(','));
      } else {
        fs.writeFileSync(hotkeyPath, combo);
      }
    });

    ipcMain.handle('hotkey:reset', () => {
      const hotkeyPath = path.join(process.env['MYPATH']!, 'hotkey.txt');
      if (fs.existsSync(hotkeyPath)) fs.unlinkSync(hotkeyPath);
    });

    ipcMain.handle('closeHotkeyWindow', () => {
      if (hotkeyWindow && !hotkeyWindow.isDestroyed()) {
        hotkeyWindow.close();
      }
    });

    // Context menu (built in main process from serializable config)
    ipcMain.on('showContextMenu', (_event, config: ContextMenuConfig) => {
      const deviceItems: Electron.MenuItemConstructorOptions[] = config.devices.map((d) => ({
        type: 'checkbox',
        label: d.label,
        checked: d.checked,
        click: () => {
          sendToRenderer('context-menu-action', 'selectDevice', d.label);
        },
      }));
      if (deviceItems.length > 0) {
        deviceItems.push({ type: 'separator' });
      }
      deviceItems.push({
        label: 'Pair new device...',
        click: () => {
          showWindow();
          sendToRenderer('context-menu-action', 'pairNew');
        },
      });
      deviceItems.push({
        label: 'Re-pair current device',
        click: () => {
          showWindow();
          sendToRenderer('context-menu-action', 'repairCurrent');
        },
      });

      const devicesSubMenu = Menu.buildFromTemplate(deviceItems);

      const appearanceSubMenu = Menu.buildFromTemplate([
        {
          type: 'checkbox',
          id: 'systemmode',
          label: 'Follow system settings',
          checked: config.uiMode === 'systemmode',
          click: () => sendToRenderer('context-menu-action', 'setTheme', 'systemmode'),
        },
        {
          type: 'checkbox',
          id: 'darkmode',
          label: 'Dark mode',
          checked: config.uiMode === 'darkmode',
          click: () => sendToRenderer('context-menu-action', 'setTheme', 'darkmode'),
        },
        {
          type: 'checkbox',
          id: 'lightmode',
          label: 'Light mode',
          checked: config.uiMode === 'lightmode',
          click: () => sendToRenderer('context-menu-action', 'setTheme', 'lightmode'),
        },
      ]);

      const contextMenu = Menu.buildFromTemplate([
        { label: 'Devices', submenu: devicesSubMenu },
        {
          type: 'checkbox',
          label: 'Always on-top',
          checked: config.alwaysOnTop,
          click: (menuItem) => {
            sendToRenderer('context-menu-action', 'toggleAlwaysOnTop', String(menuItem.checked));
          },
        },
        { type: 'separator' },
        { label: 'Appearance', submenu: appearanceSubMenu },
        {
          label: 'Settings',
          click: () => sendToRenderer('context-menu-action', 'openSettings'),
        },
        {
          label: 'Change hotkey',
          click: () => createHotkeyWindow(),
        },
        { type: 'separator' },
        { role: 'about', label: 'About' },
        {
          label: 'Quit',
          accelerator: 'CommandOrControl+Q',
          click: () => {
            atvService.destroy();
            app.exit();
          },
        },
      ]);

      lastContextMenu = contextMenu;
      if (mb.tray) {
        mb.tray.popUpContextMenu(contextMenu);
      }
    });

    // Show context menu on tray right-click
    if (mb.tray) {
      mb.tray.on('right-click', () => {
        if (lastContextMenu) {
          mb.tray.popUpContextMenu(lastContextMenu);
        }
      });
    }

    // Settings IPC
    ipcMain.handle('settings:load', () => {
      // Settings are stored in renderer localStorage, but we provide theme info from main
      return {
        isDark: nativeTheme.shouldUseDarkColors,
      };
    });

    ipcMain.handle('settings:save', (_event, data: { alwaysOnTop?: boolean }) => {
      if (data.alwaysOnTop !== undefined) {
        if (mb.window && !mb.window.isDestroyed()) {
          mb.window.setAlwaysOnTop(data.alwaysOnTop);
        }
      }
    });

    ipcMain.handle('settings:removeDevice', () => {
      // Device removal is handled in renderer localStorage
      // This is a hook for future main-process cleanup if needed
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
        throw err;
      }
    });

    ipcMain.handle('atv:disconnect', () => atvService.disconnect());

    ipcMain.handle('atv:sendKey', (_event, key: string) => {
      return atvService.sendKey(key as ATVKeyName);
    });

    ipcMain.handle('atv:isConnected', () => atvService.isConnected());

    // Forward ATVService events to renderer
    atvService.on('connected', () => sendToRenderer('atv:connected'));
    atvService.on('connection-failure', () => sendToRenderer('atv:connection-failure'));
    atvService.on('connection-lost', () => sendToRenderer('atv:connection-lost'));
    atvService.on('disconnected', () => sendToRenderer('atv:disconnected'));
    atvService.on('now-playing', (info) => sendToRenderer('atv:now-playing', info));
    atvService.on('error', (err) =>
      sendToRenderer('atv:error-message', (err as Error).message || String(err)),
    );

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

function readHotkeys(): string[] {
  const hotkeyPath = path.join(process.env['MYPATH']!, 'hotkey.txt');
  if (!fs.existsSync(hotkeyPath)) return [];
  const raw = fs.readFileSync(hotkeyPath, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
}

function hideWindow(): void {
  mb.hideWindow();
  try {
    app.hide();
  } catch (_err) {
    // not sure if this affects windows like app.show does.
  }
}

function registerHotkeys(): void {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    console.error('Error unregistering hotkeys:', err);
  }
  let registered = false;
  const hotkeys = readHotkeys();
  if (hotkeys.length > 0) {
    const results = hotkeys.map((hotkey) => {
      return globalShortcut.register(hotkey, () => {
        if (mb.window && !mb.window.isDestroyed() && mb.window.isVisible()) {
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
        if (!ok) console.error(`Failed to register hotkey: ${hotkeys[idx]}`);
      });
    }
  }
  if (!registered) {
    globalShortcut.registerAll(['Super+Shift+R', 'Command+Control+R'], () => {
      if (mb.window && !mb.window.isDestroyed() && mb.window.isVisible()) {
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
