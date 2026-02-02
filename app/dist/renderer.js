"use strict";

// src/renderer/icons.ts
var ICONS = {
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />',
  pause: '<rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" />',
  keyboard: '<path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" /><path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" />',
  pointer: '<path d="M22 14a8 8 0 0 1-8 8" /><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1" /><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10" /><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />',
  "chevron-up": '<path d="m18 15-6-6-6 6" />',
  "chevron-down": '<path d="m6 9 6 6 6-6" />',
  "chevron-left": '<path d="m15 18-6-6 6-6" />',
  "chevron-right": '<path d="m9 18 6-6-6-6" />',
  "arrow-left": '<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />',
  tv: '<path d="M7 21h10" /><rect width="20" height="14" x="2" y="3" rx="2" />',
  "skip-back": '<path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" /><path d="M3 20V4" />',
  "skip-forward": '<path d="M21 4v16" /><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" />',
  "volume-1": '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" /><path d="M16 9a5 5 0 0 1 0 6" />',
  "volume-2": '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" /><path d="M16 9a5 5 0 0 1 0 6" /><path d="M19.364 18.364a9 9 0 0 0 0-12.728" />'
};
function icon(name) {
  const paths = ICONS[name];
  if (!paths) {
    console.warn("Unknown icon:", name);
    return "";
  }
  return '<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
}
function renderIcons() {
  for (const el of document.querySelectorAll("[data-icon]")) {
    el.innerHTML = icon(el.getAttribute("data-icon"));
  }
}

