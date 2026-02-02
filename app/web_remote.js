var $ = (sel) => document.querySelector(sel);
var $$ = (sel) => document.querySelectorAll(sel);

function debounce(fn, ms) {
    var id;
    return function() {
        clearTimeout(id);
        var args = arguments, ctx = this;
        id = setTimeout(function() { fn.apply(ctx, args); }, ms);
    };
}

var atv_credentials = false;
var pairDevice = "";
var electron = require('electron');
var ipcRenderer = electron.ipcRenderer;
var nativeTheme;
var remote;
var dialog;
var mb;
var Menu, MenuItem;
function initializeRemote() {
    try {
        remote = require('@electron/remote');
        nativeTheme = remote.nativeTheme;
        dialog = remote.dialog;
        Menu = remote.Menu;
        MenuItem = remote.MenuItem;
        mb = remote.getGlobal('MB');
        electron.remote = remote;
        // Ensure menubar tray is ready before proceeding
        if (!mb || !mb.tray) return false;
        return true;
    } catch (err) {
        console.error('Failed to initialize remote:', err);
        return false;
    }
}


const path = require('path');
var device = false;
var qPresses = 0;
var playstate = false;
const keymap = {
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "t": "home",
    "l": "home_hold",
    "Backspace": "menu",
    "Escape": "menu",
    "Space": "play_pause",
    "Enter": "select",
    "Previous": "skip_backward",
    "Next": "skip_forward",
    "[": "skip_backward",
    "]": "skip_forward",
    "g": "top_menu",
    "+": "volume_up",
    "=": "volume_up",
    "-": "volume_down",
    "_": "volume_down"
}

function initIPC() {
    ipcRenderer.on('shortcutWin', (event) => {
        handleDarkMode();
        toggleAltText(true);
    })

    ipcRenderer.on('mainLog', (event, txt) => {
        console.log('[ main ] %s', txt.substring(0, txt.length - 1));
    })

    ipcRenderer.on('powerResume', (event, arg) => {
        connectToATV();
    })

    ipcRenderer.on('sendCommand', (event, key) => {
        console.log(`sendCommand from main: ${key}`)
        sendCommand(key);
    })
    ipcRenderer.on('input-change', (event, data) => {
        // TODO: Re-enable when node-appletv-remote adds text input API
        // ipcRenderer.invoke('atv:setText', data);
    });

    atv_events.on('connected', function(connected) {
        updateConnectionDot(connected ? "connected" : "disconnected");
    });
    atv_events.on('connection_failure', function() {
        updateConnectionDot("disconnected");
    });
}

window.addEventListener('blur', e => {
    toggleAltText(true);
})

window.addEventListener('beforeunload', async e => {
    delete e['returnValue'];
    try {
        ipcRenderer.invoke('debug', 'beforeunload called')
        if (!device) return;
        device.removeAllListeners('message');
        ipcRenderer.invoke('debug', 'messages unregistered')
        await device.closeConnection()
        ipcRenderer.invoke('debug', 'connection closed')
    } catch (err) {
        console.log(err);
    }
});

function toggleAltText(tf) {
    if (tf) {
        $$(".keyText").forEach(el => el.style.display = '');
        $$(".keyTextAlt").forEach(el => el.style.display = 'none');
    } else {
        $$(".keyText").forEach(el => el.style.display = 'none');
        $$(".keyTextAlt").forEach(el => el.style.display = 'inline');
    }
}

function showInlineKeyboard() {
    $("#inline-keyboard").style.display = '';
    // TODO: Re-enable when node-appletv-remote adds text input API
    // ipcRenderer.invoke('atv:getText');
    $("#inlineTextInput").focus();
}

function hideInlineKeyboard() {
    $("#inline-keyboard").style.display = 'none';
    $("#inlineTextInput").blur();
    $("#inlineTextInput").value = "";
}

window.addEventListener('keyup', e => {
    if (e.key == 'Alt') {
        toggleAltText(true);
    }
});

window.addEventListener('app-command', (e, cmd) => {
    console.log('app-command', e, cmd);
})

