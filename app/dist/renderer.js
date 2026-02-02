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

// src/renderer/atv_remote.ts
var import_electron2 = require("electron");

// src/renderer/state.ts
var import_events = require("events");
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
var atv_events = new import_events.EventEmitter();
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
var nativeTheme = null;
var remote = null;
var mb = null;
var Menu = null;
function setRemoteModules(r, nt, m, menu) {
  remote = r;
  nativeTheme = nt;
  mb = m;
  Menu = menu;
}

// src/renderer/web_remote.ts
var import_electron = require("electron");
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
function initializeRemote() {
  try {
    const r = require("@electron/remote");
    const nt = r.nativeTheme;
    const menu = r.Menu;
    const m = r.getGlobal("MB");
    setRemoteModules(r, nt, m, menu);
    if (!m || !m.tray) return false;
    return true;
  } catch (err) {
    console.error("Failed to initialize remote:", err);
    return false;
  }
}
function initIPC() {
  import_electron.ipcRenderer.on("shortcutWin", () => {
    handleDarkMode();
    toggleAltText(true);
  });
  import_electron.ipcRenderer.on("powerResume", () => {
    connectToATV();
  });
  import_electron.ipcRenderer.on("sendCommand", (_event, key) => {
    sendCommand(key);
  });
  atv_events.on("connected", function(connected) {
    if (connected) {
      updateConnectionDot("connected");
      setStatus("");
      $("#statusText").style.display = "none";
    } else {
      updateConnectionDot("connecting");
      setStatus("Reconnecting...");
    }
  });
  atv_events.on("connection_failure", function() {
    updateConnectionDot("disconnected");
  });
  atv_events.on("reconnect_failed", function() {
    updateConnectionDot("disconnected");
    setStatus("Connection lost. Right-click to reconnect.");
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
  let shifted = false;
  if (mods.length === 1 && mods[0] === "Shift") {
    shifted = true;
    mods = [];
  }
  if (mods.length > 0) return;
  if (key === "q") {
    qPresses++;
    if (qPresses === 3) import_electron.ipcRenderer.invoke("quit");
  } else {
    qPresses = 0;
  }
  if (key === "h") {
    import_electron.ipcRenderer.invoke("hideWindow");
  }
  if (!atv_connected) {
    if (document.activeElement === $("#pairCode") && key === "Enter") {
      submitCode();
    }
    return;
  }
  if ($("#cancelPairing").style.display !== "none") return;
  if (keymap[key] !== void 0) {
    sendCommand(key, shifted);
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
async function sendCommand(k, shifted = false) {
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
    if (shifted) {
      await sendKeyAction(rcmd, "Hold");
    } else {
      await sendKey(rcmd);
    }
  } catch {
    if (el) {
      el.classList.remove("invert");
      el.classList.add("error-flash");
      setTimeout(() => el.classList.remove("error-flash"), 600);
    }
  }
}
function startPairing(dev) {
  setAtvConnected(false);
  $("#initText").style.display = "none";
  $("#results").style.display = "none";
  $("#pairButton").addEventListener("click", () => {
    submitCode();
    return false;
  });
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
        sendCommand(direction, false);
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
      sendCommand("select", true);
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
      sendCommand("select", false);
    }
    clickStart = null;
  });
  const longPressTimers = {};
  const isLongPressing = {};
  const dataKeyEls = $$("[data-key]");
  dataKeyEls.forEach(function(button) {
    button.addEventListener("mousedown", function() {
      const key = button.dataset.key;
      if (longPressTimers[key]) {
        clearTimeout(longPressTimers[key]);
      }
      isLongPressing[key] = true;
      button.classList.add("pressing");
      longPressTimers[key] = setTimeout(() => {
        if (!isLongPressing[key]) return;
        button.classList.add("longpress-triggered");
        sendCommand(key, true);
        isLongPressing[key] = false;
        setTimeout(() => {
          button.classList.remove("pressing", "longpress-triggered");
        }, 200);
      }, 1e3);
    }, { signal });
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
          sendCommand(key, false);
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
  const creds = safeParse(localStorage.getItem("remote_credentials"), {});
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
function handleDarkMode() {
  try {
    if (!nativeTheme) return;
    const uimode = localStorage.getItem("uimode") || "systemmode";
    const alwaysUseDarkMode = uimode === "darkmode";
    const neverUseDarkMode = uimode === "lightmode";
    const darkModeEnabled = (nativeTheme.shouldUseDarkColors || alwaysUseDarkMode) && !neverUseDarkMode;
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
  const creds = safeParse(localStorage.getItem("remote_credentials"), {});
  const keys = Object.keys(creds);
  if (keys.length === 0) return {};
  let result = nm !== void 0 && keys.includes(nm) ? creds[nm] : creds[keys[0]];
  while (typeof result === "string") result = JSON.parse(result);
  return result;
}
function setAlwaysOnTop(tf) {
  import_electron.ipcRenderer.invoke("alwaysOnTop", String(tf));
}
var lastMenuEvent;
function subMenuClick(event) {
  const mode = event.id;
  localStorage.setItem("uimode", mode);
  lastMenuEvent = event;
  event.menu.items.forEach((el) => {
    el.checked = el.id === mode;
  });
  setTimeout(() => {
    handleDarkMode();
  }, 1);
}
function confirmExit() {
  remote.app.quit();
}
function changeHotkeyClick() {
  import_electron.ipcRenderer.invoke("loadHotkeyWindow");
}
function handleContextMenu() {
  const tray = mb.tray;
  const mode = localStorage.getItem("uimode") || "systemmode";
  const creds = safeParse(localStorage.getItem("remote_credentials"), {});
  const ks = Object.keys(creds);
  const activeId = getActiveIdentifier();
  const deviceItems = ks.map(function(k) {
    const v = creds[k];
    return {
      type: "checkbox",
      label: k,
      checked: !!(v && activeId && v.identifier === activeId),
      click: function() {
        localStorage.setItem("atvcreds", JSON.stringify(creds[k]));
        connectToATV();
        handleContextMenu();
      }
    };
  });
  if (deviceItems.length > 0) {
    deviceItems.push({ type: "separator" });
  }
  deviceItems.push({
    label: "Pair new device...",
    click: function() {
      mb.showWindow();
      startScan();
    }
  });
  deviceItems.push({
    label: "Re-pair current device",
    click: function() {
      localStorage.removeItem("atvcreds");
      mb.showWindow();
      startScan();
    }
  });
  const devicesSubMenu = Menu.buildFromTemplate(deviceItems);
  const appearanceSubMenu = Menu.buildFromTemplate([
    {
      type: "checkbox",
      id: "systemmode",
      click: subMenuClick,
      label: "Follow system settings",
      checked: mode === "systemmode"
    },
    {
      type: "checkbox",
      id: "darkmode",
      click: subMenuClick,
      label: "Dark mode",
      checked: mode === "darkmode"
    },
    {
      type: "checkbox",
      id: "lightmode",
      click: subMenuClick,
      label: "Light mode",
      checked: mode === "lightmode"
    }
  ]);
  const topChecked = safeParse(localStorage.getItem("alwaysOnTopChecked"), false);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Devices", submenu: devicesSubMenu },
    {
      type: "checkbox",
      label: "Always on-top",
      click: toggleAlwaysOnTop,
      checked: topChecked
    },
    { type: "separator" },
    { label: "Appearance", submenu: appearanceSubMenu, click: subMenuClick },
    { label: "Change hotkey", click: changeHotkeyClick },
    { type: "separator" },
    { role: "about", label: "About" },
    { label: "Quit", click: confirmExit, accelerator: "CommandOrControl+Q" }
  ]);
  tray.removeAllListeners("right-click");
  tray.on("right-click", () => {
    mb.tray.popUpContextMenu(contextMenu);
  });
}
function toggleAlwaysOnTop(event) {
  localStorage.setItem("alwaysOnTopChecked", String(event.checked));
  import_electron.ipcRenderer.invoke("alwaysOnTop", String(event.checked));
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var initRetryCount = 0;
var MAX_INIT_RETRIES = 10;
async function init() {
  if (!initializeRemote()) {
    initRetryCount++;
    if (initRetryCount >= MAX_INIT_RETRIES) {
      console.error("Failed to initialize remote after " + MAX_INIT_RETRIES + " attempts");
      setStatus("Failed to initialize. Please restart the app.");
      return;
    }
    console.log(
      "Remote not ready, retrying in 100ms... (" + initRetryCount + "/" + MAX_INIT_RETRIES + ")"
    );
    await delay(100);
    return await init();
  }
  initRetryCount = 0;
  addThemeListener();
  handleDarkMode();
  handleContextMenu();
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
    mb.showWindow();
  }
  if (creds && creds.credentials && creds.identifier) {
    setAtvCredentials(creds);
    connectToATV();
  } else {
    startScan();
  }
}
function themeUpdated() {
  handleDarkMode();
}
var tryThemeAddCount = 0;
function addThemeListener() {
  try {
    if (nativeTheme) {
      nativeTheme.removeAllListeners();
      nativeTheme.on("updated", themeUpdated);
    }
  } catch (err) {
    setTimeout(() => {
      tryThemeAddCount++;
      if (tryThemeAddCount < 10) addThemeListener();
    }, 1e3);
  }
}

// src/renderer/atv_remote.ts
var connection_failure = false;
var reconnectTimer = null;
var reconnectAttempt = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
var MAX_RECONNECT_DELAY = 1e4;
import_electron2.ipcRenderer.on("atv:connected", () => {
  setAtvConnected(true);
  connection_failure = false;
  cancelReconnect();
  atv_events.emit("connected", true);
});
import_electron2.ipcRenderer.on("atv:connection-failure", () => {
  setAtvConnected(false);
  connection_failure = true;
  atv_events.emit("connection_failure");
});
import_electron2.ipcRenderer.on("atv:connection-lost", () => {
  setAtvConnected(false);
  atv_events.emit("connected", false);
  scheduleReconnect();
});
import_electron2.ipcRenderer.on("atv:disconnected", () => {
  setAtvConnected(false);
  atv_events.emit("connected", false);
});
import_electron2.ipcRenderer.on("atv:now-playing", (_event, info) => {
  atv_events.emit("now-playing", info);
});
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
  const delay2 = Math.min(500 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
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
  }, delay2);
}
async function scanDevices() {
  cancelReconnect();
  connection_failure = false;
  try {
    const results = await import_electron2.ipcRenderer.invoke("atv:scan");
    createDropdown(results || []);
  } catch (err) {
    console.error("Scan failed:", err);
    createDropdown([]);
  }
}
function sendKey(cmd) {
  return import_electron2.ipcRenderer.invoke("atv:sendKey", cmd);
}
function sendKeyAction(cmd, taction) {
  return import_electron2.ipcRenderer.invoke("atv:sendKey", cmd, taction);
}
function connectATV(creds) {
  return import_electron2.ipcRenderer.invoke("atv:connect", creds).catch((err) => {
    connection_failure = true;
    atv_events.emit("connection_failure");
    throw err;
  });
}
function startPair(dev) {
  cancelReconnect();
  connection_failure = false;
  setPairDevice(dev);
  import_electron2.ipcRenderer.invoke("atv:startPair", dev).catch((err) => {
    console.error("startPair failed:", err);
  });
}
async function finishPair(code) {
  connection_failure = false;
  try {
    const result = await import_electron2.ipcRenderer.invoke("atv:finishPair", code);
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
function initRemote() {
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
