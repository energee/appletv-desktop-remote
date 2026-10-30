// The webview's bridge to the Tauri host: sidecar requests via `backend_request`, window and
// file actions via `desktop_action`, and host events fanned out to typed listeners.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import type {
  ATVCredentials,
  ConnectionState,
  NowPlayingInfo,
  PairResult,
  PowerStatus,
} from './types';

export interface ContextMenuConfig {
  devices: Array<{ label: string; identifier: string; checked: boolean }>;
  uiMode: string;
  alwaysOnTop: boolean;
}

/** Sidecar events, plus `connection-lost`, which the host sends when the sidecar exits. */
type BackendEvent = 'state' | 'now-playing' | 'power-state' | 'error' | 'connection-lost';
type EventHandler = (value: unknown) => void;

const listeners = new Map<string, Set<EventHandler>>();
let subscriptions: Promise<void> | undefined;

function subscribe(name: string, handler: EventHandler): () => void {
  const handlers = listeners.get(name) ?? new Set<EventHandler>();
  handlers.add(handler);
  listeners.set(name, handlers);
  return () => handlers.delete(handler);
}

function emit(name: string, value: unknown): void {
  listeners.get(name)?.forEach((handler) => handler(value));
}

function nowPlayingInfo(data: unknown): NowPlayingInfo {
  if (typeof data !== 'object' || data === null) return {};
  const info: NowPlayingInfo = {};
  if ('title' in data && typeof data.title === 'string') info.title = data.title;
  if ('artist' in data && typeof data.artist === 'string') info.artist = data.artist;
  if ('album' in data && typeof data.album === 'string') info.album = data.album;
  if ('appDisplayName' in data && typeof data.appDisplayName === 'string') {
    info.appDisplayName = data.appDisplayName;
  }
  const record = data as Record<string, unknown>;
  for (const key of [
    'playbackState',
    'duration',
    'elapsedTime',
    'playbackRate',
    'timestamp',
  ] as const) {
    const value = record[key];
    if (typeof value === 'number') info[key] = value;
  }
  return info;
}

const statuses: readonly ConnectionState['status'][] = [
  'idle',
  'connecting',
  'connected',
  'disconnected',
  'pairing',
];

function connectionState(data: unknown): ConnectionState | null {
  if (typeof data !== 'object' || data === null || !('status' in data)) return null;
  const status = statuses.find((known) => known === data.status);
  return status ? { status } : null;
}

// Tauri rejects with the command's raw `Err(String)`; the UI only displays `Error` messages.
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function request<T>(method: string, params: unknown = {}): Promise<T> {
  return call<T>('backend_request', { method, params });
}

async function action<T>(action: string, args: unknown = {}): Promise<T> {
  return call<T>('desktop_action', { action, args });
}

