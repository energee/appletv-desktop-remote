// The remote window's UI. It renders the sidecar's connection state (which screen, status
// text, connection dot) and forwards user actions, including the scan and pairing requests; the
// sidecar owns connecting, reconnecting, and pairing mode.
import {
  MRP_EPOCH_OFFSET,
  PlaybackState,
  type ATVKeyName,
  type KeyboardKeyMap,
  type ConnectionDotState,
  type ConnectionState,
  type NowPlayingInfo,
  type Speaker,
  type WatchedTvUpdate,
  type SavedDevice,
} from '../shared/types';
import { desktopAPI, type ContextMenuConfig } from '../shared/desktop-api';
import { icon } from './icons';
import {
  companionKeyboardGuard,
  companionTouchAdapter,
  companionTouchAvailable,
} from './companion';
import {
  $,
  $$,
  loadActiveDevice,
  loadDevices,
  refreshDevices,
  removeDevice,
  safeParse,
  saveActiveDevice,
} from './state';

let qPresses = 0;
/** AirPlay speakers for the menu, scanned once per connection; empty while not connected. */
let speakers: Speaker[] = [];
/** The connected TV reported it is asleep; any other connection state clears it. */
let asleep = false;
/** The scan label of the device being paired; a wrong PIN starts pairing it again. */
let pairDevice = '';
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
  desktopAPI.onBackendLost(recoverFromLostBackend);
  // While connected an error is only logged: if the connection drops, Reconnecting says so,
  // and if it survives, the message would sit on the remote with nothing wrong.
  desktopAPI.onErrorMessage((msg: string) => {
    if (connection.status === 'connected') console.error(msg);
    else setStatus(msg);
  });
  desktopAPI.onContextMenuAction((action: string, payload?: string) => {
    void handleContextMenuAction(action, payload).catch(showRequestError);
  });

  desktopAPI.onAtvState(renderState);
  desktopAPI.onAtvNowPlaying(updateNowPlaying);
  desktopAPI.onAtvArtwork(showArtwork);
  desktopAPI.onWatchedTv(updateWatchedTv);
  desktopAPI.onAtvVolume(showVolume);
  // The TV confirmed a change of outputs: update the checks without scanning again.
  desktopAPI.onAtvOutputs((ids) => {
    speakers = speakers.map((speaker) => ({ ...speaker, selected: ids.includes(speaker.id) }));
    handleContextMenu();
  });
  desktopAPI.onAtvPowerState((power) => {
    asleep = power === 'off';
    if (connection.status === 'connected') updateConnectionDot('connected');
  });
}

/** Shows the sidecar's connection state: the screen, the connection dot, and status text. */
function renderState(next: ConnectionState): void {
  const previous = connection.status;
  connection = next;
  const connected = next.status === 'connected';
  if (!connected) asleep = false;
  // The stylesheet dims the remote and ignores clicks on it unless the page is `connected`.
  document.body.classList.toggle('connected', connected);
  const remoteControls = connected ? '' : 'none';
  $('#powerButton')!.style.display = remoteControls;
  $('#collapseButton')!.style.display = remoteControls;
  if (!connected) {
    cancelPresses();
    showVolume(null);
    if (speakers.length > 0) {
      speakers = [];
      handleContextMenu();
    }
  }
  showScreen();
  if (!connected) hideNowPlaying();
  switch (next.status) {
    case 'connected':
      updateConnectionDot('connected');
      if (previous !== 'connected') void loadSpeakers();
      clearStatus();
      handleContextMenu();
      showKeyMap();
      break;
    case 'connecting':
      updateConnectionDot('connecting');
      // Retries report 'connecting' again; keep the text from the start of the attempt.
      if (previous !== 'connecting') {
        setStatus(previous === 'connected' ? 'Reconnecting…' : 'Connecting…');
      }
      break;
    case 'disconnected':
      updateConnectionDot('disconnected');
      // The sidecar keeps retrying, and showing the window retries at once (see 'focus' below).
      setStatus('Connection lost. Retrying…');
      break;
    default:
      // idle, or pairing, whose screen shows its own status.
      updateConnectionDot('idle');
  }
}

/** Shows the pairing screen while pairing and the remote otherwise, behind Settings if open. */
function showScreen(): void {
  const pairing = connection.status === 'pairing';
  if (pairing) setMini(false);
  if (settingsOpen()) return;
  $('#addNewElements')!.style.display = pairing ? '' : 'none';
  $('#runningElements')!.style.display = pairing ? 'none' : '';
}

