import { ipcRenderer } from 'electron';
import type { ATVCredentials, ATVKeyName, KeyboardKeyMap, ConnectionDotState } from '../shared/types';
import {
  $,
  $$,
  atv_connected,
  atv_credentials,
  atv_events,
  connecting,
  pairDevice,
  nativeTheme,
  remote,
  mb,
  Menu,
  setAtvConnected,
  setAtvCredentials,
  setConnecting,
  setRemoteModules,
} from './state';
import {
  sendKey,
  sendKeyAction,
  scanDevices,
  startPair,
  finishPair,
  connectATV,
} from './atv_remote';

let qPresses = 0;

const keymap: KeyboardKeyMap = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  t: 'home',
  l: 'home_hold',
  Backspace: 'menu',
  Escape: 'menu',
  Space: 'play_pause',
  Enter: 'select',
  Previous: 'skip_backward',
  Next: 'skip_forward',
  '[': 'skip_backward',
  ']': 'skip_forward',
  g: 'top_menu',
  '+': 'volume_up',
  '=': 'volume_up',
  '-': 'volume_down',
  _: 'volume_down',
};

function initializeRemote(): boolean {
  try {
    const r = require('@electron/remote');
    const nt = r.nativeTheme;
    const menu = r.Menu;
    const m = r.getGlobal('MB');
    setRemoteModules(r, nt, m, menu);
    // Ensure menubar tray is ready before proceeding
    if (!m || !m.tray) return false;
    return true;
  } catch (err) {
    console.error('Failed to initialize remote:', err);
    return false;
  }
}

export function initIPC(): void {
  ipcRenderer.on('shortcutWin', () => {
    handleDarkMode();
    toggleAltText(true);
  });

  ipcRenderer.on('mainLog', (_event, txt: string) => {
    console.log('[ main ] %s', txt.substring(0, txt.length - 1));
  });

  ipcRenderer.on('powerResume', () => {
    connectToATV();
  });

  ipcRenderer.on('sendCommand', (_event, key: string) => {
    console.log(`sendCommand from main: ${key}`);
    sendCommand(key);
  });

  atv_events.on('connected', function (connected: boolean) {
    updateConnectionDot(connected ? 'connected' : 'disconnected');
  });
  atv_events.on('connection_failure', function () {
    updateConnectionDot('disconnected');
  });
}

window.addEventListener('blur', () => {
  toggleAltText(true);
});

function toggleAltText(tf: boolean): void {
  if (tf) {
    $$('.keyText').forEach((el) => (el.style.display = ''));
    $$('.keyTextAlt').forEach((el) => (el.style.display = 'none'));
  } else {
    $$('.keyText').forEach((el) => (el.style.display = 'none'));
    $$('.keyTextAlt').forEach((el) => (el.style.display = 'inline'));
  }
}

window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') {
    toggleAltText(true);
  }
});

window.addEventListener('keydown', (e) => {
  let key = e.key;
  if (key === ' ') key = 'Space';
  let mods = [
    'Control',
    'Shift',
    'Alt',
    'Option',
    'Fn',
    'Hyper',
    'OS',
    'Super',
    'Meta',
    'Win',
  ].filter((mod) => e.getModifierState(mod));
  if (mods.length > 0 && mods[0] === 'Alt') {
    toggleAltText(false);
  }
  let shifted = false;
  if (mods.length === 1 && mods[0] === 'Shift') {
    shifted = true;
    mods = [];
  }
  if (mods.length > 0) return;

  if (key === 'q') {
    qPresses++;
    console.log(`qPresses ${qPresses}`);
    if (qPresses === 3) ipcRenderer.invoke('quit');
  } else {
    qPresses = 0;
  }
  if (key === 'h') {
    ipcRenderer.invoke('hideWindow');
  }
  if (!atv_connected) {
    if (document.activeElement === $('#pairCode') && key === 'Enter') {
      submitCode();
    }
    return;
  }
  if ($('#cancelPairing')!.style.display !== 'none') return;
  if (keymap[key] !== undefined) {
    sendCommand(key, shifted);
    e.preventDefault();
  }
});

