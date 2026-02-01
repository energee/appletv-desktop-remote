var atv_credentials = false;
var lodash = _ = require('./js/lodash.min');
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
var previousKeys = []

const ws_keymap = {
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

const keymap = {
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'Enter': 'Select',
    'Space': (latv) => {
        var v = latv.playing;
        latv.playing = !latv.playing;
        if (v) {
            return 'Pause';
        } else {
            return 'Play'
        }
    },
    'Backspace': 'Menu',
    'Escape': 'Menu',
    'Next': 'Next',
    'Previous': 'Previous',
    'n': 'Next',
    'p': 'Previous',
    ']': 'Next',
    '[': 'Previous',
    't': 'Tv',
    'l': 'LongTv'
}

const niceButtons = {
    "TV": "Tv",
    "play/pause": "play_pause",
    'Lower Volume': 'volume_down',
    'Raise Volume': 'volume_up'
}

const keyDesc = {
    'Space': 'Pause/Play',
    'ArrowLeft': 'left arrow',
    'ArrowRight': 'right arrow',
    'ArrowUp': 'up arrow',
    'ArrowDown': 'down arrow',
    'Backspace': 'Menu',
    'Escape': 'Menu',
    't': 'TV Button',
    'l': 'Long-press TV Button'
}
function initIPC() {
    ipcRenderer.on('shortcutWin', (event) => {
        handleDarkMode();
        toggleAltText(true);
    })
    
    ipcRenderer.on('scanDevicesResult', (event, ks) => {
        createDropdown(ks);
    })
    
    ipcRenderer.on('pairCredentials', (event, arg) => {
        saveRemote(pairDevice, arg);
        localStorage.setItem('atvcreds', JSON.stringify(getCreds(pairDevice)));
        connectToATV();
    })
    
    ipcRenderer.on('gotStartPair', () => {
        console.log('gotStartPair');
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
        $(".keyText").show();
        $(".keyTextAlt").hide();
    } else {
        $(".keyText").hide();
        $(".keyTextAlt").show();
    }
}

function showInlineKeyboard() {
    $("#inline-keyboard").show();
    // TODO: Re-enable when node-appletv-remote adds text input API
    // ipcRenderer.invoke('atv:getText');
    $("#inlineTextInput").focus();
}

function hideInlineKeyboard() {
    $("#inline-keyboard").hide();
    $("#inlineTextInput").blur();
    $("#inlineTextInput").val("");
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
        if ($("#pairCode").is(':focus') && key == 'Enter') {
            submitCode();
        }
        return;
    }
    if ($("#cancelPairing").is(":visible")) return;
    if (ws_keymap[key] !== undefined) {
        sendCommand(key, shifted);
        e.preventDefault();
    }
})

function createDropdown(ks) {
    $("#loader").hide();
    var txt = "";
    $("#statusText").hide();
    //setStatus("Select a device");
    $("#pairingLoader").html("")
    $("#pairStepNum").html("1");
    $("#pairProtocolName").html("Apple TV");
    $("#pairingElements").show();
    var ar = ks.map(el => {
        return {
            id: el,
            text: el
        }
    })
    ar.unshift({
        id: '',
        text: 'Select a device to pair'
    })
    $("#atv_picker").select2({
        data: ar,
        placeholder: 'Select a device to pair',
        dropdownAutoWidth: true,
        minimumResultsForSearch: Infinity
    }).on('change', () => {
        var vl = $("#atv_picker").val();
        if (vl) {
            pairDevice = vl;
            startPairing(vl);
        }
    })
}

function createATVDropdown() {
    $("#statusText").hide();
    handleContextMenu();
}


function _updatePlayState() {
    var icon = device.playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    console.log(`Update play state: ${device.playing ? "Pause" : "Play"}`)
    $(`[data-key="play_pause"] .keyText`).html(icon);
}

var updatePlayState = lodash.debounce(_updatePlayState, 300);