// src/renderer/state.ts
var SimpleEventEmitter = class {
  listeners = {};
  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }
  emit(event, ...args) {
    const fns = this.listeners[event];
    if (fns) fns.forEach((fn) => fn(...args));
  }
};
function $(sel) {
  return document.querySelector(sel);
}
function $$(sel) {
  return document.querySelectorAll(sel);
}
var atv_connected = false;
var atv_credentials = false;
var pairDevice = "";
var connecting = false;
var atv_events = new SimpleEventEmitter();
function setAtvConnected(val) {
  atv_connected = val;
}
function setAtvCredentials(val) {
  atv_credentials = val;
}
function setPairDevice(val) {
  pairDevice = val;
}
function setConnecting(val) {
  connecting = val;
}
function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// src/renderer/web_remote.ts
var qPresses = 0;
var keymap = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  t: "home",
  l: "home_hold",
  Backspace: "menu",
  Escape: "menu",
  Space: "play_pause",
  Enter: "select",
  Previous: "skip_backward",
  Next: "skip_forward",
  "[": "skip_backward",
  "]": "skip_forward",
  g: "top_menu",
  "+": "volume_up",
  "=": "volume_up",
  "-": "volume_down",
  _: "volume_down"
};
function initIPC() {
  window.electronAPI.onShortcutWin(() => {
    handleDarkMode();
    toggleAltText(true);
  });
  window.electronAPI.onPowerResume(() => {
    connectToATV();
  });
  window.electronAPI.onSendCommand((key) => {
    sendCommand(key);
  });
  window.electronAPI.onErrorMessage((msg) => {
    setStatus(msg);
  });
  window.electronAPI.onContextMenuAction((action, payload) => {
    handleContextMenuAction(action, payload);
  });
  atv_events.on("connected", function(connected) {
    if (connected) {
      updateConnectionDot("connected");
      setStatus("");
      $("#statusText").style.display = "none";
    } else {
      updateConnectionDot("connecting");
      setStatus("Reconnecting...");
      hideNowPlaying();
    }
  });
  atv_events.on("connection_failure", function() {
    updateConnectionDot("disconnected");
  });
  atv_events.on("reconnect_failed", function() {
    updateConnectionDot("disconnected");
    setStatus("Connection lost. Right-click to reconnect.");
  });
  atv_events.on("now-playing", function(info) {
    updateNowPlaying(info);
  });
}
window.addEventListener("blur", () => {
  toggleAltText(true);
});
function toggleAltText(tf) {
  if (tf) {
    $$(".keyText").forEach((el) => el.style.display = "");
    $$(".keyTextAlt").forEach((el) => el.style.display = "none");
  } else {
    $$(".keyText").forEach((el) => el.style.display = "none");
    $$(".keyTextAlt").forEach((el) => el.style.display = "inline");
  }
}
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt") {
    toggleAltText(true);
  }
});
window.addEventListener("keydown", (e) => {
  let key = e.key;
  if (key === " ") key = "Space";
  let mods = [
    "Control",
    "Shift",
    "Alt",
    "Option",
    "Fn",
    "Hyper",
    "OS",
    "Super",
    "Meta",
    "Win"
  ].filter((mod) => e.getModifierState(mod));
  if (mods.length > 0 && mods[0] === "Alt") {
    toggleAltText(false);
  }
  if (mods.length === 1 && mods[0] === "Shift") {
    mods = [];
  }
  if (mods.length > 0) return;
  if (key === "q") {
    qPresses++;
    if (qPresses === 3) window.electronAPI.quit();
  } else {
    qPresses = 0;
  }
  if (key === "h") {
    window.electronAPI.hideWindow();
  }
  if (!atv_connected) {
    if (document.activeElement === $("#pairCode") && key === "Enter") {
      submitCode();
    }
    return;
  }
  if ($("#cancelPairing").style.display !== "none") return;
  if (keymap[key] !== void 0) {
    sendCommand(key);
    e.preventDefault();
  }
});
function createDropdown(ks) {
  $("#loader").style.display = "none";
  $("#statusText").style.display = "none";
  $("#pairingLoader").innerHTML = "";
  $("#pairStepNum").innerHTML = "1";
  $("#pairProtocolName").innerHTML = "Apple TV";
  $("#pairingElements").style.display = "block";
  const picker = $("#atv_picker");
  picker.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a device to pair";
  placeholder.disabled = true;
  placeholder.selected = true;
  picker.appendChild(placeholder);
  ks.forEach(function(name) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    picker.appendChild(opt);
  });
  picker.onchange = function() {
    const vl = picker.value;
    if (vl) {
      startPairing(vl);
    }
  };
}
function createATVDropdown() {
  $("#statusText").style.display = "none";
  handleContextMenu();
}
var keyElCache = /* @__PURE__ */ new Map();
function getKeyEl(key) {
  let el = keyElCache.get(key);
  if (!el || !el.isConnected) {
    const found = $(`[data-key="${key}"]`);
    if (found) {
      keyElCache.set(key, found);
      el = found;
    } else {
      keyElCache.delete(key);
      return void 0;
    }
  }
  return el;
}
async function sendCommand(k) {
  if (k === "Pause") k = "Space";
  let rcmd = keymap[k];
  if (Object.values(keymap).includes(k)) rcmd = k;
  const el = getKeyEl(rcmd);
  if (el) {
    el.classList.add("invert");
    setTimeout(() => {
      el.classList.remove("invert");
    }, 500);
  }
  try {
    await sendKey(rcmd);
  } catch {
    if (el) {
      el.classList.remove("invert");
      el.classList.add("error-flash");
      setTimeout(() => el.classList.remove("error-flash"), 600);
    }
  }
}
var pairButtonBound = false;
function startPairing(dev) {
  setAtvConnected(false);
  $("#initText").style.display = "none";
  $("#results").style.display = "none";
  if (!pairButtonBound) {
    pairButtonBound = true;
    $("#pairButton").addEventListener("click", () => {
      submitCode();
      return false;
    });
  }
  $("#pairCodeElements").style.display = "block";
  startPair(dev);
}
function submitCode() {
  const input = $("#pairCode");
  const code = input.value;
  input.value = "";
  finishPair(code);
}
function showKeyboardHint() {
  const hintCount = parseInt(localStorage.getItem("kbHintCount") || "0");
  if (hintCount >= 3) return;
  localStorage.setItem("kbHintCount", String(hintCount + 1));
  setTimeout(function() {
    toggleAltText(false);
    setTimeout(function() {
      toggleAltText(true);
    }, 1500);
  }, 800);
}
var buttonAbort = null;
function showKeyMap() {
  if (buttonAbort) buttonAbort.abort();
  buttonAbort = new AbortController();
  const { signal } = buttonAbort;
  $("#initText").style.display = "none";
  const touchpad = document.getElementById("touchpad");
  touchpad.style.display = "flex";
  touchpad.classList.add("fade-in");
  let longPressTimer = null;
  let hintHidden = false;
  function hideHint() {
    if (!hintHidden) {
      hintHidden = true;
      const hint = $(".touchpad-hint");
      if (hint) hint.classList.add("hidden");
    }
  }
  function flashArrow(direction) {
    const el = $(".touchpad-arrow-" + direction);
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    const tp = $("#touchpad");
    tp.classList.remove("swipe-pulse");
    void tp.offsetWidth;
    tp.classList.add("swipe-pulse");
  }
  let scrollAccX = 0;
  let scrollAccY = 0;
  let scrollCooldown = false;
  let scrollResetTimer = null;
  const SCROLL_THRESHOLD = 90;
  const SCROLL_COOLDOWN = 200;
  const SCROLL_RESET = 300;
  touchpad.addEventListener(
    "wheel",
    function(e) {
      e.preventDefault();
      hideHint();
      if (scrollCooldown) return;
      scrollAccX += e.deltaX;
      scrollAccY += e.deltaY;
      if (scrollResetTimer) clearTimeout(scrollResetTimer);
      scrollResetTimer = setTimeout(function() {
        scrollAccX = 0;
        scrollAccY = 0;
      }, SCROLL_RESET);
      if (Math.abs(scrollAccX) >= SCROLL_THRESHOLD || Math.abs(scrollAccY) >= SCROLL_THRESHOLD) {
        let direction;
        if (Math.abs(scrollAccX) > Math.abs(scrollAccY)) {
          direction = scrollAccX > 0 ? "left" : "right";
        } else {
          direction = scrollAccY > 0 ? "up" : "down";
        }
        flashArrow(direction);
        sendCommand(direction);
        scrollAccX = 0;
        scrollAccY = 0;
        scrollCooldown = true;
        setTimeout(function() {
          scrollCooldown = false;
        }, SCROLL_COOLDOWN);
      }
    },
    { passive: false }
  );
  let clickStart = null;
  touchpad.addEventListener("mousedown", function(e) {
    hideHint();
    clickStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    longPressTimer = setTimeout(function() {
      sendCommand("select");
      clickStart = null;
    }, 1e3);
  });
  touchpad.addEventListener("mouseup", function(e) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (!clickStart) return;
    const dx = e.clientX - clickStart.x;
    const dy = e.clientY - clickStart.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = Date.now() - clickStart.t;
    if (dist < 15 && elapsed < 300) {
      sendCommand("select");
    }
    clickStart = null;
  });
  const longPressTimers = {};
  const isLongPressing = {};
  const dataKeyEls = $$("[data-key]");
  dataKeyEls.forEach(function(button) {
    button.addEventListener(
      "mousedown",
      function() {
        const key = button.dataset.key;
        if (longPressTimers[key]) {
          clearTimeout(longPressTimers[key]);
        }
        isLongPressing[key] = true;
        button.classList.add("pressing");
        longPressTimers[key] = setTimeout(() => {
          if (!isLongPressing[key]) return;
          button.classList.add("longpress-triggered");
          sendCommand(key);
          isLongPressing[key] = false;
          setTimeout(() => {
            button.classList.remove("pressing", "longpress-triggered");
          }, 200);
        }, 1e3);
      },
      { signal }
    );
    function handleMouseUpLeave(e) {
      const key = button.dataset.key;
      if (isLongPressing[key]) {
        if (longPressTimers[key]) {
          clearTimeout(longPressTimers[key]);
          delete longPressTimers[key];
        }
        isLongPressing[key] = false;
        button.classList.remove("pressing");
        if (e.type === "mouseup") {
          sendCommand(key);
        }
      }
    }
    button.addEventListener("mouseup", handleMouseUpLeave, { signal });
    button.addEventListener("mouseleave", handleMouseUpLeave, { signal });
  });
  showKeyboardHint();
}
function getActiveIdentifier() {
  const active = safeParse(localStorage.getItem("atvcreds"), false);
  return active ? active.identifier : null;
}
function getConnectedDeviceName() {
  const activeId = getActiveIdentifier();
  if (!activeId) return null;
  const creds = safeParse(
    localStorage.getItem("remote_credentials"),
    {}
  );
  const match = Object.entries(creds).find(([, val]) => {
    const v = val;
    return v && v.identifier === activeId;
  });
  if (!match) return null;
  return match[0].replace(/\s*\([\d.]+\)$/, "");
}
function updateConnectionDot(state) {
  const dot = $("#connectionDot");
  dot.classList.remove("connected", "connecting", "disconnected");
  dot.classList.add(state);
  const showName = state === "connected" || state === "connecting";
  const header = $("#topTextHeader");
  header.firstChild.textContent = showName && getConnectedDeviceName() || "ATV Remote";
}
async function connectToATV() {
  if (connecting) return;
  setConnecting(true);
  updateConnectionDot("connecting");
  setStatus("Connecting to ATV...");
  $("#runningElements").style.display = "";
  setAtvCredentials(safeParse(localStorage.getItem("atvcreds"), false));
  $("#pairingElements").style.display = "none";
  try {
    await connectATV(atv_credentials);
    createATVDropdown();
    showKeyMap();
  } catch (err) {
    console.error("Connection failed:", err);
    updateConnectionDot("disconnected");
    startScan();
  }
  setConnecting(false);
}
function setStatus(txt) {
  const el = $("#statusText");
  el.innerHTML = txt;
  el.style.display = "block";
}
function startScan() {
  $("#initText").style.display = "none";
  const loader = $("#loader");
  loader.style.display = "block";
  loader.classList.add("fade-in");
  $("#topTextKBLink").style.display = "none";
  $("#addNewElements").style.display = "";
  $("#runningElements").style.display = "none";
  setStatus("Please wait, scanning...");
  $("#pairingLoader").innerHTML = '<div style="text-align:center"><div class="lds-ellipsis"><div></div><div></div><div></div><div></div></div></div>';
  scanDevices();
}
async function handleDarkMode() {
  try {
    const uimode = localStorage.getItem("uimode") || "systemmode";
    const alwaysUseDarkMode = uimode === "darkmode";
    const neverUseDarkMode = uimode === "lightmode";
    const systemDark = await window.electronAPI.getTheme();
    const darkModeEnabled = (systemDark || alwaysUseDarkMode) && !neverUseDarkMode;
    if (darkModeEnabled) {
      document.body.classList.add("darkMode");
    } else {
      document.body.classList.remove("darkMode");
    }
  } catch (err) {
    console.log("Error setting dark mode:", err);
  }
}
function getCreds(nm) {
  const creds = safeParse(
    localStorage.getItem("remote_credentials"),
    {}
  );
  const keys = Object.keys(creds);
  if (keys.length === 0) return {};
  let result = nm !== void 0 && keys.includes(nm) ? creds[nm] : creds[keys[0]];
  while (typeof result === "string") result = JSON.parse(result);
  return result;
}
function setAlwaysOnTop(tf) {
  window.electronAPI.setAlwaysOnTop(String(tf));
}
function updateNowPlaying(info) {
  const container = $("#nowPlaying");
  if (!container) return;
  const title = info.title || "";
  const artist = info.artist || "";
  if (!title && !artist) {
    container.style.display = "none";
    return;
  }
  container.style.display = "block";
  $("#npTitle").textContent = title;
  $("#npArtist").textContent = artist;
}
function hideNowPlaying() {
  const container = $("#nowPlaying");
  if (container) container.style.display = "none";
}
function showSettings() {
  $("#runningElements").style.display = "none";
  $("#addNewElements").style.display = "none";
  const panel = $("#settingsPanel");
  panel.style.display = "block";
  const currentTheme = localStorage.getItem("uimode") || "systemmode";
  const radios = panel.querySelectorAll('input[name="theme"]');
  radios.forEach((r) => {
    r.checked = r.value === currentTheme;
  });
  const topChecked = safeParse(localStorage.getItem("alwaysOnTopChecked"), false);
  $("#settingsAlwaysOnTop").checked = topChecked;
  populateDeviceList();
}
function hideSettings() {
  $("#settingsPanel").style.display = "none";
  if (atv_connected) {
    $("#runningElements").style.display = "";
  } else {
    $("#addNewElements").style.display = "";
  }
}
function populateDeviceList() {
  const listEl = $("#settingsDeviceList");
  listEl.innerHTML = "";
  const creds = safeParse(
    localStorage.getItem("remote_credentials"),
    {}
  );
  const activeId = getActiveIdentifier();
  for (const name of Object.keys(creds)) {
    const row = document.createElement("div");
    row.className = "settings-device-row";
    const label = document.createElement("span");
    const v = creds[name];
    const isActive = !!(v && activeId && v.identifier === activeId);
    label.textContent = name + (isActive ? " (active)" : "");
    label.className = "settings-device-name";
    row.appendChild(label);
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.className = "settings-device-remove";
    removeBtn.addEventListener("click", () => {
      const allCreds = safeParse(
        localStorage.getItem("remote_credentials"),
        {}
      );
      delete allCreds[name];
      localStorage.setItem("remote_credentials", JSON.stringify(allCreds));
      if (isActive) localStorage.removeItem("atvcreds");
      window.electronAPI.removeDevice(name);
      populateDeviceList();
    });
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  }
  if (Object.keys(creds).length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-empty";
    empty.textContent = "No saved devices";
    listEl.appendChild(empty);
  }
}
function initSettingsListeners() {
  const radios = document.querySelectorAll('#themeRadios input[name="theme"]');
  radios.forEach((r) => {
    r.addEventListener("change", () => {
      localStorage.setItem("uimode", r.value);
      handleDarkMode();
    });
  });
  $("#settingsAlwaysOnTop").addEventListener("change", (e) => {
    const checked = e.target.checked;
    localStorage.setItem("alwaysOnTopChecked", String(checked));
    setAlwaysOnTop(checked);
  });
  $("#settingsHotkeyBtn").addEventListener("click", () => {
    window.electronAPI.loadHotkeyWindow();
  });
  $("#settingsBackBtn").addEventListener("click", () => {
    hideSettings();
  });
}
function handleContextMenu() {
  const creds = safeParse(
    localStorage.getItem("remote_credentials"),
    {}
  );
  const ks = Object.keys(creds);
  const activeId = getActiveIdentifier();
  const mode = localStorage.getItem("uimode") || "systemmode";
  const topChecked = safeParse(localStorage.getItem("alwaysOnTopChecked"), false);
  const devices = ks.map((k) => {
    const v = creds[k];
    return {
      label: k,
      identifier: v ? v.identifier : "",
      checked: !!(v && activeId && v.identifier === activeId)
    };
  });
  window.electronAPI.showContextMenu({
    devices,
    uiMode: mode,
    alwaysOnTop: topChecked
  });
}
function handleContextMenuAction(action, payload) {
  switch (action) {
    case "selectDevice": {
      const creds = safeParse(
        localStorage.getItem("remote_credentials"),
        {}
      );
      if (payload && creds[payload]) {
        localStorage.setItem("atvcreds", JSON.stringify(creds[payload]));
        connectToATV();
        handleContextMenu();
      }
      break;
    }
    case "pairNew":
      startScan();
      break;
    case "repairCurrent":
      localStorage.removeItem("atvcreds");
      startScan();
      break;
    case "setTheme":
      if (payload) {
        localStorage.setItem("uimode", payload);
        handleDarkMode();
        handleContextMenu();
      }
      break;
    case "toggleAlwaysOnTop":
      if (payload !== void 0) {
        localStorage.setItem("alwaysOnTopChecked", payload);
        window.electronAPI.setAlwaysOnTop(payload);
        handleContextMenu();
      }
      break;
    case "openSettings":
      window.electronAPI.showWindow();
      showSettings();
      break;
  }
}
async function init() {
  window.electronAPI.onThemeUpdated(() => {
    handleDarkMode();
  });
  await handleDarkMode();
  handleContextMenu();
  initSettingsListeners();
  $("#cancelPairing").addEventListener("click", () => {
    window.location.reload();
  });
  const checked = safeParse(localStorage.getItem("alwaysOnTopChecked"), false);
  if (checked) setAlwaysOnTop(checked);
  let creds = safeParse(localStorage.getItem("atvcreds"), false);
  if (!creds) {
    const fallback = getCreds();
    if (fallback && "credentials" in fallback) {
      creds = fallback;
      localStorage.setItem("atvcreds", JSON.stringify(creds));
    }
  }
  if (localStorage.getItem("firstRun") !== "false") {
    localStorage.setItem("firstRun", "false");
    window.electronAPI.showWindow();
  }
  if (creds && creds.credentials && creds.identifier) {
    setAtvCredentials(creds);
    connectToATV();
  } else {
    startScan();
  }
}

