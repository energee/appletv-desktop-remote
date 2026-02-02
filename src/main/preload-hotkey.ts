import { contextBridge, ipcRenderer } from 'electron';
import type { HotkeyAPI } from '../shared/electron-api';

const api: HotkeyAPI = {
  loadHotkey: () => ipcRenderer.invoke('hotkey:load'),
  saveHotkey: (combo: string) => ipcRenderer.invoke('hotkey:save', combo),
  resetHotkey: () => ipcRenderer.invoke('hotkey:reset'),
  closeWindow: () => ipcRenderer.invoke('closeHotkeyWindow'),
  getTheme: () => ipcRenderer.invoke('getTheme'),
};

contextBridge.exposeInMainWorld('hotkeyAPI', api);
