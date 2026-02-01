// ipcRenderer is already declared in web_remote.js (var ipcRenderer = electron.ipcRenderer)
// Just ensure electron is required for this file's needs
var EventEmitter = require('events');

var atv_connected = false;
var connection_failure = false;
var ws_pairDevice = "";

var atv_events = new EventEmitter();

// Listen for main process events
ipcRenderer.on('atv:connected', () => {
    atv_connected = true;
    connection_failure = false;
    atv_events.emit('connected', true);
});

ipcRenderer.on('atv:connection-failure', () => {
    atv_connected = false;
    connection_failure = true;
    atv_events.emit('connection_failure');
});

ipcRenderer.on('atv:connection-lost', () => {
    atv_connected = false;
    atv_events.emit('connected', false);
});

ipcRenderer.on('atv:disconnected', () => {
    atv_connected = false;
    atv_events.emit('connected', false);
});

ipcRenderer.on('atv:now-playing', (event, info) => {
    atv_events.emit('now-playing', info);
});

// --- Public API (same names as ws_remote.js for compatibility) ---

async function ws_startScan() {
    connection_failure = false;
    try {
        var results = await ipcRenderer.invoke('atv:scan');
        createDropdown(results || []);
    } catch (err) {
        console.error('Scan failed:', err);
        createDropdown([]);
    }
}

function ws_sendCommand(cmd) {
    ipcRenderer.invoke('atv:sendKey', cmd).catch(err => {
        console.error('sendKey failed:', err);
    });
}

function ws_sendCommandAction(cmd, taction) {
    // taction: 'Hold', 'DoubleTap', 'SingleTap'
    // node-appletv-remote doesn't support input actions yet — send as normal key
    ipcRenderer.invoke('atv:sendKey', cmd, taction).catch(err => {
        console.error('sendKey failed:', err);
    });
}

function ws_connect(creds) {
    return new Promise((resolve, reject) => {
        ipcRenderer.invoke('atv:connect', creds).then(() => {
            resolve();
        }).catch(err => {
            connection_failure = true;
            atv_events.emit('connection_failure');
            reject(err);
        });
    });
}

function ws_startPair(dev) {
    connection_failure = false;
    ws_pairDevice = dev;
    ipcRenderer.invoke('atv:startPair', dev).catch(err => {
        console.error('startPair failed:', err);
    });
}

// Two-phase pairing: AirPlay first, then Companion
async function ws_finishPair1(code) {
    connection_failure = false;
    try {
        var result = await ipcRenderer.invoke('atv:finishPair', code);
        if (result.needsCompanionPin) {
            // AirPlay paired, now need companion PIN
            console.log('AirPlay paired, waiting for companion PIN...');
            $("#pairCode").val("");
            $("#pairStepNum").text("2");
            $("#pairProtocolName").text("Companion");
            return;
        }
        // Both pairings complete — save and connect
        saveRemote(ws_pairDevice, result);
        localStorage.setItem('atvcreds', JSON.stringify(result));
        connectToATV();
    } catch (err) {
        console.error('finishPair failed:', err);
    }
}

// finishPair2 is no longer needed — single-step pairing
function ws_finishPair2(code) {
    console.warn('ws_finishPair2 called but single-step pairing is active');
}

function ws_is_connected() {
    return ipcRenderer.invoke('atv:isConnected');
}

// --- Initialization ---
function ws_init() {
    console.log('atv_remote init');

    // Migrate from pyatv credentials format
    var existingCreds = localStorage.getItem('atvcreds');
    if (existingCreds) {
        try {
            var parsed = JSON.parse(existingCreds);
            if (parsed.credentials && typeof parsed.credentials === 'string') {
                try {
                    JSON.parse(parsed.credentials);
                    // Parses as JSON — new format, keep it
                } catch {
                    // Not JSON — old pyatv format, clear it
                    console.log('Clearing incompatible pyatv credentials');
                    localStorage.removeItem('atvcreds');
                    localStorage.removeItem('remote_credentials');
                }
            }
        } catch {
            localStorage.removeItem('atvcreds');
        }
    }

    init().then(() => {
        console.log('init complete');
    });
}

$(function() {
    initIPC();
    ws_init();
});
