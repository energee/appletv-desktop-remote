import type {
  ATVCredentials,
  ATVKeyName,
  KeyboardKeyMap,
  ConnectionDotState,
  NowPlayingInfo,
} from '../shared/types';
import {
  $,
  $$,
  atv_connected,
  atv_credentials,
  atv_events,
  connecting,
  safeParse,
  setAtvConnected,
  setAtvCredentials,
  setConnecting,
} from './state';
import {
  sendKey,
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

export function initIPC(): void {
  window.electronAPI.onShortcutWin(() => {
    handleDarkMode();
    toggleAltText(true);
  });

  window.electronAPI.onPowerResume(() => {
    connectToATV();
  });

  window.electronAPI.onSendCommand((key: string) => {
    sendCommand(key);
  });

  window.electronAPI.onErrorMessage((msg: string) => {
    setStatus(msg);
  });

  window.electronAPI.onContextMenuAction((action: string, payload?: string) => {
    handleContextMenuAction(action, payload);
  });

  atv_events.on('connected', function (connected: boolean) {
    if (connected) {
      updateConnectionDot('connected');
      setStatus('');
      $('#statusText')!.style.display = 'none';
    } else {
      updateConnectionDot('connecting');
      setStatus('Reconnecting...');
      hideNowPlaying();
    }
  });
  atv_events.on('connection_failure', function () {
    updateConnectionDot('disconnected');
  });
  atv_events.on('reconnect_failed', function () {
    updateConnectionDot('disconnected');
    setStatus('Connection lost. Right-click to reconnect.');
  });
  atv_events.on('now-playing', function (info: NowPlayingInfo) {
    updateNowPlaying(info);
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
  if (mods.length === 1 && mods[0] === 'Shift') {
    mods = [];
  }
  if (mods.length > 0) return;

  if (key === 'q') {
    qPresses++;
    if (qPresses === 3) window.electronAPI.quit();
  } else {
    qPresses = 0;
  }
  if (key === 'h') {
    window.electronAPI.hideWindow();
  }
  if (!atv_connected) {
    if (document.activeElement === $('#pairCode') && key === 'Enter') {
      submitCode();
    }
    return;
  }
  if ($('#cancelPairing')!.style.display !== 'none') return;
  if (keymap[key] !== undefined) {
    sendCommand(key);
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

const keyElCache = new Map<string, Element>();
function getKeyEl(key: string): Element | undefined {
  let el = keyElCache.get(key);
  if (!el || !el.isConnected) {
    const found = $(`[data-key="${key}"]`);
    if (found) {
      keyElCache.set(key, found);
      el = found;
    } else {
      keyElCache.delete(key);
      return undefined;
    }
  }
  return el;
}

export async function sendCommand(k: string): Promise<void> {
  if (k === 'Pause') k = 'Space';
  let rcmd = keymap[k];
  if ((Object.values(keymap) as string[]).includes(k)) rcmd = k as ATVKeyName;
  const el = getKeyEl(rcmd);
  if (el) {
    el.classList.add('invert');
    setTimeout(() => {
      el.classList.remove('invert');
    }, 500);
  }
  try {
    await sendKey(rcmd);
  } catch {
    if (el) {
      el.classList.remove('invert');
      el.classList.add('error-flash');
      setTimeout(() => el.classList.remove('error-flash'), 600);
    }
  }
}

let pairButtonBound = false;

function startPairing(dev: string): void {
  setAtvConnected(false);
  $('#initText')!.style.display = 'none';
  $('#results')!.style.display = 'none';
  if (!pairButtonBound) {
    pairButtonBound = true;
    $('#pairButton')!.addEventListener('click', () => {
      submitCode();
      return false;
    });
  }
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

let buttonAbort: AbortController | null = null;

function showKeyMap(): void {
  if (buttonAbort) buttonAbort.abort();
  buttonAbort = new AbortController();
  const { signal } = buttonAbort;

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
        flashArrow(direction);
        sendCommand(direction);

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
      sendCommand('select');
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
      sendCommand('select');
    }
    clickStart = null;
  });

  // --- Media / secondary button long-press handlers ---
  const longPressTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const isLongPressing: Record<string, boolean> = {};

  const dataKeyEls = $$('[data-key]');

  dataKeyEls.forEach(function (button) {
    button.addEventListener(
      'mousedown',
      function () {
        const key = (button as HTMLElement).dataset.key!;

        if (longPressTimers[key]) {
          clearTimeout(longPressTimers[key]);
        }

        isLongPressing[key] = true;
        button.classList.add('pressing');

        longPressTimers[key] = setTimeout(() => {
          if (!isLongPressing[key]) return;

          button.classList.add('longpress-triggered');

          sendCommand(key);

          isLongPressing[key] = false;

          setTimeout(() => {
            button.classList.remove('pressing', 'longpress-triggered');
          }, 200);
        }, 1000);
      },
      { signal },
    );

    function handleMouseUpLeave(e: Event): void {
      const key = (button as HTMLElement).dataset.key!;

      if (isLongPressing[key]) {
        if (longPressTimers[key]) {
          clearTimeout(longPressTimers[key]);
          delete longPressTimers[key];
        }

        isLongPressing[key] = false;
        button.classList.remove('pressing');

        if (e.type === 'mouseup') {
          sendCommand(key);
        }
      }
    }

    button.addEventListener('mouseup', handleMouseUpLeave, { signal });
    button.addEventListener('mouseleave', handleMouseUpLeave, { signal });
  });

  showKeyboardHint();
}

function getActiveIdentifier(): string | null {
  const active = safeParse<ATVCredentials | false>(localStorage.getItem('atvcreds'), false);
  return active ? active.identifier : null;
}

function getConnectedDeviceName(): string | null {
  const activeId = getActiveIdentifier();
  if (!activeId) return null;
  const creds = safeParse(
    localStorage.getItem('remote_credentials'),
    {} as Record<string, unknown>,
  );
  const match = Object.entries(creds).find(([, val]) => {
    const v = val as ATVCredentials;
    return v && v.identifier === activeId;
  });
  if (!match) return null;
  return match[0].replace(/\s*\([\d.]+\)$/, '');
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
  setAtvCredentials(safeParse(localStorage.getItem('atvcreds'), false as const));

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

async function handleDarkMode(): Promise<void> {
  try {
    const uimode = localStorage.getItem('uimode') || 'systemmode';
    const alwaysUseDarkMode = uimode === 'darkmode';
    const neverUseDarkMode = uimode === 'lightmode';

    const systemDark = await window.electronAPI.getTheme();
    const darkModeEnabled = (systemDark || alwaysUseDarkMode) && !neverUseDarkMode;
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
  const creds = safeParse(
    localStorage.getItem('remote_credentials'),
    {} as Record<string, unknown>,
  );
  const keys = Object.keys(creds);
  if (keys.length === 0) return {};

  let result = nm !== undefined && keys.includes(nm) ? creds[nm] : creds[keys[0]];
  while (typeof result === 'string') result = JSON.parse(result);
  return result;
}

function setAlwaysOnTop(tf: boolean): void {
  window.electronAPI.setAlwaysOnTop(String(tf));
}

// --- Now Playing ---

function updateNowPlaying(info: NowPlayingInfo): void {
  const container = $('#nowPlaying');
  if (!container) return;

  const title = info.title || '';
  const artist = info.artist || '';

  if (!title && !artist) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  $('#npTitle')!.textContent = title;
  $('#npArtist')!.textContent = artist;
}

function hideNowPlaying(): void {
  const container = $('#nowPlaying');
  if (container) container.style.display = 'none';
}

// --- Settings Panel ---

function showSettings(): void {
  $('#runningElements')!.style.display = 'none';
  $('#addNewElements')!.style.display = 'none';
  const panel = $('#settingsPanel')!;
  panel.style.display = 'block';

  // Populate theme radios
  const currentTheme = localStorage.getItem('uimode') || 'systemmode';
  const radios = panel.querySelectorAll<HTMLInputElement>('input[name="theme"]');
  radios.forEach((r) => {
    r.checked = r.value === currentTheme;
  });

  // Populate always-on-top
  const topChecked = safeParse(localStorage.getItem('alwaysOnTopChecked'), false);
  ($('#settingsAlwaysOnTop') as HTMLInputElement).checked = topChecked;

  // Populate device list
  populateDeviceList();
}

function hideSettings(): void {
  $('#settingsPanel')!.style.display = 'none';
  if (atv_connected) {
    $('#runningElements')!.style.display = '';
  } else {
    $('#addNewElements')!.style.display = '';
  }
}

function populateDeviceList(): void {
  const listEl = $('#settingsDeviceList')!;
  listEl.innerHTML = '';
  const creds = safeParse(
    localStorage.getItem('remote_credentials'),
    {} as Record<string, unknown>,
  );
  const activeId = getActiveIdentifier();

  for (const name of Object.keys(creds)) {
    const row = document.createElement('div');
    row.className = 'settings-device-row';
    const label = document.createElement('span');
    const v = creds[name] as ATVCredentials;
    const isActive = !!(v && activeId && v.identifier === activeId);
    label.textContent = name + (isActive ? ' (active)' : '');
    label.className = 'settings-device-name';
    row.appendChild(label);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'settings-device-remove';
    removeBtn.addEventListener('click', () => {
      const allCreds = safeParse(
        localStorage.getItem('remote_credentials'),
        {} as Record<string, unknown>,
      );
      delete allCreds[name];
      localStorage.setItem('remote_credentials', JSON.stringify(allCreds));
      if (isActive) localStorage.removeItem('atvcreds');
      window.electronAPI.removeDevice(name);
      populateDeviceList();
    });
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  }

  if (Object.keys(creds).length === 0) {
    const empty = document.createElement('div');
    empty.className = 'settings-empty';
    empty.textContent = 'No saved devices';
    listEl.appendChild(empty);
  }
}

function initSettingsListeners(): void {
  // Theme radios
  const radios = document.querySelectorAll<HTMLInputElement>('#themeRadios input[name="theme"]');
  radios.forEach((r) => {
    r.addEventListener('change', () => {
      localStorage.setItem('uimode', r.value);
      handleDarkMode();
    });
  });

  // Always on top
  $('#settingsAlwaysOnTop')!.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    localStorage.setItem('alwaysOnTopChecked', String(checked));
    setAlwaysOnTop(checked);
  });

  // Hotkey button
  $('#settingsHotkeyBtn')!.addEventListener('click', () => {
    window.electronAPI.loadHotkeyWindow();
  });

  // Back button
  $('#settingsBackBtn')!.addEventListener('click', () => {
    hideSettings();
  });
}

// --- Context Menu ---

function handleContextMenu(): void {
  const creds = safeParse(
    localStorage.getItem('remote_credentials'),
    {} as Record<string, unknown>,
  );
  const ks = Object.keys(creds);
  const activeId = getActiveIdentifier();
  const mode = localStorage.getItem('uimode') || 'systemmode';
  const topChecked = safeParse(localStorage.getItem('alwaysOnTopChecked'), false);

  const devices = ks.map((k) => {
    const v = creds[k] as ATVCredentials;
    return {
      label: k,
      identifier: v ? v.identifier : '',
      checked: !!(v && activeId && v.identifier === activeId),
    };
  });

  window.electronAPI.showContextMenu({
    devices,
    uiMode: mode,
    alwaysOnTop: topChecked,
  });
}

function handleContextMenuAction(action: string, payload?: string): void {
  switch (action) {
    case 'selectDevice': {
      const creds = safeParse(
        localStorage.getItem('remote_credentials'),
        {} as Record<string, unknown>,
      );
      if (payload && creds[payload]) {
        localStorage.setItem('atvcreds', JSON.stringify(creds[payload]));
        connectToATV();
        handleContextMenu();
      }
      break;
    }
    case 'pairNew':
      startScan();
      break;
    case 'repairCurrent':
      localStorage.removeItem('atvcreds');
      startScan();
      break;
    case 'setTheme':
      if (payload) {
        localStorage.setItem('uimode', payload);
        handleDarkMode();
        handleContextMenu();
      }
      break;
    case 'toggleAlwaysOnTop':
      if (payload !== undefined) {
        localStorage.setItem('alwaysOnTopChecked', payload);
        window.electronAPI.setAlwaysOnTop(payload);
        handleContextMenu();
      }
      break;
    case 'openSettings':
      window.electronAPI.showWindow();
      showSettings();
      break;
  }
}

export async function init(): Promise<void> {
  // Theme listener
  window.electronAPI.onThemeUpdated(() => {
    handleDarkMode();
  });

  await handleDarkMode();
  handleContextMenu();
  initSettingsListeners();

  $('#cancelPairing')!.addEventListener('click', () => {
    window.location.reload();
  });

  const checked = safeParse(localStorage.getItem('alwaysOnTopChecked'), false);
  if (checked) setAlwaysOnTop(checked);

  let creds: ATVCredentials | false = safeParse(localStorage.getItem('atvcreds'), false as const);
  if (!creds) {
    const fallback = getCreds();
    if (fallback && 'credentials' in fallback) {
      creds = fallback as ATVCredentials;
      localStorage.setItem('atvcreds', JSON.stringify(creds));
    }
  }
  if (localStorage.getItem('firstRun') !== 'false') {
    localStorage.setItem('firstRun', 'false');
    window.electronAPI.showWindow();
  }

  if (creds && creds.credentials && creds.identifier) {
    setAtvCredentials(creds);
    connectToATV();
  } else {
    startScan();
  }
}