window.addEventListener('keydown', e => {
    //console.log(e);
    // If inline text input is focused, only handle Escape (to blur), pass everything else to the input
    if (document.activeElement && document.activeElement.id === 'inlineTextInput') {
        if (e.key === 'Escape') {
            e.preventDefault();
            $("#inlineTextInput").blur();
        }
        return;
    }
    var key = e.key;
    if (key == ' ') key = 'Space';
    var mods = ["Control", "Shift", "Alt", "Option", "Fn", "Hyper", "OS", "Super", "Meta", "Win"].filter(mod => { return e.getModifierState(mod) })
    if (mods.length > 0 && mods[0] == 'Alt') {
        toggleAltText(false);
    }
    var shifted = false;
    if (mods.length == 1 && mods[0] == "Shift") {
        shifted = true;
        mods = []
    }
    if (mods.length > 0) return;

    if (key == 'q') {
        qPresses++;
        console.log(`qPresses ${qPresses}`)
        if (qPresses == 3) ipcRenderer.invoke('quit');
    } else {
        qPresses = 0;
    }
    if (key == 'h') {
        ipcRenderer.invoke('hideWindow');
    }
    if (!isConnected()) {
        if (document.activeElement === $("#pairCode") && key == 'Enter') {
            submitCode();
        }
        return;
    }
    if ($("#cancelPairing").style.display !== 'none') return;
    if (keymap[key] !== undefined) {
        sendCommand(key, shifted);
        e.preventDefault();
    }
})

function createDropdown(ks) {
    $("#loader").style.display = 'none';
    var txt = "";
    $("#statusText").style.display = 'none';
    $("#pairingLoader").innerHTML = "";
    $("#pairStepNum").innerHTML = "1";
    $("#pairProtocolName").innerHTML = "Apple TV";
    $("#pairingElements").style.display = 'block';

    var picker = $("#atv_picker");
    picker.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a device to pair';
    placeholder.disabled = true;
    placeholder.selected = true;
    picker.appendChild(placeholder);
    ks.forEach(function(name) {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        picker.appendChild(opt);
    });
    picker.onchange = function() {
        var vl = picker.value;
        if (vl) {
            pairDevice = vl;
            startPairing(vl);
        }
    };
}

function createATVDropdown() {
    $("#statusText").style.display = 'none';
    handleContextMenu();
}


function _updatePlayState() {
    var ic = device.playing ? icon('pause') : icon('play');
    console.log(`Update play state: ${device.playing ? "Pause" : "Play"}`)
    var el = $('[data-key="play_pause"] .keyText');
    if (el) el.innerHTML = ic;
}

var updatePlayState = debounce(_updatePlayState, 300);

async function sendCommand(k, shifted = false) {
    console.log(`sendCommand: ${k}`)
    if (k == 'Pause') k = 'Space';
    var rcmd = keymap[k];
    if (Object.values(keymap).indexOf(k) > -1) rcmd = k;
    if (typeof(rcmd) === 'function') rcmd = rcmd(device);

    var classkey = rcmd;
    if (classkey == 'Play') classkey = 'Pause';
    var el = $(`[data-key="${classkey}"]`);
    if (el) {
        el.classList.add('invert');
        setTimeout(() => {
            el.classList.remove('invert');
        }, 500);
    }
    if (k == 'Space' && el) {
        var ppicon = rcmd == "Pause" ? icon('play') : icon('pause');
        var keyTextEl = el.querySelector('.keyText');
        if (keyTextEl) keyTextEl.innerHTML = ppicon;
    }
    console.log(`Keydown: ${k}, sending command: ${rcmd} (shifted: ${shifted})`)
    if (shifted) {
        sendKeyAction(rcmd, "Hold")
    } else {
        sendKey(rcmd)
    }
}



function isConnected() {
    return atv_connected;
}

async function askQuestion(msg) {
    let options = {
        buttons: ["No", "Yes"],
        message: msg
    }
    var response = await dialog.showMessageBox(options)
    console.log(response)
    return response.response == 1
}


function startPairing(dev) {
    atv_connected = false;
    $("#initText").style.display = 'none';
    $("#results").style.display = 'none';
    $("#pairButton").addEventListener('click', () => {
        submitCode();
        return false;
    });
    $("#pairCodeElements").style.display = 'block';
    startPair(dev);
}

function submitCode() {
    var code = $("#pairCode").value;
    $("#pairCode").value = "";
    finishPair(code);
}

