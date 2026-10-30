// The remote window's UI. It renders the sidecar's connection state (which screen, status
// text, connection dot) and forwards user actions; the sidecar owns connecting, reconnecting,
// and pairing mode.
import {
  PlaybackState,
  type ATVCredentials,
  type ATVKeyName,
  type KeyboardKeyMap,
  type ConnectionDotState,
  type ConnectionState,
  type NowPlayingInfo,
} from '../shared/types';
import { desktopAPI } from '../shared/desktop-api';
import { icon } from './icons';
import { $, $$, safeParse } from './state';
import { scanDevices, startPair, finishPair } from './atv_remote';

let qPresses = 0;
/** The sidecar's latest connection state. */
let connection: ConnectionState = { status: 'idle' };

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

/** Keys that repeat while held down; any other key acts once per press. */
const REPEATING_KEYS: readonly ATVKeyName[] = [
  'up',
  'down',
  'left',
  'right',
  'volume_up',
  'volume_down',
];

export function initIPC(): void {
  desktopAPI.onShortcutWin(() => {
    void handleDarkMode();
    toggleAltText(true);
  });
  // After sleep the old socket is usually dead but not yet closed; a relaunched sidecar has no
  // connection at all. Either way the sidecar starts a fresh one unless pairing is under way.
  desktopAPI.onPowerResume(reconnectToATV);
  desktopAPI.onBackendLost(reconnectToATV);
  // While connected an error is only logged: if the connection drops, Reconnecting says so,
  // and if it survives, the message would sit on the remote with nothing wrong.
  desktopAPI.onErrorMessage((msg: string) => {
    if (connection.status === 'connected') console.error(msg);
    else setStatus(msg);
  });
  desktopAPI.onContextMenuAction((action: string, payload?: string) => {
    handleContextMenuAction(action, payload);
  });

  desktopAPI.onAtvState(renderState);
  desktopAPI.onAtvNowPlaying(updateNowPlaying);
}

/** Shows the sidecar's connection state: the screen, the connection dot, and status text. */
function renderState(next: ConnectionState): void {
  const previous = connection.status;
  connection = next;
  showScreen();
  if (next.status !== 'connected') hideNowPlaying();
  switch (next.status) {
    case 'connected':
      updateConnectionDot('connected');
      $('#statusText')!.style.display = 'none';
      handleContextMenu();
      showKeyMap();
      break;
    case 'connecting':
      updateConnectionDot('connecting');
      // Retries report 'connecting' again; keep the text from the start of the attempt.
      if (previous !== 'connecting') {
        setStatus(previous === 'connected' ? 'Reconnecting...' : 'Connecting to ATV...');
      }
      break;
    case 'disconnected':
      $('#initText')!.style.display = 'none';
      updateConnectionDot('disconnected');
      setStatus('Connection lost. Right-click to reconnect.');
      break;
    default:
      // idle, or pairing, whose screen shows its own status.
      updateConnectionDot('disconnected');
  }
}

/** Shows the pairing screen while pairing and the remote otherwise, behind Settings if open. */
function showScreen(): void {
  if (settingsOpen()) return;
  const pairing = connection.status === 'pairing';
  $('#addNewElements')!.style.display = pairing ? '' : 'none';
  $('#runningElements')!.style.display = pairing ? 'none' : '';
}

window.addEventListener('blur', () => {
  toggleAltText(true);
});

// The sidecar retries every 30 s after giving up; showing the window retries at once. Only then:
// reconnecting replaces the connection, so it must not touch one that works.
window.addEventListener('focus', () => {
  if (connection.status === 'disconnected') reconnectToATV();
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
  // Holding Space must not toggle play/pause over and over, nor holding Q quit the app.
  if (e.repeat && !REPEATING_KEYS.includes(keymap[key])) return;

  if (key === 'q') {
    qPresses++;
    if (qPresses === 3) void desktopAPI.quit();
  } else {
    qPresses = 0;
  }
  if (key === 'h') {
    void desktopAPI.hideWindow();
  }
  // Keys go to the TV only while connected; while pairing, the PIN boxes take the typing.
  if (connection.status !== 'connected') return;
  if (keymap[key] !== undefined) {
    sendCommand(key);
    e.preventDefault();
  }
});