export const desktopAPI = {
  async start(): Promise<void> {
    if (!subscriptions) {
      subscriptions = Promise.all([
        listen<{ event: BackendEvent; data: unknown }>('backend-event', ({ payload }) => {
          emit(`backend:${payload.event}`, payload.data);
        }),
        listen('shortcutWin', () => emit('shortcutWin', undefined)),
        listen('powerResume', () => emit('powerResume', undefined)),
        listen('scrollGestureBegan', () => emit('scrollGestureBegan', undefined)),
        listen<{ action: string; payload?: string }>('context-menu-action', ({ payload }) => {
          emit('context-menu-action', payload);
        }),
      ]).then((unlisten) => {
        window.addEventListener(
          'beforeunload',
          () => unlisten.forEach((stop: UnlistenFn) => stop()),
          { once: true },
        );
      });
    }
    await subscriptions;
  },

  showWindow: () => action<void>('showWindow'),
  hideWindow: () => action<void>('hideWindow'),
  quit: () => action<void>('quit'),
  setAlwaysOnTop: (value: boolean) => action<void>('setAlwaysOnTop', { value }),
  /** Sets this window's appearance, which the macOS glass follows; null follows the system. */
  setWindowTheme: (theme: 'light' | 'dark' | null) => getCurrentWindow().setTheme(theme),
  /** Resizes this window to `height` points, keeping its width and top edge. */
  setWindowHeight: (height: number) =>
    getCurrentWindow().setSize(new LogicalSize(window.innerWidth, height)),
  loadHotkeyWindow: () => action<void>('loadHotkeyWindow'),
  closeHotkeyWindow: () => action<void>('closeHotkeyWindow'),
  loadHotkey: () => action<string | null>('loadHotkey'),
  saveHotkey: (combo: string) => action<void>('saveHotkey', { combo }),
  resetHotkey: () => action<void>('resetHotkey'),
  /** Saves `contents` via a native save dialog; resolves false if the user cancels. */
  exportCredentials: (contents: string) => action<boolean>('exportCredentials', { contents }),
  /** Reads a backup picked in a native open dialog; resolves null if the user cancels. */
  importCredentials: () => action<string | null>('importCredentials'),
  showContextMenu: (config: ContextMenuConfig, popup = false) =>
    action<void>('showContextMenu', { ...config, popup }),

  scan: () => request<string[]>('scan'),
  startPair: (deviceLabel: string) => request<void>('startPair', { deviceLabel }),
  /** Null if pairing was cancelled while the TV checked the PIN. */
  finishPair: (pin: string) => request<PairResult | null>('finishPair', { pin }),
  /** Connects to `credentials`, leaving pairing; resolves at once, progress comes as state. */
  connect: (credentials: ATVCredentials) => request<void>('connect', credentials),
  /** Wake and sidecar restarts: like connect, but the sidecar ignores it while pairing. */
  reconnect: (credentials: ATVCredentials) => request<void>('reconnect', credentials),
  disconnect: () => request<void>('disconnect'),
  sendKey: (key: string) => request<void>('sendKey', { key }),
  /** Wakes the TV if it is asleep, otherwise puts it to sleep. */
  togglePower: () => request<void>('power'),
  /** Moves the playing item to `seconds` from its start. */
  seek: (seconds: number) => request<void>('seek', { seconds }),
  isConnected: () => request<boolean>('isConnected'),

  onShortcutWin: (callback: () => void) => subscribe('shortcutWin', callback),
  onPowerResume: (callback: () => void) => subscribe('powerResume', callback),
  /** macOS only: fingers started a new trackpad scroll (momentum after lifting never does). */
  onScrollGestureBegan: (callback: () => void) => subscribe('scrollGestureBegan', callback),
  onAtvState: (callback: (state: ConnectionState) => void) =>
    subscribe('backend:state', (data) => {
      const state = connectionState(data);
      if (state) callback(state);
    }),
  /** The sidecar exited; the next request relaunches it with no connection. */
  onBackendLost: (callback: () => void) => subscribe('backend:connection-lost', callback),
  onAtvPowerState: (callback: (state: PowerStatus) => void) =>
    subscribe('backend:power-state', (data) => {
      if (data === 'on' || data === 'off' || data === 'unknown') callback(data);
    }),
  onAtvNowPlaying: (callback: (info: NowPlayingInfo) => void) =>
    subscribe('backend:now-playing', (data) => callback(nowPlayingInfo(data))),
  onErrorMessage: (callback: (message: string) => void) =>
    subscribe('backend:error', (data) => {
      if (typeof data === 'object' && data !== null && 'message' in data) {
        callback(String(data.message));
        return;
      }
      callback(String(data));
    }),
  onContextMenuAction: (callback: (action: string, payload?: string) => void) =>
    subscribe('context-menu-action', (data) => {
      if (
        typeof data === 'object' &&
        data !== null &&
        'action' in data &&
        typeof data.action === 'string'
      ) {
        const payload =
          'payload' in data && typeof data.payload === 'string' ? data.payload : undefined;
        callback(data.action, payload);
      }
    }),
};
