import {
  atv_connected,
  atv_events,
  safeParse,
  setAtvConnected,
  setPairDevice,
  pairDevice,
  $,
} from './state';
import { createDropdown, connectToATV } from './web_remote';

let _connection_failure = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY = 10000;

export function initRemote(): void {
  // Listen for main process events via preload API
  window.electronAPI.onAtvConnected(() => {
    setAtvConnected(true);
    _connection_failure = false;
    cancelReconnect();
    atv_events.emit('connected', true);
  });

  window.electronAPI.onAtvConnectionFailure(() => {
    setAtvConnected(false);
    _connection_failure = true;
    atv_events.emit('connection_failure');
  });

  window.electronAPI.onAtvConnectionLost(() => {
    setAtvConnected(false);
    atv_events.emit('connected', false);
    scheduleReconnect();
  });

  window.electronAPI.onAtvDisconnected(() => {
    setAtvConnected(false);
    atv_events.emit('connected', false);
  });

  window.electronAPI.onAtvNowPlaying((info) => {
    atv_events.emit('now-playing', info);
  });
}

// --- Auto-reconnect ---

function cancelReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}

function scheduleReconnect(): void {
  cancelReconnect();
  const creds = localStorage.getItem('atvcreds');
  if (!creds) return;

  reconnectAttempt = 0;
  attemptReconnect();
}

function attemptReconnect(): void {
  if (atv_connected || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      atv_events.emit('reconnect_failed');
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
      const creds = safeParse(localStorage.getItem('atvcreds'), null);
      if (!creds) return;
      await connectATV(creds);
      reconnectAttempt = 0;
    } catch {
      attemptReconnect();
    }
  }, delay);
}

// --- Public API ---

export async function scanDevices(): Promise<void> {
  cancelReconnect();
  _connection_failure = false;
  try {
    const results = await window.electronAPI.scan();
    createDropdown(results || []);
  } catch (err) {
    console.error('Scan failed:', err);
    createDropdown([]);
  }
}

export function sendKey(cmd: string): Promise<void> {
  return window.electronAPI.sendKey(cmd);
}

export function connectATV(creds: unknown): Promise<void> {
  return window.electronAPI
    .connect(creds as { credentials: string; identifier: string })
    .catch((err: Error) => {
      _connection_failure = true;
      atv_events.emit('connection_failure');
      throw err;
    });
}

export function startPair(dev: string): void {
  cancelReconnect();
  _connection_failure = false;
  setPairDevice(dev);
  window.electronAPI.startPair(dev).catch((err: Error) => {
    console.error('startPair failed:', err);
  });
}

// Two-phase pairing: AirPlay first, then Companion
export async function finishPair(code: string): Promise<void> {
  _connection_failure = false;
  try {
    const result = await window.electronAPI.finishPair(code);
    if (result.needsCompanionPin) {
      // AirPlay paired, now need companion PIN
      ($('#pairCode') as HTMLInputElement).value = '';
      $('#pairStepNum')!.textContent = '2';
      $('#pairProtocolName')!.textContent = 'Companion';
      return;
    }
    // Both pairings complete - save and connect
    saveRemote(pairDevice, result);
    localStorage.setItem('atvcreds', JSON.stringify(result));
    connectToATV();
  } catch (err) {
    console.error('finishPair failed:', err);
  }
}

function saveRemote(name: string, creds: unknown): void {
  const ar = safeParse(localStorage.getItem('remote_credentials'), {} as Record<string, unknown>);
  let c = creds;
  if (typeof c === 'string') c = JSON.parse(c);
  ar[name] = c;
  localStorage.setItem('remote_credentials', JSON.stringify(ar));
}
