const { app, BrowserWindow, powerMonitor, Tray, Menu, nativeImage, globalShortcut, webContents } = require('electron')
var win;
const { ipcMain } = require('electron')
const path = require('path');
require('@electron/remote/main').initialize()
const menubar = require('menubar').menubar;
const util = require('util');
var secondWindow;
process.env['MYPATH'] = path.join(process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + "/.local/share"), "ATV Remote");
const lodash = _ = require('./js/lodash.min');
const ATVService = require('./atv_service');
const fs = require('fs');
const atvService = new ATVService();

global["atvService"] = atvService;

const preloadWindow = true;
const readyEvent = preloadWindow ? "ready" : "after-create-window";

const volumeButtons = ['VolumeUp', 'VolumeDown', 'VolumeMute']

var handleVolumeButtonsGlobal = false;

var mb;
var kbHasFocus;

console._log = console.log;
console.log = function() {
    let txt = util.format(...[].slice.call(arguments)) + '\n'
    process.stdout.write(txt);
    if (win && win.webContents) {
        win.webContents.send('mainLog', txt);
    }
}



const gotTheLock = app.requestSingleInstanceLock()


if (!gotTheLock) {

    app.quit()
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        console.log('second instance tried to open');
        showWindow();
    })
}
function createHotkeyWindow() {
    hotkeyWindow = new BrowserWindow({
        width: 400,
        height: 340,
        webPreferences: {
            nodeIntegration: true,
            enableRemoteModule: true,
            contextIsolation: false
        }
    });
    require("@electron/remote/main").enable(hotkeyWindow.webContents);
    hotkeyWindow.loadFile('hotkey.html');
    hotkeyWindow.setMenu(null);
    hotkeyWindow.on('closed', () => {
        hotkeyWindow = null;
        registerHotkeys();
    });
}

function createInputWindow() {
    secondWindow = new BrowserWindow({ 
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true    
        },
        hide: true,
        width: 600, 
        height: 250,
        minimizable: false,
        maximizable: false
    });
    require("@electron/remote/main").enable(secondWindow.webContents);
    secondWindow.loadFile('input.html');
    secondWindow.on('close', (event) => {
        event.preventDefault();
        secondWindow.webContents.send('closeInputWindow');
        showWindowThrottle();
    });
    secondWindow.on("blur", () => {
        if (mb.window.isAlwaysOnTop()) return;
        showWindowThrottle();
    })
    secondWindow.setMenu(null);
    secondWindow.hide();
}

