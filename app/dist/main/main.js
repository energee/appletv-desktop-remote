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
const util = __importStar(require("util"));
const atv_service_js_1 = __importDefault(require("./atv_service.js"));
const remoteMain = require('@electron/remote/main');
const menubar = require('menubar').menubar;
remoteMain.initialize();
let win = null;
let hotkeyWindow = null;
let mb;
process.env['MYPATH'] = path.join(process.env.APPDATA ||
    (process.platform === 'darwin'
        ? process.env.HOME + '/Library/Application Support'
        : process.env.HOME + '/.local/share'), 'ATV Remote');
const atvService = new atv_service_js_1.default();
global.atvService = atvService;
const preloadWindow = true;
const readyEvent = preloadWindow ? 'ready' : 'after-create-window';
const volumeButtons = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
let handleVolumeButtonsGlobal = false;
console.log = function (...args) {
    const txt = util.format(...args) + '\n';
    process.stdout.write(txt);
    sendToRenderer('mainLog', txt);
};
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
        console.log('second instance tried to open');
        showWindow();
    });
}
function createHotkeyWindow() {
    hotkeyWindow = new electron_1.BrowserWindow({
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
function createWindow() {
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
        remoteMain.enable(mb.window.webContents);
        win = mb.window ?? null;
        win.on('close', () => {
            console.log('window closed, quitting');
            electron_1.app.exit();
        });
        // Override menubar's 100ms blur-to-hide with a longer delay
        win.removeAllListeners('blur');
        // @ts-expect-error accessing private menubar property to clear blur timer
        if (mb._blurTimeout) {
            clearTimeout(mb._blurTimeout);
            mb._blurTimeout = null;
        }
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
            if (handleVolumeButtonsGlobal)
                handleVolume();
        });
        win.on('hide', () => {
            if (handleVolumeButtonsGlobal)
                unhandleVolume();
        });
        win.webContents.on('will-navigate', (_e, url) => {
            console.log(`will-navigate`, url);
        });
        electron_1.ipcMain.handle('loadHotkeyWindow', () => {
            createHotkeyWindow();
        });
        electron_1.ipcMain.handle('quit', () => {
            atvService.destroy();
            electron_1.app.exit();
        });
        electron_1.ipcMain.handle('alwaysOnTop', (_event, arg) => {
            const tf = arg === 'true';
            console.log(`setting alwaysOnTop: ${tf}`);
            mb.window.setAlwaysOnTop(tf);
        });
        electron_1.ipcMain.handle('hideWindow', () => {
            console.log('hiding window');
            mb.hideWindow();
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
            }
        });
        electron_1.ipcMain.handle('atv:disconnect', () => atvService.disconnect());
        electron_1.ipcMain.handle('atv:sendKey', (_event, key, _action) => {
            return atvService.sendKey(key);
        });
        electron_1.ipcMain.handle('atv:isConnected', () => atvService.isConnected());
        // Forward ATVService events to renderer
        atvService.on('connected', () => sendToRenderer('atv:connected'));
        atvService.on('connection-failure', () => sendToRenderer('atv:connection-failure'));
        atvService.on('connection-lost', () => sendToRenderer('atv:connection-lost'));
        atvService.on('disconnected', () => sendToRenderer('atv:disconnected'));
        atvService.on('now-playing', (info) => sendToRenderer('atv:now-playing', info));
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
function hideWindow() {
    mb.hideWindow();
    try {
        electron_1.app.hide();
    }
    catch (_err) {
        // not sure if this affects windows like app.show does.
    }
}
function unhandleVolume() {
    for (const btn of volumeButtons) {
        console.log(`unregister: ${btn}`);
        electron_1.globalShortcut.unregister(btn);
    }
}
function handleVolume() {
    const keys = {
        VolumeUp: 'volume_up',
        VolumeDown: 'volume_down',
        VolumeMute: 'volume_mute',
    };
    for (const btn of volumeButtons) {
        console.log(`register: ${btn}`);
        electron_1.globalShortcut.register(btn, () => {
            const key = keys[btn];
            console.log(`sending ${key} for ${btn}`);
            sendToRenderer('sendCommand', key);
        });
    }
}
function registerHotkeys() {
    const hotkeyPath = path.join(process.env['MYPATH'], 'hotkey.txt');
    try {
        electron_1.globalShortcut.unregisterAll();
    }
    catch (err) {
        console.log(`Error unregistering hotkeys: ${err}`);
    }
    let registered = false;
    if (fs.existsSync(hotkeyPath)) {
        const raw = fs.readFileSync(hotkeyPath, { encoding: 'utf-8' }).trim();
        let hotkeys;
        if (raw.indexOf(',') > -1) {
            hotkeys = raw.split(',').map((el) => el.trim());
        }
        else {
            hotkeys = [raw];
        }
        console.log(`Registering custom hotkeys: ${hotkeys}`);
        const results = hotkeys.map((hotkey) => {
            console.log(`Registering hotkey: ${hotkey}`);
            return electron_1.globalShortcut.register(hotkey, () => {
                if (mb.window.isVisible()) {
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
                    console.log(`Error registering hotkey: ${hotkeys[idx]}`);
            });
            console.log(`Error registering hotkeys: ${hotkeys}`);
        }
    }
    if (!registered) {
        electron_1.globalShortcut.registerAll(['Super+Shift+R', 'Command+Control+R'], () => {
            if (mb.window.isVisible()) {
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