function showKeyboardHint() {
    var hintCount = parseInt(localStorage.getItem('kbHintCount') || "0");
    if (hintCount >= 3) return;
    localStorage.setItem('kbHintCount', String(hintCount + 1));
    // Briefly flash keyboard shortcut labels
    setTimeout(function() {
        toggleAltText(false);
        setTimeout(function() {
            toggleAltText(true);
        }, 1500);
    }, 800);
}

function showKeyMap() {
    $("#initText").style.display = 'none';
    var touchpad = document.getElementById('touchpad');
    touchpad.style.display = 'flex';
    touchpad.classList.add('fade-in');

    // --- Touchpad gesture detection ---
    var startX, startY, startTime;
    var longPressTimer = null;
    var moved = false;
    var hintHidden = false;

    function hideHint() {
        if (!hintHidden) {
            hintHidden = true;
            var hint = $('.touchpad-hint');
            if (hint) hint.classList.add('hidden');
        }
    }

    function flashArrow(direction) {
        var el = $('.touchpad-arrow-' + direction);
        if (!el) return;
        el.classList.remove('flash');
        // Force reflow to restart animation
        void el.offsetWidth;
        el.classList.add('flash');

        // Pulse the touchpad border
        var tp = $('#touchpad');
        tp.classList.remove('swipe-pulse');
        void tp.offsetWidth;
        tp.classList.add('swipe-pulse');
    }

    // --- Swipe detection via two-finger scroll (wheel events) ---
    var scrollAccX = 0;
    var scrollAccY = 0;
    var scrollCooldown = false;
    var scrollResetTimer = null;
    var SCROLL_THRESHOLD = 90;  // accumulated delta px to trigger a nav command
    var SCROLL_COOLDOWN = 200;  // ms before another swipe can fire
    var SCROLL_RESET = 300;     // ms of no scrolling to reset accumulators

    touchpad.addEventListener('wheel', function(e) {
        e.preventDefault();
        hideHint();

        if (scrollCooldown) return;

        scrollAccX += e.deltaX;
        scrollAccY += e.deltaY;

        // Reset accumulators if user stops scrolling
        if (scrollResetTimer) clearTimeout(scrollResetTimer);
        scrollResetTimer = setTimeout(function() {
            scrollAccX = 0;
            scrollAccY = 0;
        }, SCROLL_RESET);

        // Check if accumulated scroll crosses threshold
        if (Math.abs(scrollAccX) >= SCROLL_THRESHOLD || Math.abs(scrollAccY) >= SCROLL_THRESHOLD) {
            var direction;
            if (Math.abs(scrollAccX) > Math.abs(scrollAccY)) {
                direction = scrollAccX > 0 ? 'left' : 'right';
            } else {
                direction = scrollAccY > 0 ? 'up' : 'down';
            }
            console.log('[touchpad] SCROLL SWIPE → ' + direction);
            flashArrow(direction);
            sendCommand(direction, false);

            // Reset and cooldown
            scrollAccX = 0;
            scrollAccY = 0;
            scrollCooldown = true;
            setTimeout(function() { scrollCooldown = false; }, SCROLL_COOLDOWN);
        }
    }, { passive: false });

    // --- Tap (click) and long-press ---
    var clickStart = null;

    touchpad.addEventListener('mousedown', function(e) {
        hideHint();
        clickStart = { x: e.clientX, y: e.clientY, t: Date.now() };
        longPressTimer = setTimeout(function() {
            console.log('[touchpad] long press → select hold');
            sendCommand('select', true);
            clickStart = null;
        }, 1000);
    });

    touchpad.addEventListener('mouseup', function(e) {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (!clickStart) return;
        var dx = e.clientX - clickStart.x;
        var dy = e.clientY - clickStart.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var elapsed = Date.now() - clickStart.t;
        if (dist < 15 && elapsed < 300) {
            console.log('[touchpad] TAP → select');
            sendCommand('select', false);
        }
        clickStart = null;
    });

    // --- Media / secondary button long-press handlers (unchanged logic) ---
    var longPressTimers = {};
    var longPressProgress = {};
    var isLongPressing = {};

    var dataKeyEls = $$("[data-key]");

    dataKeyEls.forEach(function(button) {
        // Remove old listeners by cloning
        var clone = button.cloneNode(true);
        button.parentNode.replaceChild(clone, button);
    });

    // Re-query after cloning
    dataKeyEls = $$("[data-key]");

    dataKeyEls.forEach(function(button) {
        button.addEventListener('mousedown', function(e) {
            var key = button.dataset.key;

            if (longPressTimers[key]) {
                clearTimeout(longPressTimers[key]);
                clearInterval(longPressProgress[key]);
            }

            var progressValue = 0;
            isLongPressing[key] = true;

            button.classList.add('pressing');
            longPressProgress[key] = setInterval(() => {
                if (!isLongPressing[key]) return;

                progressValue += 2;
                var progressPercent = Math.min(progressValue, 100);
                var degrees = Math.round(progressPercent * 3.6);

                var isDarkMode = document.body.classList.contains('darkMode');
                var ringColor = isDarkMode ? 'rgba(10, 132, 255, 0.7)' : 'rgba(0, 113, 227, 0.6)';

                button.style.boxShadow = `0 0 0 3px ${ringColor.replace(/[\d.]+\)$/, (progressPercent / 100 * 0.7).toFixed(2) + ')')}`;

                var scale = 1 + (progressPercent * 0.001);
                button.style.transform = `scale(${scale})`;

            }, 20);

            longPressTimers[key] = setTimeout(() => {
                if (!isLongPressing[key]) return;

                clearInterval(longPressProgress[key]);

                button.classList.add('longpress-triggered');

                var isDarkMode = document.body.classList.contains('darkMode');
                var successRing = isDarkMode ? 'rgba(10, 132, 255, 0.7)' : 'rgba(0, 113, 227, 0.6)';
                button.style.boxShadow = `0 0 0 3px ${successRing}`;

                console.log(`Long press triggered for: ${key}`);
                sendCommand(key, true);

                isLongPressing[key] = false;

                setTimeout(() => {
                    button.classList.remove('pressing', 'longpress-triggered');
                    button.style.background = '';
                    button.style.transform = '';
                    button.style.boxShadow = '';
                }, 200);

            }, 1000);
        });

        function handleMouseUpLeave(e) {
            var key = button.dataset.key;

            if (isLongPressing[key]) {

                if (longPressTimers[key]) {
                    clearTimeout(longPressTimers[key]);
                    longPressTimers[key] = null;
                }
                if (longPressProgress[key]) {
                    clearInterval(longPressProgress[key]);
                    longPressProgress[key] = null;
                }

                isLongPressing[key] = false;

                button.classList.remove('pressing');
                button.style.background = '';
                button.style.transform = '';
                button.style.boxShadow = '';

                if (e.type === 'mouseup') {
                    console.log(`Regular click for: ${key}`);
                    sendCommand(key, false);
                }
            }
        }

        button.addEventListener('mouseup', handleMouseUpLeave);
        button.addEventListener('mouseleave', handleMouseUpLeave);
    });

    // Keyboard focus detection and inline text input require Companion protocol
    // support in node-appletv-remote. TODO: Re-enable when library adds these APIs.
    $("#topTextHeader").style.display = 'none';

    showKeyboardHint();
}