export function createDropdown(ks: string[]): void {
  $('#loader')!.style.display = 'none';
  $('#statusText')!.style.display = 'none';
  $('#pairingLoader')!.innerHTML = '';
  $('#pairStepNum')!.innerHTML = '1';
  $('#pairProtocolName')!.innerHTML = 'Apple TV';
  $('#pairingElements')!.style.display = 'block';

  const picker = $('#atv_picker') as HTMLSelectElement;
  picker.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a device to pair';
  placeholder.disabled = true;
  placeholder.selected = true;
  picker.appendChild(placeholder);
  ks.forEach(function (name) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    picker.appendChild(opt);
  });
  picker.onchange = function () {
    const vl = picker.value;
    if (vl) {
      startPairing(vl);
    }
  };
}

function createATVDropdown(): void {
  $('#statusText')!.style.display = 'none';
  handleContextMenu();
}

export async function sendCommand(k: string, shifted = false): Promise<void> {
  console.log(`sendCommand: ${k}`);
  if (k === 'Pause') k = 'Space';
  let rcmd = keymap[k];
  if ((Object.values(keymap) as string[]).includes(k)) rcmd = k as ATVKeyName;
  const el = $(`[data-key="${rcmd}"]`);
  if (el) {
    el.classList.add('invert');
    setTimeout(() => {
      el.classList.remove('invert');
    }, 500);
  }
  console.log(`Keydown: ${k}, sending command: ${rcmd} (shifted: ${shifted})`);
  if (shifted) {
    sendKeyAction(rcmd, 'Hold');
  } else {
    sendKey(rcmd);
  }
}

function startPairing(dev: string): void {
  setAtvConnected(false);
  $('#initText')!.style.display = 'none';
  $('#results')!.style.display = 'none';
  $('#pairButton')!.addEventListener('click', () => {
    submitCode();
    return false;
  });
  $('#pairCodeElements')!.style.display = 'block';
  startPair(dev);
}

function submitCode(): void {
  const input = $('#pairCode') as HTMLInputElement;
  const code = input.value;
  input.value = '';
  finishPair(code);
}

function showKeyboardHint(): void {
  const hintCount = parseInt(localStorage.getItem('kbHintCount') || '0');
  if (hintCount >= 3) return;
  localStorage.setItem('kbHintCount', String(hintCount + 1));
  setTimeout(function () {
    toggleAltText(false);
    setTimeout(function () {
      toggleAltText(true);
    }, 1500);
  }, 800);
}

