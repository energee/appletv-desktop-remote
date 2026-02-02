import { ipcRenderer } from 'electron';
import {
  atv_connected,
  atv_events,
  connecting,
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
const MAX_RECONNECT_DELAY = 30000;

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
      console.log('Auto-reconnect: max attempts reached');
      atv_events.emit('reconnect_failed');
    }
    reconnectAttempt = 0;
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
  reconnectAttempt++;
  console.log(
    `Auto-reconnect: attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
  );

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (atv_connected) return;

    try {
      const creds = JSON.parse(localStorage.getItem('atvcreds')!);
      if (!creds) return;
      await connectATV(creds);
      console.log('Auto-reconnect: success');
      reconnectAttempt = 0;
    } catch (err: unknown) {
      console.log('Auto-reconnect: failed -', (err as Error).message || err);
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

export function sendKey(cmd: string): void {
  ipcRenderer.invoke('atv:sendKey', cmd).catch((err: Error) => {
    console.error('sendKey failed:', err);
  });
}

export function sendKeyAction(cmd: string, taction: string): void {
  ipcRenderer.invoke('atv:sendKey', cmd, taction).catch((err: Error) => {
    console.error('sendKey failed:', err);
  });
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
      console.log('AirPlay paired, waiting for companion PIN...');
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
  const ar = JSON.parse(localStorage.getItem('remote_credentials') || '{}');
  let c = creds;
  if (typeof c === 'string') c = JSON.parse(c);
  ar[name] = c;
  localStorage.setItem('remote_credentials', JSON.stringify(ar));
}

export function initRemote(): void {
  console.log('atv_remote init');
}