window.addEventListener('blur', () => {
  cancelPresses();
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
  if (settingsOpen()) {
    // Esc leaves Settings, unless a dialog over it takes the key.
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) hideSettings();
    return;
  }
  if (companionKeyboardGuard(e)) return;
  // Let focused buttons activate natively instead of sending their activation keys to the TV.
  if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) {
    const command = e.target.dataset.key;
    if (
      e.key === 'Enter' &&
      e.repeat &&
      command &&
      !REPEATING_KEYS.some((repeating) => repeating === command)
    ) {
      e.preventDefault();
    }
    return;
  }
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
  clearStatus();
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
    // The remote works again, so an earlier error or notice no longer applies.
    clearStatus();
  } catch {
    if (el) {
      el.classList.remove('sent');
      el.classList.add('error-flash');
      setTimeout(() => el.classList.remove('error-flash'), 600);
    }
  }
}

export async function scanDevices(): Promise<void> {
  try {
    const results = (await desktopAPI.scan()) || [];
    createDropdown(results);
    if (results.length === 0) {
      setStatus('No Apple TV found on this network. Right-click to scan again.');
    }
  } catch (err) {
    createDropdown([]);
    setStatus(err instanceof Error ? err.message : 'Unable to scan for Apple TVs.');
  }
}

export function startPair(dev: string): void {
  $('#retryPairSave')!.hidden = true;
  pairDevice = dev;
  desktopAPI.startPair(dev).catch((err: unknown) => {
    setStatus(err instanceof Error ? err.message : 'Unable to start pairing.');
  });
}

// The native host stores the pairing keys; the renderer refreshes metadata and selects the TV.
// A session takes one PIN, so a rejected code starts a new session and the TV shows a new PIN.
export async function finishPair(code: string): Promise<void> {
  try {
    $('#retryPairSave')!.hidden = true;
    const result = await desktopAPI.finishPair(code);
    // Cancelled while the TV checked the code; the remote has moved on.
    if (!result) return;
    try {
      await refreshDevices();
      await saveActiveDevice(result);
      connectToATV();
    } catch (error) {
      showRequestError(error);
    }
  } catch (err) {
    console.error('Pairing failed:', err);
    if (err instanceof Error && err.message.startsWith('Secure storage:')) {
      setStatus(`${err.message}. Unlock secure storage, then retry saving.`);
      $('#retryPairSave')!.hidden = false;
      return;
    }
    setStatus("That code didn't work. Enter the new code shown on your Apple TV.");
    startPair(pairDevice);
  }
}