export function createDropdown(ks: string[]): void {
  $('#loader')!.style.display = 'none';
  $('#statusText')!.style.display = 'none';
  $('#pairingLoader')!.innerHTML = '';
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

/** Sends a key by name or keyboard key; `hold` holds it, for a long press. */
export async function sendCommand(k: string, hold = false): Promise<void> {
  if (k === 'Pause') k = 'Space';
  let rcmd = keymap[k];
  if ((Object.values(keymap) as string[]).includes(k)) rcmd = k as ATVKeyName;
  const el = getKeyEl(rcmd);
  if (el) {
    el.classList.add('sent');
    setTimeout(() => {
      el.classList.remove('sent');
    }, 500);
  }
  if (rcmd === 'play_pause') flipPlayPauseIcon();
  try {
    await desktopAPI.sendKey(rcmd, hold);
  } catch {
    if (el) {
      el.classList.remove('sent');
      el.classList.add('error-flash');
      setTimeout(() => el.classList.remove('error-flash'), 600);
    }
  }
}

/** Shows the empty PIN boxes, ready to type in, and asks the TV for a PIN. */
function startPairing(dev: string): void {
  $('#initText')!.style.display = 'none';
  $('#results')!.style.display = 'none';
  $('#pairCodeElements')!.style.display = 'block';
  clearPin();
  startPair(dev);
}

/** Empties the PIN boxes and puts the cursor in the first. */
function clearPin(): void {
  const input = $('#pairCode') as HTMLInputElement;
  input.value = '';
  input.disabled = false;
  input.focus();
  renderPin();
}

/**
 * The PIN is typed into one transparent input laid over four boxes (as input-otp does), so
 * paste and autofill work. Shows its digits in the boxes and rings the box the next one fills.
 */
function renderPin(): void {
  const input = $('#pairCode') as HTMLInputElement;
  const typing = !input.disabled && document.activeElement === input;
  const next = typing ? Math.min(input.value.length, 3) : -1;
  $$('.pin-slot').forEach((slot, i) => {
    slot.textContent = input.value[i] ?? '';
    slot.classList.toggle('active', i === next);
  });
}

/** Sends the PIN once all four digits are in, locking the boxes while the TV checks it. */
async function submitCode(): Promise<void> {
  const input = $('#pairCode') as HTMLInputElement;
  if (!/^\d{4}$/.test(input.value)) return;
  input.disabled = true;
  renderPin();
  await finishPair(input.value);
  clearPin();
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
  // The keyboard hint is for the first connection after launch, not reconnects after a wake.
  const firstConnection = !buttonAbort;
  if (buttonAbort) buttonAbort.abort();
  buttonAbort = new AbortController();
  const { signal } = buttonAbort;

  $('#initText')!.style.display = 'none';
  const touchpad = document.getElementById('touchpad')!;
  touchpad.style.display = 'flex';
  touchpad.classList.add('fade-in');

  // --- Touchpad gesture detection ---
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
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
  // One move per gesture: a trackpad keeps sending events (momentum) after the fingers lift,
  // so after a move the rest of the gesture is ignored. It ends when macOS reports fingers
  // starting a new gesture or, for mouse wheels and other platforms, when events stop.
  let scrollAccX = 0;
  let scrollAccY = 0;
  let gestureMoved = false;
  let gestureEndTimer: ReturnType<typeof setTimeout> | undefined;
  const SCROLL_THRESHOLD = 90;
  /** Quiet time that ends a gesture; events arrive about every 16 ms until momentum stops. */
  const GESTURE_END_MS = 150;

  function endGesture(): void {
    clearTimeout(gestureEndTimer);
    scrollAccX = 0;
    scrollAccY = 0;
    gestureMoved = false;
  }
  const stopGestureListener = desktopAPI.onScrollGestureBegan(endGesture);
  signal.addEventListener('abort', stopGestureListener);

  touchpad.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();

      clearTimeout(gestureEndTimer);
      gestureEndTimer = setTimeout(endGesture, GESTURE_END_MS);
      if (gestureMoved) return;

      scrollAccX += e.deltaX;
      scrollAccY += e.deltaY;

      if (Math.abs(scrollAccX) >= SCROLL_THRESHOLD || Math.abs(scrollAccY) >= SCROLL_THRESHOLD) {
        let direction: string;
        if (Math.abs(scrollAccX) > Math.abs(scrollAccY)) {
          direction = scrollAccX > 0 ? 'left' : 'right';
        } else {
          direction = scrollAccY > 0 ? 'up' : 'down';
        }
        flashArrow(direction);
        void sendCommand(direction);
        gestureMoved = true;
      }
    },
    { passive: false, signal },
  );

  // --- Tap (click) and long-press ---
  let clickStart: { x: number; y: number; t: number } | null = null;

  // Only the primary button presses. A right-click opens the context menu, which takes the
  // mouseup, so a long-press timer it started would fire and press the key.
  touchpad.addEventListener(
    'mousedown',
    function (e) {
      if (e.button !== 0) return;
      clickStart = { x: e.clientX, y: e.clientY, t: Date.now() };
      longPressTimer = setTimeout(function () {
        sendCommand('select', true);
        clickStart = null;
      }, 1000);
    },
    { signal },
  );

  touchpad.addEventListener(
    'mouseup',
    function (e) {
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
    },
    { signal },
  );

  // Dragging off the touchpad abandons the press, so its long-press never selects.
  touchpad.addEventListener(
    'mouseleave',
    function () {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      clickStart = null;
    },
    { signal },
  );

  // --- Media / secondary button long-press handlers ---
  const longPressTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const isLongPressing: Record<string, boolean> = {};

  const dataKeyEls = $$('[data-key]');

  dataKeyEls.forEach(function (button) {
    button.addEventListener(
      'mousedown',
      function (e) {
        if (e.button !== 0) return;
        const key = (button as HTMLElement).dataset.key!;

        if (longPressTimers[key]) {
          clearTimeout(longPressTimers[key]);
        }

        isLongPressing[key] = true;
        button.classList.add('pressing');

        longPressTimers[key] = setTimeout(() => {
          if (!isLongPressing[key]) return;

          button.classList.add('longpress-triggered');

          sendCommand(key, true);

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

  if (firstConnection) showKeyboardHint();
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
  header.firstChild!.textContent = (showName && getConnectedDeviceName()) || 'Apple TV Remote';
}

/**
 * Asks the sidecar to connect to the saved device (`atvcreds`), replacing any connection,
 * connect, or pairing in progress. Progress arrives as `state` events.
 */
export function connectToATV(): void {
  const creds = safeParse<ATVCredentials | null>(localStorage.getItem('atvcreds'), null);
  if (creds) desktopAPI.connect(creds).catch(showRequestError);
}

/** Like connectToATV, but the sidecar ignores it while pairing. */
function reconnectToATV(): void {
  const creds = safeParse<ATVCredentials | null>(localStorage.getItem('atvcreds'), null);
  if (creds) desktopAPI.reconnect(creds).catch(showRequestError);
}

function showRequestError(err: unknown): void {
  setStatus(err instanceof Error ? err.message : 'Unable to reach the Apple TV backend.');
}

export function setStatus(txt: string): void {
  const el = $('#statusText')!;
  el.textContent = txt;
  el.style.display = 'block';
}

/**
 * Scans for Apple TVs to pair. The scan puts the sidecar in pairing mode, and that state
 * shows this screen.
 */
export function startScan(): void {
  $('#initText')!.style.display = 'none';
  const loader = $('#loader')!;
  loader.style.display = 'block';
  loader.classList.add('fade-in');
  $('#topTextKBLink')!.style.display = 'none';
  // Start from the device picker, even after an earlier pairing in this window.
  $('#pairingElements')!.style.display = 'none';
  $('#results')!.style.display = '';
  $('#pairCodeElements')!.style.display = 'none';
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

    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const darkModeEnabled = (systemDark || alwaysUseDarkMode) && !neverUseDarkMode;
    if (darkModeEnabled) {
      document.body.classList.add('darkMode');
    } else {
      document.body.classList.remove('darkMode');
    }
    // The macOS glass follows the window's appearance, not the page, so an explicit choice pins
    // the window too. "Follow system" hands it back to the system: a pinned window would also
    // pin prefers-color-scheme above, and the remote would stop following the system.
    let windowTheme: 'light' | 'dark' | null = null;
    if (alwaysUseDarkMode) windowTheme = 'dark';
    else if (neverUseDarkMode) windowTheme = 'light';
    await desktopAPI.setWindowTheme(windowTheme);
  } catch (err) {
    console.log('Error setting dark mode:', err);
  }
}

function getCreds(nm?: string): ATVCredentials | Record<string, never> {
  // Older releases stored some entries as (repeatedly) JSON-encoded strings.
  const creds = safeParse(
    localStorage.getItem('remote_credentials'),
    {} as Record<string, ATVCredentials | string>,
  );
  const keys = Object.keys(creds);
  if (keys.length === 0) return {};

  let result = nm !== undefined && keys.includes(nm) ? creds[nm] : creds[keys[0]];
  while (typeof result === 'string') result = JSON.parse(result);
  return result;
}

function setAlwaysOnTop(tf: boolean): void {
  void desktopAPI.setAlwaysOnTop(tf);
}

// The webview cannot download blobs, so the host writes the file from a native save dialog.
async function exportCredentials(): Promise<void> {
  const backup = {
    version: 1,
    atvcreds: localStorage.getItem('atvcreds'),
    remote_credentials: localStorage.getItem('remote_credentials'),
    uimode: localStorage.getItem('uimode'),
    alwaysOnTopChecked: localStorage.getItem('alwaysOnTopChecked'),
  };
  if (await desktopAPI.exportCredentials(JSON.stringify(backup, null, 2))) {
    setStatus('Credentials exported.');
  }
}

function isStoredValue(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

// Picked from a native dialog, like the export, so the window stays up to show the result.
async function importCredentials(): Promise<void> {
  const contents = await desktopAPI.importCredentials();
  if (contents === null) return;
  const parsed: unknown = JSON.parse(contents);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('atvcreds' in parsed) ||
    !('remote_credentials' in parsed) ||
    !isStoredValue(parsed.atvcreds) ||
    !isStoredValue(parsed.remote_credentials) ||
    ('uimode' in parsed && !isStoredValue(parsed.uimode)) ||
    ('alwaysOnTopChecked' in parsed && !isStoredValue(parsed.alwaysOnTopChecked))
  ) {
    throw new Error('This is not an Apple TV Remote credential export.');
  }
  // Validate the complete backup before changing any existing saved state.
  function storedObject(value: string): Record<string, unknown> {
    let decoded: unknown = JSON.parse(value);
    while (typeof decoded === 'string') decoded = JSON.parse(decoded);
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('Credential data must contain an object.');
    }
    return decoded as Record<string, unknown>;
  }
  function validateCredential(value: unknown): void {
    const credential = typeof value === 'string' ? storedObject(value) : value;
    if (
      typeof credential !== 'object' ||
      credential === null ||
      !('credentials' in credential) ||
      typeof credential.credentials !== 'string' ||
      credential.credentials.length === 0 ||
      !('identifier' in credential) ||
      typeof credential.identifier !== 'string' ||
      credential.identifier.length === 0
    ) {
      throw new Error('Each saved device must contain credentials and an identifier.');
    }
  }
  if (parsed.atvcreds !== null) validateCredential(storedObject(parsed.atvcreds));
  if (parsed.remote_credentials !== null) {
    Object.values(storedObject(parsed.remote_credentials)).forEach(validateCredential);
  }
  if (
    'uimode' in parsed &&
    parsed.uimode !== null &&
    !['systemmode', 'darkmode', 'lightmode'].includes(parsed.uimode as string)
  ) {
    throw new Error('Invalid appearance setting in credential export.');
  }
  if (
    'alwaysOnTopChecked' in parsed &&
    parsed.alwaysOnTopChecked !== null &&
    !['true', 'false'].includes(parsed.alwaysOnTopChecked as string)
  ) {
    throw new Error('Invalid always-on-top setting in credential export.');
  }
  for (const key of ['atvcreds', 'remote_credentials', 'uimode', 'alwaysOnTopChecked'] as const) {
    // Validated above: each key is absent, null, or a string.
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string') localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }
  await handleDarkMode();
  setAlwaysOnTop(safeParse(localStorage.getItem('alwaysOnTopChecked'), false));
  refreshSettings();
  handleContextMenu();
  // connect replaces the old connection; without an active device, just drop it.
  if (localStorage.getItem('atvcreds')) {
    setStatus('Credentials imported. Reconnecting...');
    connectToATV();
  } else {
    setStatus('Credentials imported.');
    await desktopAPI.disconnect();
  }
}

// --- Now Playing ---

/** How long a press's icon flip outlasts reports that disagree with it. */
const FLIP_HOLD_MS = 3000;
/** What the play button shows, what the TV last reported, and the pending flip's timer. */
let iconPlaying = false;
let reportedPlaying = false;
let flipTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Flips the play button as the key is sent. After a press the TV repeats its old state for a
 * moment (Plex reports a change up to seconds late), so until a report agrees or the hold ends,
 * reports do not move the icon; then it shows the last reported state.
 */
function flipPlayPauseIcon(): void {
  showPlayPauseIcon(!iconPlaying);
  clearTimeout(flipTimer);
  flipTimer = setTimeout(() => {
    flipTimer = undefined;
    showPlayPauseIcon(reportedPlaying);
  }, FLIP_HOLD_MS);
}

function cancelFlip(): void {
  clearTimeout(flipTimer);
  flipTimer = undefined;
}

/** Seconds from the Unix epoch to 2001-01-01, the epoch of the TV's MRP timestamps. */
const MRP_EPOCH_OFFSET = 978307200;
/** The playing item: `elapsed` seconds in at `at` (ms since the Unix epoch), moving at `rate`. */
const NO_POSITION = { duration: 0, elapsed: 0, at: 0, rate: 0 };
let position = NO_POSITION;
/** True while the seek bar is being dragged, so the clock does not move it. */
let dragging = false;

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Moves the bar's thumb, its played fill (the first background layer), and the elapsed time. */
function setSeekBar(bar: HTMLInputElement, seconds: number): void {
  bar.value = String(Math.round(seconds));
  const played = ((seconds / position.duration) * 100).toFixed(1);
  bar.style.backgroundSize = `${played}% 100%, 100% 100%`;
  $('#npElapsed')!.textContent = formatTime(seconds);
}

/** Shows the bar at the current position, or hides it when the item has no length. */
function renderSeekBar(): void {
  const seek = $('#seek');
  if (!seek) return;
  seek.style.display = position.duration > 0 ? '' : 'none';
  if (position.duration <= 0 || dragging) return;
  const now = position.elapsed + (position.rate * (Date.now() - position.at)) / 1000;
  const seconds = Math.min(position.duration, Math.max(0, now));
  const bar = $('#seekBar') as HTMLInputElement;
  bar.max = String(Math.round(position.duration));
  setSeekBar(bar, seconds);
  $('#npDuration')!.textContent = formatTime(position.duration);
}

function initSeekBar(): void {
  const bar = $('#seekBar') as HTMLInputElement;
  bar.addEventListener('input', () => {
    dragging = true;
    setSeekBar(bar, Number(bar.value));
  });
  bar.addEventListener('change', () => {
    dragging = false;
    const seconds = Number(bar.value);
    position = { ...position, elapsed: seconds, at: Date.now() };
    void desktopAPI.seek(seconds).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  });
  // The TV reports the position only when it changes, so while playing the clock advances it.
  setInterval(() => {
    if (position.rate) renderSeekBar();
  }, 1000);
}

/**
 * Shows the app, title, artist, and position, and a pause icon on the play button while playing.
 */
function updateNowPlaying(info: NowPlayingInfo): void {
  reportedPlaying = info.playbackState === PlaybackState.Playing;
  position = {
    duration: info.duration ?? 0,
    elapsed: info.elapsedTime ?? 0,
    at: info.timestamp ? (info.timestamp + MRP_EPOCH_OFFSET) * 1000 : Date.now(),
    // The TV can report rate 1 for a moment after pausing; only a playing item moves.
    rate: reportedPlaying ? (info.playbackRate ?? 1) : 0,
  };
  renderSeekBar();
  if (reportedPlaying === iconPlaying) cancelFlip();
  if (!flipTimer) showPlayPauseIcon(reportedPlaying);
  const container = $('#nowPlaying');
  if (!container) return;

  const title = info.title || '';
  const artist = info.artist || '';

  if (!title && !artist) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  $('#npApp')!.textContent = info.appDisplayName || '';
  $('#npTitle')!.textContent = title;
  $('#npArtist')!.textContent = artist;
}

/** Not connected: hides the title and artist, and the play button shows play. */
function hideNowPlaying(): void {
  position = NO_POSITION;
  renderSeekBar();
  cancelFlip();
  reportedPlaying = false;
  showPlayPauseIcon(false);
  const container = $('#nowPlaying');
  if (container) container.style.display = 'none';
}

function showPlayPauseIcon(playing: boolean): void {
  iconPlaying = playing;
  const el = $('#playPauseIcon');
  if (el) el.innerHTML = icon(playing ? 'pause' : 'play');
}

// --- Settings Panel ---

function showSettings(): void {
  $('#runningElements')!.style.display = 'none';
  $('#addNewElements')!.style.display = 'none';
  $('#settingsPanel')!.style.display = 'block';
  refreshSettings();
}

/** Shows the stored theme, always-on-top choice, and saved devices in the settings panel. */
function refreshSettings(): void {
  const currentTheme = localStorage.getItem('uimode') || 'systemmode';
  const radios = document.querySelectorAll<HTMLInputElement>('#themeRadios input[name="theme"]');
  radios.forEach((r) => {
    r.checked = r.value === currentTheme;
  });

  const topChecked = safeParse(localStorage.getItem('alwaysOnTopChecked'), false);
  ($('#settingsAlwaysOnTop') as HTMLInputElement).checked = topChecked;

  populateDeviceList();
}

// Connection changes (wake, reconnect, import) must not draw the remote or the pairing screen
// over Settings; hideSettings shows whichever is current on the way out.
function settingsOpen(): boolean {
  return $('#settingsPanel')!.style.display === 'block';
}

function hideSettings(): void {
  $('#settingsPanel')!.style.display = 'none';
  showScreen();
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
      if (isActive) {
        localStorage.removeItem('atvcreds');
        void desktopAPI.disconnect();
        setStatus('No device selected. Right-click to choose one.');
      }
      populateDeviceList();
      handleContextMenu();
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
      handleContextMenu();
    });
  });

  // Always on top
  $('#settingsAlwaysOnTop')!.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    localStorage.setItem('alwaysOnTopChecked', String(checked));
    setAlwaysOnTop(checked);
    handleContextMenu();
  });

  // Hotkey button
  $('#settingsHotkeyBtn')!.addEventListener('click', () => {
    void desktopAPI.loadHotkeyWindow();
  });

  $('#settingsExportCredentialsBtn')!.addEventListener('click', () => {
    void exportCredentials().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : 'Unable to export credentials.');
    });
  });
  $('#settingsImportCredentialsBtn')!.addEventListener('click', () => {
    void importCredentials().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : 'Unable to import credentials.');
    });
  });

  // Back button
  $('#settingsBackBtn')!.addEventListener('click', () => {
    hideSettings();
  });
}

