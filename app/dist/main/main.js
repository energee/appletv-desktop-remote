"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const atv_service_js_1 = __importDefault(require("./atv_service.js"));
const menubar = require('menubar').menubar;
let win = null;
let hotkeyWindow = null;
let mb;
let lastContextMenu = null;
process.env['MYPATH'] = path.join(process.env.APPDATA ||
    (process.platform === 'darwin'
        ? process.env.HOME + '/Library/Application Support'
        : process.env.HOME + '/.local/share'), 'ATV Remote');
const atvService = new atv_service_js_1.default();
const preloadWindow = true;
const readyEvent = preloadWindow ? 'ready' : 'after-create-window';
const preloadPath = path.join(__dirname, 'preload.js');
const preloadHotkeyPath = path.join(__dirname, 'preload-hotkey.js');
function sendToRenderer(channel, ...args) {
    if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, ...args);
    }
}
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        showWindow();
    });
}
function createHotkeyWindow() {
    hotkeyWindow = new electron_1.BrowserWindow({
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
function createWindow() {
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
        win.on('close', () => {
            electron_1.app.exit();
        });
        // Override menubar's 100ms blur-to-hide with a longer delay
        win.removeAllListeners('blur');
        let blurTimeout = null;
        win.on('blur', () => {
            if (!win)
                return;
            if (win.isAlwaysOnTop()) {
                mb.emit('focus-lost');
                return;
            }
            if (blurTimeout)
                clearTimeout(blurTimeout);
            blurTimeout = setTimeout(() => {
                mb.hideWindow();
            }, 200);
        });
        win.on('focus', () => {
            if (blurTimeout) {
                clearTimeout(blurTimeout);
                blurTimeout = null;
            }
        });
        win.on('show', () => {
            sendToRenderer('shortcutWin');
        });
        win.webContents.on('will-navigate', () => {
            // block unexpected navigations
        });
        // --- IPC Handlers ---
        electron_1.ipcMain.handle('loadHotkeyWindow', () => {
            createHotkeyWindow();
        });
        electron_1.ipcMain.handle('quit', () => {
            atvService.destroy();
            electron_1.app.exit();
        });
        electron_1.ipcMain.handle('alwaysOnTop', (_event, arg) => {
            const tf = arg === 'true';
            if (mb.window && !mb.window.isDestroyed())
                mb.window.setAlwaysOnTop(tf);
        });
        electron_1.ipcMain.handle('hideWindow', () => {
            mb.hideWindow();
        });
        electron_1.ipcMain.handle('showWindow', () => {
            showWindow();
        });
        // Theme
        electron_1.ipcMain.handle('getTheme', () => {
            return electron_1.nativeTheme.shouldUseDarkColors;
        });
        electron_1.nativeTheme.on('updated', () => {
            sendToRenderer('theme:updated', electron_1.nativeTheme.shouldUseDarkColors);
        });
        // Hotkey file IPC
        electron_1.ipcMain.handle('hotkey:load', () => {
            const hotkeyPath = path.join(process.env['MYPATH'], 'hotkey.txt');
            if (fs.existsSync(hotkeyPath)) {
                return fs.readFileSync(hotkeyPath, 'utf8').trim() || null;
            }
            return null;
        });
        electron_1.ipcMain.handle('hotkey:save', (_event, combo) => {
            const hotkeyPath = path.join(process.env['MYPATH'], 'hotkey.txt');
            const dir = process.env['MYPATH'];
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const existing = readHotkeys();
            if (existing.length > 1) {
                existing[0] = combo;
                fs.writeFileSync(hotkeyPath, existing.join(','));
            }
            else {
                fs.writeFileSync(hotkeyPath, combo);
            }
        });
        electron_1.ipcMain.handle('hotkey:reset', () => {
            const hotkeyPath = path.join(process.env['MYPATH'], 'hotkey.txt');
            if (fs.existsSync(hotkeyPath))
                fs.unlinkSync(hotkeyPath);
        });
        electron_1.ipcMain.handle('closeHotkeyWindow', () => {
            if (hotkeyWindow && !hotkeyWindow.isDestroyed()) {
                hotkeyWindow.close();
            }
        });
        // Context menu (built in main process from serializable config)
        electron_1.ipcMain.on('showContextMenu', (_event, config) => {
            const deviceItems = config.devices.map((d) => ({
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
            const devicesSubMenu = electron_1.Menu.buildFromTemplate(deviceItems);
            const appearanceSubMenu = electron_1.Menu.buildFromTemplate([
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
            const contextMenu = electron_1.Menu.buildFromTemplate([
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
                        electron_1.app.exit();
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
        electron_1.ipcMain.handle('settings:load', () => {
            // Settings are stored in renderer localStorage, but we provide theme info from main
            return {
                isDark: electron_1.nativeTheme.shouldUseDarkColors,
            };
        });
        electron_1.ipcMain.handle('settings:save', (_event, data) => {
            if (data.alwaysOnTop !== undefined) {
                if (mb.window && !mb.window.isDestroyed()) {
                    mb.window.setAlwaysOnTop(data.alwaysOnTop);
                }
            }
        });
        electron_1.ipcMain.handle('settings:removeDevice', () => {
            // Device removal is handled in renderer localStorage
            // This is a hook for future main-process cleanup if needed
        });
        // ATV Service IPC Handlers
        electron_1.ipcMain.handle('atv:scan', () => atvService.scan());
        electron_1.ipcMain.handle('atv:startPair', async (_event, deviceLabel) => {
            try {
                await atvService.startPair(deviceLabel);
            }
            catch (err) {
                console.log('startPair error:', err.message);
                throw err;
            }
        });
        electron_1.ipcMain.handle('atv:finishPair', (_event, pin) => atvService.finishPair(pin));
        electron_1.ipcMain.handle('atv:connect', async (_event, creds) => {
            try {
                await atvService.connect(creds);
            }
            catch (err) {
                console.warn('Connect failed:', err.message);
                throw err;
            }
        });
        electron_1.ipcMain.handle('atv:disconnect', () => atvService.disconnect());
        electron_1.ipcMain.handle('atv:sendKey', (_event, key) => {
            return atvService.sendKey(key);
        });
        electron_1.ipcMain.handle('atv:isConnected', () => atvService.isConnected());
        // Forward ATVService events to renderer
        atvService.on('connected', () => sendToRenderer('atv:connected'));
        atvService.on('connection-failure', () => sendToRenderer('atv:connection-failure'));
        atvService.on('connection-lost', () => sendToRenderer('atv:connection-lost'));
        atvService.on('disconnected', () => sendToRenderer('atv:disconnected'));
        atvService.on('now-playing', (info) => sendToRenderer('atv:now-playing', info));
        atvService.on('error', (err) => sendToRenderer('atv:error-message', err.message || String(err)));
        electron_1.powerMonitor.addListener('resume', () => {
            sendToRenderer('powerResume');
        });
    });
}
function showWindow() {
    try {
        electron_1.app.show();
    }
    catch (_err) {
        // this happens in windows, doesn't seem to affect anything though
    }
    mb.showWindow();
    setTimeout(() => {
        if (mb.window)
            mb.window.focus();
    }, 200);
}
function readHotkeys() {
    const hotkeyPath = path.join(process.env['MYPATH'], 'hotkey.txt');
    if (!fs.existsSync(hotkeyPath))
        return [];
    const raw = fs.readFileSync(hotkeyPath, 'utf8').trim();
    if (!raw)
        return [];
    return raw
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h !== '');
}
function hideWindow() {
    mb.hideWindow();
    try {
        electron_1.app.hide();
    }
    catch (_err) {
        // not sure if this affects windows like app.show does.
    }
}
function registerHotkeys() {
    try {
        electron_1.globalShortcut.unregisterAll();
    }
    catch (err) {
        console.error('Error unregistering hotkeys:', err);
    }
    let registered = false;
    const hotkeys = readHotkeys();
    if (hotkeys.length > 0) {
        const results = hotkeys.map((hotkey) => {
            return electron_1.globalShortcut.register(hotkey, () => {
                if (mb.window && !mb.window.isDestroyed() && mb.window.isVisible()) {
                    hideWindow();
                }
                else {
                    showWindow();
                }
                sendToRenderer('shortcutWin');
            });
        });
        if (results.every((ok) => ok)) {
            registered = true;
        }
        else {
            results.forEach((ok, idx) => {
                if (!ok)
                    console.error(`Failed to register hotkey: ${hotkeys[idx]}`);
            });
        }
    }
    if (!registered) {
        electron_1.globalShortcut.registerAll(['Super+Shift+R', 'Command+Control+R'], () => {
            if (mb.window && !mb.window.isDestroyed() && mb.window.isVisible()) {
                hideWindow();
            }
            else {
                showWindow();
            }
            sendToRenderer('shortcutWin');
        });
    }
}
electron_1.app.whenReady().then(() => {
    createWindow();
    registerHotkeys();
    const version = electron_1.app.getVersion();
    electron_1.app.setAboutPanelOptions({
        applicationName: 'ATV Remote',
        applicationVersion: version,
        version,
        credits: 'Ted Slesinski',
        copyright: '\u00A9 2026',
        website: 'https://github.com/energee',
    });
});
electron_1.app.on('before-quit', () => {
    atvService.destroy();
});
electron_1.app.on('window-all-closed', () => {
    electron_1.app.quit();
});
electron_1.app.on('activate', () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