async function sendCommand(k, shifted = false) {
    console.log(`sendCommand: ${k}`)
    if (k == 'Pause') k = 'Space';
    var rcmd = ws_keymap[k];
    if (Object.values(ws_keymap).indexOf(k) > -1) rcmd = k;
    if (typeof(rcmd) === 'function') rcmd = rcmd(device);

    var classkey = rcmd;
    if (classkey == 'Play') classkey = 'Pause';
    var el = $(`[data-key="${classkey}"]`)
    if (el.length > 0) {
        el.addClass('invert');
        setTimeout(() => {
            el.removeClass('invert');
        }, 500);
    }
    if (k == 'Space') {
        var ppicon = rcmd == "Pause" ? '<i class="fas fa-play"></i>' : '<i class="fas fa-pause"></i>';
        el.find('.keyText').html(ppicon);
    }
    console.log(`Keydown: ${k}, sending command: ${rcmd} (shifted: ${shifted})`)
    previousKeys.push(rcmd);
    if (previousKeys.length > 10) previousKeys.shift()
    if (shifted) {
        ws_sendCommandAction(rcmd, "Hold")
    } else {
        ws_sendCommand(rcmd)
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
    $("#initText").hide();
    $("#results").hide();
    $("#pairButton").on('click', () => {
        submitCode();
        return false;
    });
    $("#pairCodeElements").show();
    ws_startPair(dev);
}

function submitCode() {
    var code = $("#pairCode").val();
    $("#pairCode").val("");
    ws_finishPair1(code);
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
    $("#initText").hide();
    $("#touchpad").css('display', 'flex').hide().fadeIn();

    // --- Touchpad gesture detection ---
    var touchpad = document.getElementById('touchpad');
    var startX, startY, startTime;
    var longPressTimer = null;
    var moved = false;
    var hintHidden = false;

    function hideHint() {
        if (!hintHidden) {
            hintHidden = true;
            $('.touchpad-hint').addClass('hidden');
        }
    }

    function flashArrow(direction) {
        var el = $('.touchpad-arrow-' + direction);
        el.removeClass('flash');
        // Force reflow to restart animation
        void el[0].offsetWidth;
        el.addClass('flash');

        // Pulse the touchpad border
        var tp = $('#touchpad');
        tp.removeClass('swipe-pulse');
        void tp[0].offsetWidth;
        tp.addClass('swipe-pulse');
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

    $("[data-key]").off('mousedown mouseup mouseleave');

    $("[data-key]").on('mousedown', function(e) {
        var key = $(this).data('key');
        var $button = $(this);

        if (longPressTimers[key]) {
            clearTimeout(longPressTimers[key]);
            clearInterval(longPressProgress[key]);
        }

        var progressValue = 0;
        isLongPressing[key] = true;

        $button.addClass('pressing');
        longPressProgress[key] = setInterval(() => {
            if (!isLongPressing[key]) return;

            progressValue += 2;
            var progressPercent = Math.min(progressValue, 100);
            var degrees = Math.round(progressPercent * 3.6);

            var isDarkMode = $('body').hasClass('darkMode');
            var ringColor = isDarkMode ? 'rgba(10, 132, 255, 0.7)' : 'rgba(0, 113, 227, 0.6)';
            var transparentColor = isDarkMode ? 'rgba(10, 132, 255, 0.1)' : 'rgba(0, 113, 227, 0.08)';

            $button.css('box-shadow', `0 0 0 3px ${ringColor.replace(/[\d.]+\)$/, (progressPercent / 100 * 0.7).toFixed(2) + ')')}`);

            var scale = 1 + (progressPercent * 0.001);
            $button.css('transform', `scale(${scale})`);

        }, 20);

        longPressTimers[key] = setTimeout(() => {
            if (!isLongPressing[key]) return;

            clearInterval(longPressProgress[key]);

            $button.addClass('longpress-triggered');

            var isDarkMode = $('body').hasClass('darkMode');
            var successRing = isDarkMode ? 'rgba(10, 132, 255, 0.7)' : 'rgba(0, 113, 227, 0.6)';
            $button.css('box-shadow', `0 0 0 3px ${successRing}`);

            console.log(`Long press triggered for: ${key}`);
            sendCommand(key, true);

            isLongPressing[key] = false;

            setTimeout(() => {
                $button.removeClass('pressing longpress-triggered');
                $button.css({
                    'background': '',
                    'transform': '',
                    'box-shadow': ''
                });
            }, 200);

        }, 1000);
    });

    $("[data-key]").on('mouseup mouseleave', function(e) {
        var key = $(this).data('key');
        var $button = $(this);

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

            $button.removeClass('pressing');
            $button.css({
                'background': '',
                'transform': '',
                'box-shadow': ''
            });

            if (e.type === 'mouseup') {
                console.log(`Regular click for: ${key}`);
                sendCommand(key, false);
            }
        }
    });

    // Keyboard focus detection and inline text input require Companion protocol
    // support in node-appletv-remote. TODO: Re-enable when library adds these APIs.
    $("#topTextHeader").hide();

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
    dot.removeClass("connected connecting disconnected");
    if (state === "connected") dot.addClass("connected");
    else if (state === "connecting") dot.addClass("connecting");
    else if (state === "disconnected") dot.addClass("disconnected");
}

async function connectToATV() {
    if (connecting) return;
    connecting = true;
    updateConnectionDot("connecting");
    setStatus("Connecting to ATV...");
    $("#runningElements").show();
    atv_credentials = JSON.parse(localStorage.getItem('atvcreds'))

    $("#pairingElements").hide();

    try {
        await ws_connect(atv_credentials);
        createATVDropdown();
        showKeyMap();
    } catch (err) {
        console.error('Connection failed:', err);
        updateConnectionDot("disconnected");
        startScan();
    }
    connecting = false;
}

var _connectToATV = lodash.debounce(connectToATV, 300);

function saveRemote(name, creds) {
    var ar = JSON.parse(localStorage.getItem('remote_credentials') || "{}")
    if (typeof creds == 'string') creds = JSON.parse(creds);
    ar[name] = creds;
    localStorage.setItem('remote_credentials', JSON.stringify(ar));
}

function setStatus(txt) {
    $("#statusText").html(txt).show();
}

function startScan() {
    $("#initText").hide();
    $("#loader").fadeIn();
    $("#topTextKBLink").hide();
    $("#addNewElements").show();
    $("#runningElements").hide();
    setStatus("Please wait, scanning...")
    $("#pairingLoader").html(getLoader());
    ws_startScan();
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
            $("body").addClass("darkMode");
            $("#s2style-sheet").attr('href', 'css/select2-inverted.css')
            ipcRenderer.invoke('uimode', 'darkmode');
        } else {
            $("body").removeClass("darkMode");
            $("#s2style-sheet").attr('href', 'css/select2.min.css')
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

async function init() {
    if (!initializeRemote()) {
        console.log('Remote not ready, retrying in 100ms...');
        await timeoutAsync(100);
        return await init();
    }
    addThemeListener();
    handleDarkMode();
    handleContextMenu();
    $("#exitLink").on('click', () => {
        $("#exitLink").blur();
        setTimeout(() => {
            confirmExit();
        }, 1)
    })
    $("#cancelPairing").on('click', () => {
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

// initIPC() and ws_init() are called from atv_remote.js on DOM ready
