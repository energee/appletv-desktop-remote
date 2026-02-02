import { ipcRenderer } from 'electron';
import {
  atv_connected,
  atv_events,
  connecting,
  safeParse,
  setAtvConnected,
  setConnecting,
  setPairDevice,
  pairDevice,
  $,
} from './state';
import { createDropdown, connectToATV } from './web_remote';

let connection_failure = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY = 10000;

// Listen for main process events
ipcRenderer.on('atv:connected', () => {
  setAtvConnected(true);
  connection_failure = false;
  cancelReconnect();
  atv_events.emit('connected', true);
});

ipcRenderer.on('atv:connection-failure', () => {
  setAtvConnected(false);
  connection_failure = true;
  atv_events.emit('connection_failure');
});

ipcRenderer.on('atv:connection-lost', () => {
  setAtvConnected(false);
  atv_events.emit('connected', false);
  scheduleReconnect();
});

ipcRenderer.on('atv:disconnected', () => {
  setAtvConnected(false);
  atv_events.emit('connected', false);
});

ipcRenderer.on('atv:now-playing', (_event, info) => {
  atv_events.emit('now-playing', info);
});

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
  connection_failure = false;
  try {
    const results = await ipcRenderer.invoke('atv:scan');
    createDropdown(results || []);
  } catch (err) {
    console.error('Scan failed:', err);
    createDropdown([]);
  }
}

export function sendKey(cmd: string): Promise<void> {
  return ipcRenderer.invoke('atv:sendKey', cmd);
}

export function sendKeyAction(cmd: string, taction: string): Promise<void> {
  return ipcRenderer.invoke('atv:sendKey', cmd, taction);
}

export function connectATV(creds: unknown): Promise<void> {
  return ipcRenderer.invoke('atv:connect', creds).catch((err: Error) => {
    connection_failure = true;
    atv_events.emit('connection_failure');
    throw err;
  });
}

export function startPair(dev: string): void {
  cancelReconnect();
  connection_failure = false;
  setPairDevice(dev);
  ipcRenderer.invoke('atv:startPair', dev).catch((err: Error) => {
    console.error('startPair failed:', err);
  });
}

// Two-phase pairing: AirPlay first, then Companion
export async function finishPair(code: string): Promise<void> {
  connection_failure = false;
  try {
    const result = await ipcRenderer.invoke('atv:finishPair', code);
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

export function initRemote(): void {}