// src/renderer/atv_remote.ts
var _connection_failure = false;
var reconnectTimer = null;
var reconnectAttempt = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
var MAX_RECONNECT_DELAY = 1e4;
function initRemote() {
  window.electronAPI.onAtvConnected(() => {
    setAtvConnected(true);
    _connection_failure = false;
    cancelReconnect();
    atv_events.emit("connected", true);
  });
  window.electronAPI.onAtvConnectionFailure(() => {
    setAtvConnected(false);
    _connection_failure = true;
    atv_events.emit("connection_failure");
  });
  window.electronAPI.onAtvConnectionLost(() => {
    setAtvConnected(false);
    atv_events.emit("connected", false);
    scheduleReconnect();
  });
  window.electronAPI.onAtvDisconnected(() => {
    setAtvConnected(false);
    atv_events.emit("connected", false);
  });
  window.electronAPI.onAtvNowPlaying((info) => {
    atv_events.emit("now-playing", info);
  });
}
function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}
function scheduleReconnect() {
  cancelReconnect();
  const creds = localStorage.getItem("atvcreds");
  if (!creds) return;
  reconnectAttempt = 0;
  attemptReconnect();
}
function attemptReconnect() {
  if (atv_connected || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      atv_events.emit("reconnect_failed");
    }
    reconnectAttempt = 0;
    return;
  }
  const delay = Math.min(500 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
  reconnectAttempt++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (atv_connected) return;
    try {
      const creds = safeParse(localStorage.getItem("atvcreds"), null);
      if (!creds) return;
      await connectATV(creds);
      reconnectAttempt = 0;
    } catch {
      attemptReconnect();
    }
  }, delay);
}
async function scanDevices() {
  cancelReconnect();
  _connection_failure = false;
  try {
    const results = await window.electronAPI.scan();
    createDropdown(results || []);
  } catch (err) {
    console.error("Scan failed:", err);
    createDropdown([]);
  }
}
function sendKey(cmd) {
  return window.electronAPI.sendKey(cmd);
}
function connectATV(creds) {
  return window.electronAPI.connect(creds).catch((err) => {
    _connection_failure = true;
    atv_events.emit("connection_failure");
    throw err;
  });
}
function startPair(dev) {
  cancelReconnect();
  _connection_failure = false;
  setPairDevice(dev);
  window.electronAPI.startPair(dev).catch((err) => {
    console.error("startPair failed:", err);
  });
}
async function finishPair(code) {
  _connection_failure = false;
  try {
    const result = await window.electronAPI.finishPair(code);
    if (result.needsCompanionPin) {
      $("#pairCode").value = "";
      $("#pairStepNum").textContent = "2";
      $("#pairProtocolName").textContent = "Companion";
      return;
    }
    saveRemote(pairDevice, result);
    localStorage.setItem("atvcreds", JSON.stringify(result));
    connectToATV();
  } catch (err) {
    console.error("finishPair failed:", err);
  }
}
function saveRemote(name, creds) {
  const ar = safeParse(localStorage.getItem("remote_credentials"), {});
  let c = creds;
  if (typeof c === "string") c = JSON.parse(c);
  ar[name] = c;
  localStorage.setItem("remote_credentials", JSON.stringify(ar));
}

// src/renderer/index.ts
document.addEventListener("DOMContentLoaded", function() {
  renderIcons();
  initIPC();
  initRemote();
  init().then(() => {
    console.log("init complete");
  });
});