var connecting = false;

function handleMessage(msg) {
    device.lastMessages.push(JSON.parse(JSON.stringify(msg)));
    while (device.lastMessages.length > 100) device.lastMessages.shift();
    if (msg.type == 4) {
        try {
            device.bundleIdentifier = msg.payload.playerPath.client.bundleIdentifier;
            var els = device.bundleIdentifier.split('.')
            var nm = els[els.length - 1];
        } catch (err) {
            console.warn('Could not parse bundle identifier:', err.message);
        }
        if (msg && msg.payload && msg.payload.playbackState) {
            device.playing = msg.payload.playbackState == 1;
            device.lastMessage = JSON.parse(JSON.stringify(msg))
            _updatePlayState();
        }
        if (msg && msg.payload && msg.payload.playbackQueue && msg.payload.playbackQueue.contentItems && msg.payload.playbackQueue.contentItems.length > 0) {
            console.log('got playback item');
            device.playbackItem = JSON.parse(JSON.stringify(msg.payload.playbackQueue.contentItems[0]));
        }
    }
}

function updateConnectionDot(state) {
    var dot = $("#connectionDot");
    dot.classList.remove("connected", "connecting", "disconnected");
    if (state === "connected") dot.classList.add("connected");
    else if (state === "connecting") dot.classList.add("connecting");
    else if (state === "disconnected") dot.classList.add("disconnected");
}

