import type { ATVCredentials, PairResult } from './types';

// ipcMain.handle channels (renderer invokes, main handles)
export interface IpcInvokeChannels {
  loadHotkeyWindow: () => void;
  quit: () => void;
  alwaysOnTop: (tf: string) => void;
  hideWindow: () => void;
  'atv:scan': () => string[];
  'atv:startPair': (deviceLabel: string) => void;
  'atv:finishPair': (pin: string) => PairResult;
  'atv:connect': (creds: ATVCredentials) => void;
  'atv:disconnect': () => void;
  'atv:sendKey': (key: string) => void;
  'atv:isConnected': () => boolean;
}

// ipcMain.send / ipcRenderer.on channels (main sends to renderer)
export interface IpcSendChannels {
  shortcutWin: () => void;
  mainLog: (txt: string) => void;
  powerResume: () => void;
  sendCommand: (key: string) => void;
  'atv:connected': () => void;
  'atv:connection-failure': () => void;
  'atv:connection-lost': () => void;
  'atv:disconnected': () => void;
  'atv:now-playing': (info: unknown) => void;
  'atv:error-message': (msg: string) => void;
  'theme:updated': (isDark: boolean) => void;
  'context-menu-action': (action: string, payload?: string) => void;
}
