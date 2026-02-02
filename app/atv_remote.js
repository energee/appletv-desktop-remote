// ipcRenderer is already declared in web_remote.js (var ipcRenderer = electron.ipcRenderer)
// Just ensure electron is required for this file's needs
var EventEmitter = require('events');

var atv_connected = false;
var connection_failure = false;
var pairDevice = "";
var reconnectTimer = null;
var reconnectAttempt = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
var MAX_RECONNECT_DELAY = 30000;

var atv_events = new EventEmitter();

// Listen for main process events
ipcRenderer.on('atv:connected', () => {
    atv_connected = true;
    connection_failure = false;
    cancelReconnect();
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
    scheduleReconnect();
});

ipcRenderer.on('atv:disconnected', () => {
    atv_connected = false;
    atv_events.emit('connected', false);
});

ipcRenderer.on('atv:now-playing', (event, info) => {
    atv_events.emit('now-playing', info);
});

// --- Auto-reconnect ---

function cancelReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempt = 0;
}

function scheduleReconnect() {
    cancelReconnect();
    var creds = localStorage.getItem('atvcreds');
    if (!creds) return;

    reconnectAttempt = 0;
    attemptReconnect();
}

function attemptReconnect() {
    if (atv_connected || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            console.log('Auto-reconnect: max attempts reached');
            atv_events.emit('reconnect_failed');
        }
        reconnectAttempt = 0;
        return;
    }

    var delay = Math.min(1000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
    reconnectAttempt++;
    console.log(`Auto-reconnect: attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (atv_connected) return;

        try {
            var creds = JSON.parse(localStorage.getItem('atvcreds'));
            if (!creds) return;
            await connectATV(creds);
            console.log('Auto-reconnect: success');
            reconnectAttempt = 0;
        } catch (err) {
            console.log('Auto-reconnect: failed -', err.message || err);
            attemptReconnect();
        }
    }, delay);
}

// --- Public API ---

async function scanDevices() {
    cancelReconnect();
    connection_failure = false;
    try {
        var results = await ipcRenderer.invoke('atv:scan');
        createDropdown(results || []);
    } catch (err) {
        console.error('Scan failed:', err);
        createDropdown([]);
    }
}

function sendKey(cmd) {
    ipcRenderer.invoke('atv:sendKey', cmd).catch(err => {
        console.error('sendKey failed:', err);
    });
}

function sendKeyAction(cmd, taction) {
    // taction: 'Hold', 'DoubleTap', 'SingleTap'
    // node-appletv-remote doesn't support input actions yet — send as normal key
    ipcRenderer.invoke('atv:sendKey', cmd, taction).catch(err => {
        console.error('sendKey failed:', err);
    });
}

function connectATV(creds) {
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

function startPair(dev) {
    cancelReconnect();
    connection_failure = false;
    pairDevice = dev;
    ipcRenderer.invoke('atv:startPair', dev).catch(err => {
        console.error('startPair failed:', err);
    });
}

// Two-phase pairing: AirPlay first, then Companion
async function finishPair(code) {
    connection_failure = false;
    try {
        var result = await ipcRenderer.invoke('atv:finishPair', code);
        if (result.needsCompanionPin) {
            // AirPlay paired, now need companion PIN
            console.log('AirPlay paired, waiting for companion PIN...');
            $("#pairCode").value = "";
            $("#pairStepNum").textContent = "2";
            $("#pairProtocolName").textContent = "Companion";
            return;
        }
        // Both pairings complete — save and connect
        saveRemote(pairDevice, result);
        localStorage.setItem('atvcreds', JSON.stringify(result));
        connectToATV();
    } catch (err) {
        console.error('finishPair failed:', err);
    }
}

function checkConnected() {
    return ipcRenderer.invoke('atv:isConnected');
}

// --- Initialization ---
function initRemote() {
    console.log('atv_remote init');

    init().then(() => {
        console.log('init complete');
    });
}

document.addEventListener('DOMContentLoaded', function() {
    initIPC();
    initRemote();
});