function createWindow() {
    mb = menubar({
        preloadWindow: preloadWindow,
        showDockIcon: false,
        browserWindow: {
            width: 280,
            height: 420,
            alwaysOnTop: false,
            webPreferences: {
                nodeIntegration: true,
                enableRemoteModule: true,
                contextIsolation: false
            }
        }
    })
    global['MB'] = mb;

    mb.on(readyEvent, () => {

        require("@electron/remote/main").enable(mb.window.webContents);
        win = mb.window;
       
        var webContents = win.webContents;
        createInputWindow()
       

        win.on('close', () => {
            console.log('window closed, quitting')
            app.exit();
        })
        // Override menubar's 100ms blur-to-hide with a longer delay
        win.removeAllListeners('blur');
        if (mb._blurTimeout) { clearTimeout(mb._blurTimeout); mb._blurTimeout = null; }
        var blurTimeout = null;
        win.on('blur', () => {
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
        win.on('focus', () => {
            if (blurTimeout) { clearTimeout(blurTimeout); blurTimeout = null; }
        });

        win.on('show', () => {
            win.webContents.send('shortcutWin');
            if (handleVolumeButtonsGlobal) handleVolume();
        })

        win.on('hide', () => {
            if (handleVolumeButtonsGlobal) unhandleVolume();
        })

        win.webContents.on('will-navigate', (e, url) => {
            console.log(`will-navigate`, url);
        })
        ipcMain.on('input-change', (event, data) => {
            console.log('Received input:', data);
            win.webContents.send('input-change', data);
        });
        ipcMain.handle("loadHotkeyWindow", (event) => {
            createHotkeyWindow();
        })
        ipcMain.handle('debug', (event, arg) => {
            console.log(`ipcDebug: ${arg}`)
        })
        ipcMain.handle('quit', event => {
            atvService.destroy();
            app.exit()
        });
        ipcMain.handle('alwaysOnTop', (event, arg) => {
            var tf = arg == "true";
            console.log(`setting alwaysOnTop: ${tf}`)
            mb.window.setAlwaysOnTop(tf);
            
        })
        ipcMain.handle('uimode', (event, arg) => {
            secondWindow.webContents.send('uimode', arg);
        });


        ipcMain.handle('hideWindow', (event) => {
            console.log('hiding window');
            mb.hideWindow();
        });
        ipcMain.handle('isProduction', (event) => {
            return (!process.defaultApp);
        });
        ipcMain.handle('closeInputOpenRemote', (event, arg) => {
            console.log('closeInputOpenRemote');
            showWindow();
        })
        ipcMain.handle('openInputWindow', (event, arg) => {
            console.log('openInputWindow');
            secondWindow.show();
            secondWindow.webContents.send('openInputWindow');
        });
        // --- ATV Service IPC Handlers ---
        ipcMain.handle('atv:scan', async () => {
            return await atvService.scan();
        });

        ipcMain.handle('atv:startPair', async (event, deviceLabel) => {
            await atvService.startPair(deviceLabel);
        });

        ipcMain.handle('atv:finishPair', async (event, pin) => {
            return await atvService.finishPair(pin);
        });

        ipcMain.handle('atv:connect', async (event, creds) => {
            await atvService.connect(creds);
        });

        ipcMain.handle('atv:disconnect', async () => {
            await atvService.disconnect();
        });

        ipcMain.handle('atv:sendKey', async (event, key, action) => {
            await atvService.sendKey(key, action);
        });

        ipcMain.handle('atv:isConnected', () => {
            return atvService.isConnected();
        });

        // Forward ATVService events to renderer
        atvService.on('connected', () => {
            if (win) win.webContents.send('atv:connected');
        });
        atvService.on('connection-failure', () => {
            if (win) win.webContents.send('atv:connection-failure');
        });
        atvService.on('connection-lost', () => {
            if (win) win.webContents.send('atv:connection-lost');
        });
        atvService.on('disconnected', () => {
            if (win) win.webContents.send('atv:disconnected');
        });
        atvService.on('now-playing', (info) => {
            if (win) win.webContents.send('atv:now-playing', info);
        });

        powerMonitor.addListener('resume', event => {
            win.webContents.send('powerResume');
        })

    })
}

function showWindow() {
    secondWindow.hide();
    try {
        app.show();
    } catch (err) {
        //console.log(err);
        // this happens in windows, doesn't seem to affect anything though
    }
    mb.showWindow();
    setTimeout(() => {
        mb.window.focus();
    }, 200);
}

var showWindowThrottle = lodash.throttle(showWindow, 100);

function hideWindow() {
    mb.hideWindow();
    try {
        app.hide();
    } catch (err) {
        // console.log(err);
        // not sure if this affects windows like app.show does.
    }
}

function getWorkingPath() {
    var rp = process.resourcesPath;
    if (!rp && process.argv.length > 1) rp = path.resolve(process.argv[1]);
    if (!app.isPackaged) {
        rp = path.resolve(`${path.dirname(process.argv[1])}/../atv_py_env`)
    }
    return rp
}

function unhandleVolume() {
    volumeButtons.forEach(btn => {
        console.log(`unregister: ${btn}`)
        globalShortcut.unregister(btn);
    })
}

function handleVolume() {
    volumeButtons.forEach(btn => {
        console.log(`register: ${btn}`)
        globalShortcut.register(btn, () => {
            var keys = {
                "VolumeUp": "volume_up",
                "VolumeDown": "volume_down",
                "VolumeMute": "volume_mute"
            }
            var key = keys[btn]
            console.log(`sending ${key} for ${btn}`)
            win.webContents.send('sendCommand', key);
        })
    })
}
function registerHotkeys() {
    var hotkeyPath = path.join(process.env['MYPATH'], "hotkey.txt")
    try {
        globalShortcut.unregisterAll();
    } catch (err) {
        console.log(`Error unregistering hotkeys: ${err}`)
    } 
    var registered = false;   
    if (fs.existsSync(hotkeyPath)) {
        
        var hotkeys = fs.readFileSync(hotkeyPath, {encoding: 'utf-8'}).trim();
        if (hotkeys.indexOf(",") > -1) {
            hotkeys = hotkeys.split(',').map(el => { return el.trim() });
        } else {
            hotkeys = [hotkeys];
        }
        console.log(`Registering custom hotkeys: ${hotkeys}`)
        var errs = hotkeys.map(hotkey => {
            console.log(`Registering hotkey: ${hotkey}`)
            return globalShortcut.register(hotkey, () => {
                if (mb.window.isVisible()) {
                    hideWindow();
                } else {
                    showWindow();
                }
                win.webContents.send('shortcutWin');
            })
        })
        // var ret = globalShortcut.registerAll(hotkeys, () => {
        //     if (mb.window.isVisible()) {
        //         hideWindow();
        //     } else {
        //         showWindow();
        //     }
        //     win.webContents.send('shortcutWin');
        // })
        var ret = errs.every(el => { return el });
        if (!ret) {
            errs.forEach((err, idx) => {
                if (!err) {
                    console.log(`Error registering hotkey: ${hotkeys[idx]}`)
                }
            })
            console.log(`Error registering hotkeys: ${hotkeys}`)
        } else {
            registered =true;
        }
    } 
    if (!registered) {
        globalShortcut.registerAll(['Super+Shift+R', 'Command+Control+R'], () => {
            if (mb.window.isVisible()) {
                hideWindow();
            } else {
                showWindow();
            }
            win.webContents.send('shortcutWin');
        })
    }
}

app.whenReady().then(() => {
    createWindow();
    registerHotkeys();
   
    var version = app.getVersion();
    app.setAboutPanelOptions({
        applicationName: "ATV Remote",
        applicationVersion: version,
        version: version,
        credits: "Ted Slesinski",
        copyright: "\u00A9 2026",
        website: "https://github.com/bsharper",
        iconPath: "./images/full.png"
    });
})

app.on("before-quit", () => {
    atvService.destroy();
})

app.on('window-all-closed', () => {
    app.quit()
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})
