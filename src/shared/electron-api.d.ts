import type { ATVCredentials, NowPlayingInfo, PairResult } from './types';

export interface ContextMenuConfig {
  devices: Array<{ label: string; identifier: string; checked: boolean }>;
  uiMode: string;
  alwaysOnTop: boolean;
}

export interface SettingsData {
  theme: string;
  alwaysOnTop: boolean;
  devices: Array<{ name: string; identifier: string }>;
}

export interface ElectronAPI {
  // IPC invoke wrappers
  loadHotkeyWindow(): Promise<void>;
  quit(): Promise<void>;
  setAlwaysOnTop(tf: string): Promise<void>;
  hideWindow(): Promise<void>;
  showWindow(): Promise<void>;
  scan(): Promise<string[]>;
  startPair(deviceLabel: string): Promise<void>;
  finishPair(pin: string): Promise<PairResult>;
  connect(creds: ATVCredentials): Promise<void>;
  disconnect(): Promise<void>;
  sendKey(key: string): Promise<void>;
  isConnected(): Promise<boolean>;

  // Context menu
  showContextMenu(config: ContextMenuConfig): void;

  // Theme
  getTheme(): Promise<boolean>;

  // Settings panel
  loadSettingsPanel(): Promise<SettingsData>;
  saveSettings(data: Partial<SettingsData>): Promise<void>;
  removeDevice(name: string): Promise<void>;

  // Event listeners (each returns cleanup function)
  onShortcutWin(callback: () => void): () => void;
  onPowerResume(callback: () => void): () => void;
  onSendCommand(callback: (key: string) => void): () => void;
  onAtvConnected(callback: () => void): () => void;
  onAtvConnectionFailure(callback: () => void): () => void;
  onAtvConnectionLost(callback: () => void): () => void;
  onAtvDisconnected(callback: () => void): () => void;
  onAtvNowPlaying(callback: (info: NowPlayingInfo) => void): () => void;
  onThemeUpdated(callback: (isDark: boolean) => void): () => void;
  onErrorMessage(callback: (msg: string) => void): () => void;
  onContextMenuAction(callback: (action: string, payload?: string) => void): () => void;
}

export interface HotkeyAPI {
  loadHotkey(): Promise<string | null>;
  saveHotkey(combo: string): Promise<void>;
  resetHotkey(): Promise<void>;
  closeWindow(): Promise<void>;
  getTheme(): Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    hotkeyAPI: HotkeyAPI;
  }
}