async function connectToATV() {
    if (connecting) return;
    connecting = true;
    updateConnectionDot("connecting");
    setStatus("Connecting to ATV...");
    $("#runningElements").style.display = '';
    atv_credentials = JSON.parse(localStorage.getItem('atvcreds'))

    $("#pairingElements").style.display = 'none';

    try {
        await connectATV(atv_credentials);
        createATVDropdown();
        showKeyMap();
    } catch (err) {
        console.error('Connection failed:', err);
        updateConnectionDot("disconnected");
        startScan();
    }
    connecting = false;
}

var _connectToATV = debounce(connectToATV, 300);

function saveRemote(name, creds) {
    var ar = JSON.parse(localStorage.getItem('remote_credentials') || "{}")
    if (typeof creds == 'string') creds = JSON.parse(creds);
    ar[name] = creds;
    localStorage.setItem('remote_credentials', JSON.stringify(ar));
}

function setStatus(txt) {
    var el = $("#statusText");
    el.innerHTML = txt;
    el.style.display = 'block';
}

function startScan() {
    $("#initText").style.display = 'none';
    var loader = $("#loader");
    loader.style.display = 'block';
    loader.classList.add('fade-in');
    $("#topTextKBLink").style.display = 'none';
    $("#addNewElements").style.display = '';
    $("#runningElements").style.display = 'none';
    setStatus("Please wait, scanning...")
    $("#pairingLoader").innerHTML = '<div style="text-align:center"><div class="lds-ellipsis"><div></div><div></div><div></div><div></div></div></div>';
    scanDevices();
}


function handleDarkMode() {
    try {
        if (!nativeTheme) return;
        var uimode = localStorage.getItem("uimode") || "systemmode";
        var alwaysUseDarkMode = (uimode == "darkmode");
        var neverUseDarkMode = (uimode == "lightmode");

        var darkModeEnabled = (nativeTheme.shouldUseDarkColors || alwaysUseDarkMode) && (!neverUseDarkMode);
        console.log(`darkModeEnabled: ${darkModeEnabled}`)
        if (darkModeEnabled) {
            document.body.classList.add("darkMode");
            ipcRenderer.invoke('uimode', 'darkmode');
        } else {
            document.body.classList.remove("darkMode");
            ipcRenderer.invoke('uimode', 'lightmode');
        }
    } catch (err) {
        console.log('Error setting dark mode:', err);
    }
}

function _getCreds(nm) {
    var creds = JSON.parse(localStorage.getItem('remote_credentials') || "{}")
    var ks = Object.keys(creds);
    if (ks.length === 0) {
        return {};
    }
    if (typeof nm === 'undefined') {
        return creds[ks[0]];
    }
    if (ks.indexOf(nm) > -1) {
        return creds[nm];
    }
}

function getCreds(nm) {
    var r = _getCreds(nm);
    while (typeof r == 'string') r = JSON.parse(r);
    return r;
}

function setAlwaysOnTop(tf) {
    console.log(`setAlwaysOnTop(${tf})`)
    ipcRenderer.invoke('alwaysOnTop', String(tf));
}

var lastMenuEvent;

function subMenuClick(event) {
    var mode = event.id;
    localStorage.setItem('uimode', mode);
    lastMenuEvent = event;
    event.menu.items.forEach(el => {
        el.checked = el.id == mode;
    })
    setTimeout(() => {
        handleDarkMode();
    }, 1);

    console.log(event);
}

async function confirmExit() {
    remote.app.quit();
}

function changeHotkeyClick (event) {
    ipcRenderer.invoke('loadHotkeyWindow');
}