// --- Context Menu ---

function handleContextMenu(popup = false): void {
  const creds = safeParse(
    localStorage.getItem('remote_credentials'),
    {} as Record<string, unknown>,
  );
  const ks = Object.keys(creds);
  const activeId = getActiveIdentifier();
  const mode = localStorage.getItem('uimode') || 'systemmode';
  const topChecked = safeParse(localStorage.getItem('alwaysOnTopChecked'), false);

  const devices = ks.map((k) => {
    // Older releases stored some devices as JSON strings, which have no identifier.
    const v = creds[k] as ATVCredentials | null;
    const identifier = typeof v?.identifier === 'string' ? v.identifier : '';
    return { label: k, identifier, checked: !!(activeId && identifier === activeId) };
  });

  void desktopAPI
    .showContextMenu(
      {
        devices,
        uiMode: mode,
        alwaysOnTop: topChecked,
      },
      popup,
    )
    .catch((error: unknown) => setStatus(String(error)));
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
    // Pairing is an explicit navigation, so it leaves Settings (which would stay in front). The
    // active device stays active until a pairing succeeds, so Cancel goes back to it.
    case 'pairNew':
    case 'repairCurrent':
      hideSettings();
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
        void desktopAPI.setAlwaysOnTop(payload === 'true');
        handleContextMenu();
      }
      break;
    case 'openSettings':
      void desktopAPI.showWindow();
      showSettings();
      break;
  }
}

export async function init(): Promise<void> {
  await handleDarkMode();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    void handleDarkMode();
  });
  handleContextMenu();
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    handleContextMenu(true);
  });
  initSettingsListeners();
  initSeekBar();

  // Back to the saved device, or, with none, a fresh scan; connecting ends pairing.
  $('#cancelPairing')!.addEventListener('click', () => {
    if (localStorage.getItem('atvcreds')) connectToATV();
    else startScan();
  });
  const pin = $('#pairCode') as HTMLInputElement;
  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '');
    renderPin();
    void submitCode();
  });
  pin.addEventListener('focus', renderPin);
  pin.addEventListener('blur', renderPin);

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
    void desktopAPI.showWindow();
  }

  if (creds && creds.credentials && creds.identifier) {
    connectToATV();
  } else {
    startScan();
  }
}
