import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI, ContextMenuConfig } from '../shared/electron-api';

function createListener(channel: string) {
  return (callback: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

const api: ElectronAPI = {
  // IPC invoke wrappers
  loadHotkeyWindow: () => ipcRenderer.invoke('loadHotkeyWindow'),
  quit: () => ipcRenderer.invoke('quit'),
  setAlwaysOnTop: (tf: string) => ipcRenderer.invoke('alwaysOnTop', tf),
  hideWindow: () => ipcRenderer.invoke('hideWindow'),
  showWindow: () => ipcRenderer.invoke('showWindow'),
  scan: () => ipcRenderer.invoke('atv:scan'),
  startPair: (deviceLabel: string) => ipcRenderer.invoke('atv:startPair', deviceLabel),
  finishPair: (pin: string) => ipcRenderer.invoke('atv:finishPair', pin),
  connect: (creds) => ipcRenderer.invoke('atv:connect', creds),
  disconnect: () => ipcRenderer.invoke('atv:disconnect'),
  sendKey: (key: string) => ipcRenderer.invoke('atv:sendKey', key),
  isConnected: () => ipcRenderer.invoke('atv:isConnected'),

  // Context menu
  showContextMenu: (config: ContextMenuConfig) => ipcRenderer.send('showContextMenu', config),

  // Theme
  getTheme: () => ipcRenderer.invoke('getTheme'),

  // Settings panel
  loadSettingsPanel: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  removeDevice: (name: string) => ipcRenderer.invoke('settings:removeDevice', name),

  // Event listeners
  onShortcutWin: createListener('shortcutWin'),
  onPowerResume: createListener('powerResume'),
  onSendCommand: createListener('sendCommand') as ElectronAPI['onSendCommand'],
  onAtvConnected: createListener('atv:connected'),
  onAtvConnectionFailure: createListener('atv:connection-failure'),
  onAtvConnectionLost: createListener('atv:connection-lost'),
  onAtvDisconnected: createListener('atv:disconnected'),
  onAtvNowPlaying: createListener('atv:now-playing') as ElectronAPI['onAtvNowPlaying'],
  onThemeUpdated: createListener('theme:updated') as ElectronAPI['onThemeUpdated'],
  onErrorMessage: createListener('atv:error-message') as ElectronAPI['onErrorMessage'],
  onContextMenuAction: createListener('context-menu-action') as ElectronAPI['onContextMenuAction'],
};

contextBridge.exposeInMainWorld('electronAPI', api);