function handleContextMenu() {
    let tray = mb.tray
    var mode = localStorage.getItem('uimode') || 'systemmode';

    // Build Devices submenu from saved credentials
    var creds = JSON.parse(localStorage.getItem('remote_credentials') || "{}");
    var ks = Object.keys(creds);
    var atvc = localStorage.getItem('atvcreds');
    var deviceItems = ks.map(function(k) {
        return {
            type: 'checkbox',
            label: k,
            checked: JSON.stringify(creds[k]) === atvc,
            click: function() {
                localStorage.setItem('atvcreds', JSON.stringify(creds[k]));
                connectToATV();
                handleContextMenu();
            }
        };
    });
    if (deviceItems.length > 0) {
        deviceItems.push({ type: 'separator' });
    }
    deviceItems.push({
        label: 'Pair new device...',
        click: function() {
            mb.showWindow();
            startScan();
        }
    });
    deviceItems.push({
        label: 'Re-pair current device',
        click: function() {
            localStorage.removeItem('atvcreds');
            mb.showWindow();
            startScan();
        }
    });

    const devicesSubMenu = Menu.buildFromTemplate(deviceItems);

    const appearanceSubMenu = Menu.buildFromTemplate([
        { type: 'checkbox', id: 'systemmode', click: subMenuClick, label: 'Follow system settings', checked: (mode == "systemmode") },
        { type: 'checkbox', id: 'darkmode', click: subMenuClick, label: 'Dark mode', checked: (mode == "darkmode") },
        { type: 'checkbox', id: 'lightmode', click: subMenuClick, label: 'Light mode', checked: (mode == "lightmode") }
    ])

    var topChecked = JSON.parse(localStorage.getItem('alwaysOnTopChecked') || "false")
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Devices', submenu: devicesSubMenu },
        { type: 'checkbox', label: 'Always on-top', click: toggleAlwaysOnTop, checked: topChecked },
        { type: 'separator' },
        { label: 'Appearance', submenu: appearanceSubMenu, click: subMenuClick },
        { label: 'Change hotkey', click: changeHotkeyClick },
        { type: 'separator' },
        { role: 'about', label: 'About' },
        { label: 'Quit', click: confirmExit, accelerator: 'CommandOrControl+Q' }
    ]);
    tray.removeAllListeners('right-click');
    tray.on('right-click', () => {
        mb.tray.popUpContextMenu(contextMenu);
    })
}

function toggleAlwaysOnTop(event) {
    localStorage.setItem('alwaysOnTopChecked', String(event.checked));
    ipcRenderer.invoke('alwaysOnTop', String(event.checked));
}


function timeoutAsync(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

var initRetryCount = 0;
var MAX_INIT_RETRIES = 10;

async function init() {
    if (!initializeRemote()) {
        initRetryCount++;
        if (initRetryCount >= MAX_INIT_RETRIES) {
            console.error('Failed to initialize remote after ' + MAX_INIT_RETRIES + ' attempts');
            setStatus("Failed to initialize. Please restart the app.");
            return;
        }
        console.log('Remote not ready, retrying in 100ms... (' + initRetryCount + '/' + MAX_INIT_RETRIES + ')');
        await timeoutAsync(100);
        return await init();
    }
    initRetryCount = 0;
    addThemeListener();
    handleDarkMode();
    handleContextMenu();
    $("#cancelPairing").addEventListener('click', () => {
        console.log('cancelling');
        window.location.reload();
    })

    var checked = JSON.parse(localStorage.getItem('alwaysOnTopChecked') || "false")
    if (checked) setAlwaysOnTop(checked);

    var creds;
    try {
        creds = JSON.parse(localStorage.getItem('atvcreds') || "false")
    } catch {
        creds = getCreds();
        if (creds) localStorage.setItem('atvcreds', JSON.stringify(creds));
    }
    if (localStorage.getItem('firstRun') != 'false') {
        localStorage.setItem('firstRun', 'false');
        mb.showWindow();
    }

    console.log('init: creds=', JSON.stringify(creds));
    if (creds && creds.credentials && creds.identifier) {
        atv_credentials = creds;
        connectToATV();
    } else {
        console.log('init: no valid creds, starting scan');
        startScan();
    }
}

function hideAppMenus() {
    try {
        remote.app.dock.hide();
    } catch (err) {}
}

async function checkEnv() {
    var isProd = await ipcRenderer.invoke('isProduction')
    if (isProd) return hideAppMenus();
}

function themeUpdated() {
    console.log('theme style updated');
    handleDarkMode();
}
var tryThemeAddCount = 0;

function addThemeListener() {
    try {
        if (nativeTheme) {
            nativeTheme.removeAllListeners();
            nativeTheme.on('updated', themeUpdated);
        }
    } catch (err) {
        console.log('nativeTheme not ready yet');
        setTimeout(() => {
            tryThemeAddCount++;
            if (tryThemeAddCount < 10) addThemeListener();
        }, 1000);
    }
}

// initIPC() and initRemote() are called from atv_remote.js on DOM ready