function showKeyMap(): void {
  $('#initText')!.style.display = 'none';
  const touchpad = document.getElementById('touchpad')!;
  touchpad.style.display = 'flex';
  touchpad.classList.add('fade-in');

  // --- Touchpad gesture detection ---
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let hintHidden = false;

  function hideHint(): void {
    if (!hintHidden) {
      hintHidden = true;
      const hint = $('.touchpad-hint');
      if (hint) hint.classList.add('hidden');
    }
  }

  function flashArrow(direction: string): void {
    const el = $('.touchpad-arrow-' + direction);
    if (!el) return;
    el.classList.remove('flash');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('flash');

    const tp = $('#touchpad')!;
    tp.classList.remove('swipe-pulse');
    void tp.offsetWidth;
    tp.classList.add('swipe-pulse');
  }

  // --- Swipe detection via two-finger scroll (wheel events) ---
  let scrollAccX = 0;
  let scrollAccY = 0;
  let scrollCooldown = false;
  let scrollResetTimer: ReturnType<typeof setTimeout> | null = null;
  const SCROLL_THRESHOLD = 90;
  const SCROLL_COOLDOWN = 200;
  const SCROLL_RESET = 300;

  touchpad.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      hideHint();

      if (scrollCooldown) return;

      scrollAccX += e.deltaX;
      scrollAccY += e.deltaY;

      if (scrollResetTimer) clearTimeout(scrollResetTimer);
      scrollResetTimer = setTimeout(function () {
        scrollAccX = 0;
        scrollAccY = 0;
      }, SCROLL_RESET);

      if (Math.abs(scrollAccX) >= SCROLL_THRESHOLD || Math.abs(scrollAccY) >= SCROLL_THRESHOLD) {
        let direction: string;
        if (Math.abs(scrollAccX) > Math.abs(scrollAccY)) {
          direction = scrollAccX > 0 ? 'left' : 'right';
        } else {
          direction = scrollAccY > 0 ? 'up' : 'down';
        }
        console.log('[touchpad] SCROLL SWIPE \u2192 ' + direction);
        flashArrow(direction);
        sendCommand(direction, false);

        scrollAccX = 0;
        scrollAccY = 0;
        scrollCooldown = true;
        setTimeout(function () {
          scrollCooldown = false;
        }, SCROLL_COOLDOWN);
      }
    },
    { passive: false },
  );

  // --- Tap (click) and long-press ---
  let clickStart: { x: number; y: number; t: number } | null = null;

  touchpad.addEventListener('mousedown', function (e) {
    hideHint();
    clickStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    longPressTimer = setTimeout(function () {
      console.log('[touchpad] long press \u2192 select hold');
      sendCommand('select', true);
      clickStart = null;
    }, 1000);
  });

  touchpad.addEventListener('mouseup', function (e) {
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
      console.log('[touchpad] TAP \u2192 select');
      sendCommand('select', false);
    }
    clickStart = null;
  });

  // --- Media / secondary button long-press handlers ---
  const longPressTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const longPressProgress: Record<string, ReturnType<typeof setInterval>> = {};
  const isLongPressing: Record<string, boolean> = {};

  let dataKeyEls = $$('[data-key]');

  dataKeyEls.forEach(function (button) {
    const clone = button.cloneNode(true) as HTMLElement;
    button.parentNode!.replaceChild(clone, button);
  });

  // Re-query after cloning
  dataKeyEls = $$('[data-key]');

  dataKeyEls.forEach(function (button) {
    button.addEventListener('mousedown', function () {
      const key = (button as HTMLElement).dataset.key!;

      if (longPressTimers[key]) {
        clearTimeout(longPressTimers[key]);
        clearInterval(longPressProgress[key]);
      }

      let progressValue = 0;
      isLongPressing[key] = true;

      button.classList.add('pressing');
      longPressProgress[key] = setInterval(() => {
        if (!isLongPressing[key]) return;

        progressValue += 2;
        const progressPercent = Math.min(progressValue, 100);

        const isDarkMode = document.body.classList.contains('darkMode');
        const ringColor = isDarkMode ? 'rgba(10, 132, 255, 0.7)' : 'rgba(0, 113, 227, 0.6)';

        button.style.boxShadow = `0 0 0 3px ${ringColor.replace(
          /[\d.]+\)$/,
          ((progressPercent / 100) * 0.7).toFixed(2) + ')',
        )}`;

        const scale = 1 + progressPercent * 0.001;
        button.style.transform = `scale(${scale})`;
      }, 20);

      longPressTimers[key] = setTimeout(() => {
        if (!isLongPressing[key]) return;

        clearInterval(longPressProgress[key]);

        button.classList.add('longpress-triggered');

        const isDarkMode = document.body.classList.contains('darkMode');
        const successRing = isDarkMode ? 'rgba(10, 132, 255, 0.7)' : 'rgba(0, 113, 227, 0.6)';
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

    function handleMouseUpLeave(e: Event): void {
      const key = (button as HTMLElement).dataset.key!;

      if (isLongPressing[key]) {
        if (longPressTimers[key]) {
          clearTimeout(longPressTimers[key]);
          delete longPressTimers[key];
        }
        if (longPressProgress[key]) {
          clearInterval(longPressProgress[key]);
          delete longPressProgress[key];
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

  showKeyboardHint();
}

function getConnectedDeviceName(): string | null {
  const atvc = localStorage.getItem('atvcreds');
  if (!atvc) return null;
  const creds = JSON.parse(localStorage.getItem('remote_credentials') || '{}');
  const match = Object.entries(creds).find(([, val]) => JSON.stringify(val) === atvc);
  return match ? match[0] : null;
}

export function updateConnectionDot(state: ConnectionDotState): void {
  const dot = $('#connectionDot')!;
  dot.classList.remove('connected', 'connecting', 'disconnected');
  dot.classList.add(state);

  const showName = state === 'connected' || state === 'connecting';
  const header = $('#topTextHeader')!;
  header.firstChild!.textContent = (showName && getConnectedDeviceName()) || 'ATV Remote';
}

export async function connectToATV(): Promise<void> {
  if (connecting) return;
  setConnecting(true);
  updateConnectionDot('connecting');
  setStatus('Connecting to ATV...');
  $('#runningElements')!.style.display = '';
  setAtvCredentials(JSON.parse(localStorage.getItem('atvcreds')!));

  $('#pairingElements')!.style.display = 'none';

  try {
    await connectATV(atv_credentials);
    createATVDropdown();
    showKeyMap();
  } catch (err) {
    console.error('Connection failed:', err);
    updateConnectionDot('disconnected');
    startScan();
  }
  setConnecting(false);
}

export function setStatus(txt: string): void {
  const el = $('#statusText')!;
  el.innerHTML = txt;
  el.style.display = 'block';
}

export function startScan(): void {
  $('#initText')!.style.display = 'none';
  const loader = $('#loader')!;
  loader.style.display = 'block';
  loader.classList.add('fade-in');
  $('#topTextKBLink')!.style.display = 'none';
  $('#addNewElements')!.style.display = '';
  $('#runningElements')!.style.display = 'none';
  setStatus('Please wait, scanning...');
  $('#pairingLoader')!.innerHTML =
    '<div style="text-align:center"><div class="lds-ellipsis"><div></div><div></div><div></div><div></div></div></div>';
  scanDevices();
}

function handleDarkMode(): void {
  try {
    if (!nativeTheme) return;
    const uimode = localStorage.getItem('uimode') || 'systemmode';
    const alwaysUseDarkMode = uimode === 'darkmode';
    const neverUseDarkMode = uimode === 'lightmode';

    const darkModeEnabled =
      (nativeTheme.shouldUseDarkColors || alwaysUseDarkMode) && !neverUseDarkMode;
    console.log(`darkModeEnabled: ${darkModeEnabled}`);
    if (darkModeEnabled) {
      document.body.classList.add('darkMode');
    } else {
      document.body.classList.remove('darkMode');
    }
  } catch (err) {
    console.log('Error setting dark mode:', err);
  }
}

function getCreds(nm?: string): ATVCredentials | Record<string, never> {
  const creds = JSON.parse(localStorage.getItem('remote_credentials') || '{}');
  const keys = Object.keys(creds);
  if (keys.length === 0) return {};

  let result = nm !== undefined && keys.includes(nm) ? creds[nm] : creds[keys[0]];
  while (typeof result === 'string') result = JSON.parse(result);
  return result;
}

function setAlwaysOnTop(tf: boolean): void {
  console.log(`setAlwaysOnTop(${tf})`);
  ipcRenderer.invoke('alwaysOnTop', String(tf));
}

let lastMenuEvent: Electron.MenuItem | undefined;

function subMenuClick(event: Electron.MenuItem): void {
  const mode = event.id;
  localStorage.setItem('uimode', mode);
  lastMenuEvent = event;
  event.menu.items.forEach((el: Electron.MenuItem) => {
    el.checked = el.id === mode;
  });
  setTimeout(() => {
    handleDarkMode();
  }, 1);
  console.log(event);
}

function confirmExit(): void {
  remote.app.quit();
}

function changeHotkeyClick(): void {
  ipcRenderer.invoke('loadHotkeyWindow');
}

function handleContextMenu(): void {
  const tray = mb.tray;
  const mode = localStorage.getItem('uimode') || 'systemmode';

  const creds = JSON.parse(localStorage.getItem('remote_credentials') || '{}');
  const ks = Object.keys(creds);
  const atvc = localStorage.getItem('atvcreds');
  const deviceItems: Electron.MenuItemConstructorOptions[] = ks.map(function (k) {
    return {
      type: 'checkbox',
      label: k,
      checked: JSON.stringify(creds[k]) === atvc,
      click: function () {
        localStorage.setItem('atvcreds', JSON.stringify(creds[k]));
        connectToATV();
        handleContextMenu();
      },
    };
  });
  if (deviceItems.length > 0) {
    deviceItems.push({ type: 'separator' });
  }
  deviceItems.push({
    label: 'Pair new device...',
    click: function () {
      mb.showWindow();
      startScan();
    },
  });
  deviceItems.push({
    label: 'Re-pair current device',
    click: function () {
      localStorage.removeItem('atvcreds');
      mb.showWindow();
      startScan();
    },
  });

  const devicesSubMenu = Menu.buildFromTemplate(deviceItems);

  const appearanceSubMenu = Menu.buildFromTemplate([
    {
      type: 'checkbox',
      id: 'systemmode',
      click: subMenuClick,
      label: 'Follow system settings',
      checked: mode === 'systemmode',
    },
    {
      type: 'checkbox',
      id: 'darkmode',
      click: subMenuClick,
      label: 'Dark mode',
      checked: mode === 'darkmode',
    },
    {
      type: 'checkbox',
      id: 'lightmode',
      click: subMenuClick,
      label: 'Light mode',
      checked: mode === 'lightmode',
    },
  ]);

  const topChecked = JSON.parse(localStorage.getItem('alwaysOnTopChecked') || 'false');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Devices', submenu: devicesSubMenu },
    {
      type: 'checkbox',
      label: 'Always on-top',
      click: toggleAlwaysOnTop,
      checked: topChecked,
    },
    { type: 'separator' },
    { label: 'Appearance', submenu: appearanceSubMenu, click: subMenuClick },
    { label: 'Change hotkey', click: changeHotkeyClick },
    { type: 'separator' },
    { role: 'about', label: 'About' },
    { label: 'Quit', click: confirmExit, accelerator: 'CommandOrControl+Q' },
  ]);
  tray.removeAllListeners('right-click');
  tray.on('right-click', () => {
    mb.tray.popUpContextMenu(contextMenu);
  });
}

function toggleAlwaysOnTop(event: Electron.MenuItem): void {
  localStorage.setItem('alwaysOnTopChecked', String(event.checked));
  ipcRenderer.invoke('alwaysOnTop', String(event.checked));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let initRetryCount = 0;
const MAX_INIT_RETRIES = 10;

export async function init(): Promise<void> {
  if (!initializeRemote()) {
    initRetryCount++;
    if (initRetryCount >= MAX_INIT_RETRIES) {
      console.error('Failed to initialize remote after ' + MAX_INIT_RETRIES + ' attempts');
      setStatus('Failed to initialize. Please restart the app.');
      return;
    }
    console.log(
      'Remote not ready, retrying in 100ms... (' + initRetryCount + '/' + MAX_INIT_RETRIES + ')',
    );
    await delay(100);
    return await init();
  }
  initRetryCount = 0;
  addThemeListener();
  handleDarkMode();
  handleContextMenu();
  $('#cancelPairing')!.addEventListener('click', () => {
    console.log('cancelling');
    window.location.reload();
  });

  const checked = JSON.parse(localStorage.getItem('alwaysOnTopChecked') || 'false');
  if (checked) setAlwaysOnTop(checked);

  let creds: ATVCredentials | false;
  try {
    creds = JSON.parse(localStorage.getItem('atvcreds') || 'false');
  } catch {
    creds = getCreds();
    if (creds) localStorage.setItem('atvcreds', JSON.stringify(creds));
  }
  if (localStorage.getItem('firstRun') !== 'false') {
    localStorage.setItem('firstRun', 'false');
    mb.showWindow();
  }

  console.log('init: creds=', JSON.stringify(creds));
  if (creds && creds.credentials && creds.identifier) {
    setAtvCredentials(creds);
    connectToATV();
  } else {
    console.log('init: no valid creds, starting scan');
    startScan();
  }
}

function themeUpdated(): void {
  console.log('theme style updated');
  handleDarkMode();
}

let tryThemeAddCount = 0;

function addThemeListener(): void {
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