/** Shows the empty PIN boxes, ready to type in, and asks the TV for a PIN. */
function startPairing(dev: string): void {
  const name = dev.replace(/ \([^()]*\)$/, '');
  $('#pairCodeLabel')!.textContent = `Enter the code shown on ${name}`;
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
  if ($('#retryPairSave')!.hidden) clearPin();
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
let cancelPresses = (): void => {};
// A canceled mouse press may release after connected state replaces its event listeners.
const cancelledButtons = new WeakSet<Element>();

function showKeyMap(): void {
  // The keyboard hint is for the first connection after launch, not reconnects after a wake.
  const firstConnection = !buttonAbort;
  if (buttonAbort) buttonAbort.abort();
  buttonAbort = new AbortController();
  const { signal } = buttonAbort;
  const deviceIdentifier = getActiveIdentifier();

  const touchpad = document.getElementById('touchpad')!;

  // --- Touchpad gesture detection ---
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const longPressTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  const longPressedButtons = new Set<Element>();
  const activeButtons = new Set<Element>();
  let clickStart: { x: number; y: number; t: number } | null = null;

  function canSendPress(): boolean {
    return (
      !signal.aborted &&
      connection.status === 'connected' &&
      getActiveIdentifier() === deviceIdentifier
    );
  }

  function cancelLocalPresses(): void {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    clickStart = null;
    for (const [button, timer] of longPressTimers) {
      clearTimeout(timer);
      button.classList.remove('pressing', 'longpress-triggered');
    }
    for (const button of activeButtons) {
      cancelledButtons.add(button);
      button.classList.remove('pressing', 'longpress-triggered');
    }
    longPressTimers.clear();
    longPressedButtons.clear();
    activeButtons.clear();
  }
  cancelPresses = cancelLocalPresses;
  signal.addEventListener('abort', cancelLocalPresses, { once: true });
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
  let touchActive = false;
  let touchX = 500;
  let touchY = 500;
  type TouchPoint = { x: number; y: number };
  type TouchGesture = {
    identifier: string | null;
    press: TouchPoint;
    hold: TouchPoint | null;
    release: TouchPoint | null;
    pressSent: boolean;
  };
  let touchInFlight = false;
  let activeTouch: TouchGesture | null = null;
  let pendingTouch: TouchGesture | null = null;

  function dispatchTouch(): void {
    if (touchInFlight) return;
    if (!activeTouch) {
      activeTouch = pendingTouch;
      pendingTouch = null;
    }
    const gesture = activeTouch;
    if (!gesture) return;

    let phase: 'press' | 'hold' | 'release';
    let point: TouchPoint;
    if (!gesture.pressSent) {
      gesture.pressSent = true;
      phase = 'press';
      point = gesture.press;
    } else if (gesture.hold) {
      point = gesture.hold;
      gesture.hold = null;
      phase = 'hold';
    } else if (gesture.release) {
      point = gesture.release;
      activeTouch = null;
      phase = 'release';
    } else {
      return;
    }

    touchInFlight = true;
    void (async () => {
      if (
        gesture.identifier === getActiveIdentifier() &&
        (!signal.aborted || phase === 'release')
      ) {
        await companionTouchAdapter(point.x, point.y, phase);
      }
    })()
      .catch(showRequestError)
      .finally(() => {
        touchInFlight = false;
        dispatchTouch();
      });
  }

  function queueTouch(x: number, y: number, phase: 'press' | 'hold' | 'release'): void {
    if (phase === 'press') {
      const gesture = {
        identifier: getActiveIdentifier(),
        press: { x, y },
        hold: null,
        release: null,
        pressSent: false,
      };
      if (activeTouch || touchInFlight) pendingTouch = gesture;
      else activeTouch = gesture;
    } else {
      const gesture = pendingTouch ?? activeTouch;
      if (!gesture) return;
      if (phase === 'hold') gesture.hold = { x, y };
      else gesture.release = { x, y };
    }
    dispatchTouch();
  }
  const SCROLL_THRESHOLD = 90;
  /** Quiet time that ends a gesture; events arrive about every 16 ms until momentum stops. */
  const GESTURE_END_MS = 150;

  function endGesture(): void {
    clearTimeout(gestureEndTimer);
    if (touchActive) {
      touchActive = false;
      queueTouch(touchX, touchY, 'release');
    }
    scrollAccX = 0;
    scrollAccY = 0;
    gestureMoved = false;
  }
  const stopGestureListener = desktopAPI.onScrollGestureBegan(endGesture);
  signal.addEventListener(
    'abort',
    () => {
      stopGestureListener();
      endGesture();
      pendingTouch = null;
    },
    { once: true },
  );

  touchpad.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();

      clearTimeout(gestureEndTimer);
      gestureEndTimer = setTimeout(endGesture, GESTURE_END_MS);
      if (companionTouchAvailable()) {
        if (!touchActive) {
          touchActive = true;
          touchX = touchY = 500;
          queueTouch(touchX, touchY, 'press');
        }
        touchX = Math.round(Math.max(0, Math.min(1000, touchX - e.deltaX * 2)));
        touchY = Math.round(Math.max(0, Math.min(1000, touchY - e.deltaY * 2)));
        queueTouch(touchX, touchY, 'hold');
        return;
      }
      if (touchActive || gestureMoved) return;

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

  // Only the primary button presses. A right-click opens the context menu, which takes the
  // mouseup, so a long-press timer it started would fire and press the key.
  touchpad.addEventListener(
    'mousedown',
    function (e) {
      if (e.button !== 0 || (e.target as Element | null)?.closest('button')) return;
      clickStart = { x: e.clientX, y: e.clientY, t: Date.now() };
      longPressTimer = setTimeout(function () {
        if (!canSendPress()) return;
        void sendCommand('select', true);
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
      if (dist < 15 && elapsed < 300 && canSendPress()) {
        void sendCommand('select');
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
  $$('[data-key]').forEach(function (button) {
    button.addEventListener(
      'mousedown',
      function (e) {
        if (e.button !== 0) return;
        const key = (button as HTMLElement).dataset.key!;
        const timer = setTimeout(() => {
          if (!canSendPress() || !longPressTimers.has(button)) return;
          longPressTimers.delete(button);
          longPressedButtons.add(button);
          button.classList.add('longpress-triggered');
          void sendCommand(key, true);
          setTimeout(() => button.classList.remove('pressing', 'longpress-triggered'), 200);
        }, 1000);
        longPressTimers.set(button, timer);
        activeButtons.add(button);
        longPressedButtons.delete(button);
        cancelledButtons.delete(button);
        button.classList.add('pressing');
      },
      { signal },
    );

    function endPress(e: Event): void {
      const timer = longPressTimers.get(button);
      if (timer) {
        clearTimeout(timer);
        longPressTimers.delete(button);
      }
      button.classList.remove('pressing');
      if (e.type === 'mouseleave') {
        if (activeButtons.has(button)) cancelledButtons.add(button);
        activeButtons.delete(button);
        longPressedButtons.delete(button);
      }
    }

    button.addEventListener('mouseup', endPress, { signal });
    button.addEventListener('mouseleave', endPress, { signal });
    button.addEventListener(
      'click',
      (e) => {
        activeButtons.delete(button);
        const cancelled = cancelledButtons.delete(button);
        if ((cancelled && e.detail !== 0) || longPressedButtons.delete(button) || !canSendPress()) {
          return;
        }
        void sendCommand((button as HTMLElement).dataset.key!);
      },
      { signal },
    );
  });

  if (firstConnection) showKeyboardHint();
}

function getActiveIdentifier(): string | null {
  return loadActiveDevice()?.identifier ?? null;
}

function getConnectedDeviceName(): string | null {
  const activeId = getActiveIdentifier();
  return (activeId && loadDevices()[activeId]?.name) || null;
}

export function updateConnectionDot(state: ConnectionDotState): void {
  for (const dot of [$('#connectionDot')!, $('#miniDot')!]) {
    dot.classList.remove('connected', 'connecting', 'disconnected', 'asleep');
    // Idle (and pairing) leaves the dot its plain grey.
    if (state !== 'idle') dot.classList.add(asleep && state === 'connected' ? 'asleep' : state);
  }

  // The dot alone says the TV is asleep; the name has no room for more.
  $('#deviceName')!.textContent =
    (state !== 'idle' && getConnectedDeviceName()) || 'Apple TV Remote';
  renderMiniText();
  renderMiniDevices();
}

/** Connects to the selected device; the native host supplies its pairing keys. */
export function connectToATV(): void {
  const device = loadActiveDevice();
  if (device) desktopAPI.connect(device.identifier).catch(showRequestError);
}

/** Like connectToATV, but the sidecar ignores it while pairing. */
function reconnectToATV(): void {
  const device = loadActiveDevice();
  if (device) desktopAPI.reconnect(device.identifier).catch(showRequestError);
}

function showRequestError(err: unknown): void {
  setStatus(err instanceof Error ? err.message : 'Unable to reach the Apple TV backend.');
}

export function setStatus(txt: string): void {
  const el = $('#statusText')!;
  el.textContent = txt;
  el.style.display = 'block';
}

/** Hides the status line; the next setStatus shows it again. */
function clearStatus(): void {
  $('#statusText')!.style.display = 'none';
}

/**
 * Scans for Apple TVs to pair. The scan puts the sidecar in pairing mode, and that state
 * shows this screen.
 */
export function startScan(): void {
  const loader = $('#loader')!;
  loader.style.display = 'block';
  loader.classList.add('fade-in');
  $('#topTextKBLink')!.style.display = 'none';
  // Start from the device picker, even after an earlier pairing in this window.
  $('#pairingElements')!.style.display = 'none';
  $('#results')!.style.display = '';
  $('#pairCodeElements')!.style.display = 'none';
  setStatus('Looking for Apple TVs…');
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

function setAlwaysOnTop(tf: boolean): void {
  void desktopAPI.setAlwaysOnTop(tf);
}

// The webview cannot download blobs, so the host writes the file from a native save dialog.
async function exportCredentials(): Promise<void> {
  if (
    await desktopAPI.exportCredentials({
      uimode: localStorage.getItem('uimode'),
      alwaysOnTopChecked: localStorage.getItem('alwaysOnTopChecked'),
    })
  ) {
    setStatus('Backup exported.');
  }
}

// Picked from a native dialog, like the export, so the window stays up to show the result.
async function importCredentials(): Promise<void> {
  const settings = await desktopAPI.importCredentials();
  if (settings === null) return;
  await refreshDevices();
  for (const key of ['uimode', 'alwaysOnTopChecked'] as const) {
    const value = settings[key];
    if (typeof value === 'string') localStorage.setItem(key, value);
    else if (value === null) localStorage.removeItem(key);
  }
  await handleDarkMode();
  setAlwaysOnTop(safeParse(localStorage.getItem('alwaysOnTopChecked'), false));
  populateDeviceList();
  handleContextMenu();
  // connect replaces the old connection; without an active device, just drop it.
  if (loadActiveDevice()) {
    setStatus('Backup imported. Reconnecting…');
    connectToATV();
  } else {
    setStatus('Backup imported.');
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

/** The playing item: `elapsed` seconds in at `at` (ms since the Unix epoch), moving at `rate`. */
const NO_POSITION = { duration: 0, elapsed: 0, at: 0, rate: 0 };
let position = NO_POSITION;
/** True while the seek bar is being dragged, so the clock does not move it. */
let dragging = false;

/** The position `info` reports. The TV can report rate 1 for a moment after pausing. */
function reportedPosition(info: NowPlayingInfo): typeof NO_POSITION {
  const playing = info.playbackState === PlaybackState.Playing;
  return {
    duration: info.duration ?? 0,
    elapsed: info.elapsedTime ?? 0,
    at: info.timestamp ? (info.timestamp + MRP_EPOCH_OFFSET) * 1000 : Date.now(),
    rate: playing ? (info.playbackRate ?? 1) : 0,
  };
}

/** Where a position has reached by now, as the clock advances it between reports. */
function secondsNow({ elapsed, rate, at, duration }: typeof NO_POSITION): number {
  return Math.min(duration, Math.max(0, elapsed + (rate * (Date.now() - at)) / 1000));
}

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
  $('#miniProgress')!.style.width = `${played}%`;
  $('#npElapsed')!.textContent = formatTime(seconds);
}

/** Shows the bar at the current position, or hides it when the item has no length. */
function renderSeekBar(): void {
  const seek = $('#seek');
  if (!seek) return;
  seek.style.display = position.duration > 0 ? '' : 'none';
  if (position.duration <= 0) $('#miniProgress')!.style.width = '0';
  if (position.duration <= 0 || dragging) return;
  const seconds = secondsNow(position);
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
    renderRowProgress();
  }, 1000);
}

/** Shows the title, artist, and position, and a pause icon on the play button while playing. */
function updateNowPlaying(info: NowPlayingInfo): void {
  reportedPlaying = info.playbackState === PlaybackState.Playing;
  position = reportedPosition(info);
  renderSeekBar();
  if (reportedPlaying === iconPlaying) cancelFlip();
  if (!flipTimer) showPlayPauseIcon(reportedPlaying);
  const container = $('#nowPlaying');
  if (!container) return;

  const title = info.title || '';
  const artist = info.artist || '';
  playingText = { title, artist };
  renderMiniText();
  const showing = Boolean(title || artist);
  $('#touchpad')!.classList.toggle('has-title', showing);
  container.style.display = showing ? 'block' : 'none';
  if (!showing) return;

  $('#npTitle')!.textContent = title;
  $('#npArtist')!.textContent = artist;
}

/** Fills the touchpad with the item's artwork. `url` is a validated base64 data URL. */
function showArtwork(url: string | null): void {
  $('#touchpadArt')!.style.backgroundImage = url ? `url("${url}")` : '';
  $('#touchpad')!.classList.toggle('has-art', Boolean(url));
}

/** Not connected: hides the title and artist, and the play button shows play. */
function hideNowPlaying(): void {
  position = NO_POSITION;
  renderSeekBar();
  cancelFlip();
  reportedPlaying = false;
  showPlayPauseIcon(false);
  showArtwork(null);
  playingText = { title: '', artist: '' };
  renderMiniText();
  $('#touchpad')!.classList.toggle('has-title', false);
  const container = $('#nowPlaying');
  if (container) container.style.display = 'none';
}

function showPlayPauseIcon(playing: boolean): void {
  iconPlaying = playing;
  for (const el of [$('#playPauseIcon'), $('#miniPlayIcon')]) {
    if (el) el.innerHTML = icon(playing ? 'pause' : 'play');
  }
}

// --- Mini bar ---

/** The playing item's text, which the mini bar shows in place of the device name. */
let playingText = { title: '', artist: '' };

function renderMiniText(): void {
  const { title, artist } = playingText;
  const playing = title || artist;
  const miniTitle = $('#miniTitle')!;
  miniTitle.textContent = playing || $('#deviceName')!.textContent;
  // The bar cuts long titles off; the tooltip shows the whole one.
  miniTitle.title = miniTitle.textContent ?? '';
  // With rows below, the room says which TV this is; the title alone would not.
  const room = otherDevices().length > 0 ? $('#deviceName')!.textContent : title && artist;
  $('#miniSubtitle')!.textContent = playing ? room : 'Nothing playing';
}

// --- Mini bar rows: the other saved TVs ---

/** Which TVs have a watch connection; they live only while the mini bar is open. */
const watchedIds = new Set<string>();
const watchedTvs = new Map<string, { status: ConnectionState['status']; info: NowPlayingInfo }>();
/** Each row's progress fill, which the clock moves between the TV's reports. */
const rowProgress = new Map<string, HTMLElement>();
let miniOpen = false;

function otherDevices(): SavedDevice[] {
  const active = getActiveIdentifier();
  return Object.values(loadDevices()).filter(({ identifier }) => identifier !== active);
}

function logWatchError(error: unknown): void {
  console.error('Watching an Apple TV failed:', error);
}

/** Opens a connection to each TV with a row, and closes the rest. */
function syncWatchedTvs(): void {
  const wanted = new Set(miniOpen ? otherDevices().map(({ identifier }) => identifier) : []);
  for (const identifier of watchedIds) {
    if (wanted.has(identifier)) continue;
    watchedIds.delete(identifier);
    watchedTvs.delete(identifier);
    desktopAPI.unwatch(identifier).catch(logWatchError);
  }
  for (const identifier of wanted) {
    if (watchedIds.has(identifier)) continue;
    watchedIds.add(identifier);
    desktopAPI.watch(identifier).catch(logWatchError);
  }
}

function updateWatchedTv({ identifier, state, nowPlaying }: WatchedTvUpdate): void {
  // A report can arrive just after the row's connection was closed.
  if (!watchedIds.has(identifier)) return;
  const tv = watchedTvs.get(identifier);
  const status = state?.status ?? tv?.status ?? 'connecting';
  const info = nowPlaying ?? (status === 'connected' ? (tv?.info ?? {}) : {});
  watchedTvs.set(identifier, { status, info });
  renderMiniDevices();
}

/** The sidecar's watch connections died with it, so the next render opens them again. */
function recoverFromLostBackend(): void {
  watchedIds.clear();
  watchedTvs.clear();
  reconnectToATV();
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function rowSubtitle(name: string, status: ConnectionState['status'], playing: boolean): string {
  if (playing) return name;
  if (status === 'connected') return 'Nothing playing';
  return status === 'disconnected' ? 'Not available' : 'Connecting…';
}

function rowControl(
  className: string,
  iconName: string,
  label: string,
  send: () => void,
  connected: boolean,
): HTMLButtonElement {
  const button = createElement('button', `directionCircle ${className}`);
  button.type = 'button';
  button.innerHTML = icon(iconName);
  button.disabled = !connected;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', send);
  return button;
}

/** A row like the bar above: the TV's playback and controls, and its text switches to it. */
function miniRow({ identifier, name }: SavedDevice): HTMLElement {
  const { status, info } = watchedTvs.get(identifier) ?? { status: 'connecting', info: {} };
  const item = info.title || info.artist;
  const connected = status === 'connected';
  const send = (key: ATVKeyName) => () => {
    desktopAPI.sendWatchedKey(identifier, key).catch(showRequestError);
  };

  const text = createElement('button', 'mini-text');
  text.type = 'button';
  text.setAttribute('aria-label', `Switch to ${name}`);
  text.addEventListener('click', () => {
    void handleContextMenuAction('selectDevice', identifier);
  });
  const title = createElement('div', 'mini-title');
  const dotState = connected || status === 'disconnected' ? status : 'connecting';
  title.appendChild(createElement('span', `connection-dot ${dotState}`));
  title.appendChild(createElement('span', 'mini-name', item || name));
  text.appendChild(title);
  text.appendChild(createElement('div', 'mini-subtitle', rowSubtitle(name, status, Boolean(item))));

  const playing = info.playbackState === PlaybackState.Playing;
  const row = createElement('div', 'mini-row');
  row.appendChild(text);
  for (const control of [
    rowControl(
      'media-btn play-btn mini-play',
      playing ? 'pause' : 'play',
      `Play or pause ${name}`,
      send('play_pause'),
      connected,
    ),
    rowControl(
      'secondary-btn transport-btn',
      'volume-1',
      `Lower volume on ${name}`,
      send('volume_down'),
      connected,
    ),
    rowControl(
      'secondary-btn transport-btn',
      'volume-2',
      `Raise volume on ${name}`,
      send('volume_up'),
      connected,
    ),
  ]) {
    row.appendChild(control);
  }

  const progress = createElement('div', 'mini-progress');
  const fill = createElement('div', 'mini-progress-fill');
  progress.appendChild(fill);
  row.appendChild(progress);
  rowProgress.set(identifier, fill);
  return row;
}

function renderRowProgress(): void {
  for (const [identifier, fill] of rowProgress) {
    const position = reportedPosition(watchedTvs.get(identifier)?.info ?? {});
    const played = position.duration > 0 ? (secondsNow(position) / position.duration) * 100 : 0;
    fill.style.width = `${played.toFixed(1)}%`;
  }
}

/**
 * Rebuilds the rows under the bar. The app controls the selected TV through the bar and the rest
 * through their rows, each over its own connection.
 */
// ponytail: rebuilds every row on each report; patch the rows in place if clicks ever get lost.
function renderMiniDevices(): void {
  syncWatchedTvs();
  const list = $('#miniDevices')!;
  list.innerHTML = '';
  rowProgress.clear();
  if (!miniOpen) return;
  for (const device of otherDevices()) list.appendChild(miniRow(device));
  renderRowProgress();
}

/** Switches between the full remote and the mini bar; the window follows the page's height. */
function setMini(on: boolean): void {
  if (on) hideSettings();
  miniOpen = on;
  document.body.classList.toggle('mini', on);
  renderMiniDevices();
  renderMiniText();
}

function initMiniBar(): void {
  $('#collapseButton')!.addEventListener('click', () => setMini(true));
  $('#miniExpand')!.addEventListener('click', () => setMini(false));
  // Dialogs sit outside the page's height, so a 64px window would clip them.
  new MutationObserver(() => {
    if (document.querySelector('dialog[open]')) setMini(false);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
}

// --- Speakers ---

/** Scans for AirPlay speakers for the menu; a failed scan leaves the Speakers menu out. */
async function loadSpeakers(): Promise<void> {
  try {
    const found = await desktopAPI.speakers();
    if (connection.status === 'connected') speakers = found;
  } catch (error) {
    console.error('Speaker scan failed:', error);
  }
  handleContextMenu();
}

// --- Volume ---

/** How long the slider stays after the last change before the seek bar returns. */
const VOLUME_VISIBLE_MS = 2500;

/** True while the volume slider is being dragged, so reports do not move it. */
let volumeDragging = false;
let volumeLevel: number | null = null;
let volumeHideTimer: ReturnType<typeof setTimeout> | undefined;

/** Moves the slider's thumb and its filled part to `level`. */
function setVolumeBar(bar: HTMLInputElement, level: number): void {
  bar.value = String(Math.round(level));
  bar.style.backgroundSize = `${level}% 100%, 100% 100%`;
}

/** Swaps the seek bar for the slider, and back after a pause unless it is being dragged. */
function revealVolume(): void {
  document.body.classList.toggle('volume-active', true);
  clearTimeout(volumeHideTimer);
  volumeHideTimer = setTimeout(() => {
    if (volumeDragging) revealVolume();
    else document.body.classList.toggle('volume-active', false);
  }, VOLUME_VISIBLE_MS);
}

/**
 * Tracks the TV's absolute volume, and shows the slider when it changes. The first report is the
 * current level, not a change. Null (TV speakers, or not connected) leaves no slider to show.
 */
function showVolume(level: number | null): void {
  const changed = volumeLevel !== null && level !== volumeLevel;
  volumeLevel = level;
  if (level === null) {
    clearTimeout(volumeHideTimer);
    document.body.classList.toggle('volume-active', false);
    return;
  }
  if (volumeDragging) return;
  setVolumeBar($('#volumeBar') as HTMLInputElement, level);
  if (changed) revealVolume();
}

function initVolumeBar(): void {
  const bar = $('#volumeBar') as HTMLInputElement;
  bar.addEventListener('input', () => {
    volumeDragging = true;
    setVolumeBar(bar, Number(bar.value));
    revealVolume();
  });
  bar.addEventListener('change', () => {
    volumeDragging = false;
    revealVolume();
    desktopAPI.setVolume(Number(bar.value)).catch(showRequestError);
  });
}

// --- Settings Panel ---

function showSettings(): void {
  setMini(false);
  cancelPresses();
  $('#runningElements')!.style.display = 'none';
  $('#addNewElements')!.style.display = 'none';
  $('#settingsPanel')!.style.display = 'block';
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

let deviceMutation = Promise.resolve();

function queueDeviceMutation(operation: () => Promise<void>): Promise<void> {
  const next = deviceMutation.then(operation, operation);
  deviceMutation = next.catch(() => {});
  return next;
}

function populateDeviceList(): void {
  const listEl = $('#settingsDeviceList')!;
  listEl.innerHTML = '';
  const creds = loadDevices();
  const activeId = getActiveIdentifier();

  for (const [identifier, device] of Object.entries(creds)) {
    const row = document.createElement('div');
    row.className = 'settings-device-row';
    const label = document.createElement('span');
    const isActive = identifier === activeId;
    label.textContent = device.name + (isActive ? ' (active)' : '');
    label.className = 'settings-device-name';
    row.appendChild(label);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'settings-device-remove';
    removeBtn.addEventListener('click', () => {
      void queueDeviceMutation(async () => {
        const removingActiveDevice = getActiveIdentifier() === identifier;
        await removeDevice(identifier);
        if (removingActiveDevice && getActiveIdentifier() === null) {
          await desktopAPI.disconnect();
          setStatus('No device selected. Click the device name to choose one.');
        }
        populateDeviceList();
        handleContextMenu();
      }).catch(showRequestError);
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
  // Hotkey button
  $('#settingsHotkeyBtn')!.addEventListener('click', () => {
    void desktopAPI.loadHotkeyWindow();
  });

  $('#settingsExportCredentialsBtn')!.addEventListener('click', () => {
    void exportCredentials().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : 'Unable to export the backup.');
    });
  });
  $('#settingsImportCredentialsBtn')!.addEventListener('click', () => {
    void importCredentials().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : 'Unable to import the backup.');
    });
  });

  // Back button
  $('#settingsBackBtn')!.addEventListener('click', () => {
    hideSettings();
  });
}

// --- Context Menu ---

function contextMenuConfig(): ContextMenuConfig {
  const creds = loadDevices();
  const activeId = getActiveIdentifier();
  const mode = localStorage.getItem('uimode') || 'systemmode';
  const topChecked = safeParse(localStorage.getItem('alwaysOnTopChecked'), false);

  const devices = Object.entries(creds).map(([identifier, device]) => ({
    label: device.name,
    identifier,
    checked: identifier === activeId,
  }));

  return {
    devices,
    uiMode: mode,
    alwaysOnTop: topChecked,
    speakers: speakers.map(({ id, name, selected }) => ({
      label: name,
      id,
      checked: selected,
    })),
  };
}

function handleContextMenu(popup = false): void {
  void desktopAPI.showContextMenu(contextMenuConfig(), popup).catch(showRequestError);
}

function showDeviceMenu(): void {
  const header = $('#topTextHeader')!.getBoundingClientRect();
  void desktopAPI
    .showDeviceMenu(contextMenuConfig(), { x: header.left, y: header.bottom + 4 })
    .catch(showRequestError);
}

async function handleContextMenuAction(action: string, payload?: string): Promise<void> {
  switch (action) {
    case 'selectDevice': {
      cancelPresses();
      await queueDeviceMutation(async () => {
        const creds = loadDevices();
        if (!payload || !Object.hasOwn(creds, payload)) return;
        await saveActiveDevice(creds[payload]);
        connectToATV();
        if (settingsOpen()) populateDeviceList();
        handleContextMenu();
      });
      break;
    }
    // Pairing is an explicit navigation, so it leaves Settings (which would stay in front). The
    // active device stays active until a pairing succeeds, so Cancel goes back to it.
    case 'pairNew':
    case 'repairCurrent':
      hideSettings();
      startScan();
      break;
    case 'toggleSpeaker': {
      const speaker = speakers.find(({ id }) => id === payload);
      if (speaker) desktopAPI.setSpeaker(speaker.id, !speaker.selected).catch(showRequestError);
      break;
    }
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
  $('#topTextHeader')!.addEventListener('click', showDeviceMenu);
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    handleContextMenu(true);
  });
  initSettingsListeners();
  initSeekBar();
  initVolumeBar();
  initMiniBar();
  $('#powerButton')!.addEventListener('click', () => {
    desktopAPI.togglePower().catch(showRequestError);
  });

  // Back to the saved device, or, with none, a fresh scan; connecting ends pairing.
  $('#cancelPairing')!.addEventListener('click', () => {
    if (loadActiveDevice()) connectToATV();
    else startScan();
  });
  $('#retryPairSave')!.addEventListener('click', () => {
    const retry = $('#retryPairSave') as HTMLButtonElement;
    retry.disabled = true;
    void finishPair('').finally(() => {
      retry.disabled = false;
    });
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

  // With no active device, use the first saved one.
  let creds = loadActiveDevice();
  if (!creds) {
    creds = Object.values(loadDevices())[0] ?? null;
    if (creds) await saveActiveDevice(creds);
  }
  if (localStorage.getItem('firstRun') !== 'false') {
    localStorage.setItem('firstRun', 'false');
    void desktopAPI.showWindow();
  }

  if (creds) {
    connectToATV();
  } else {
    startScan();
  }
}
