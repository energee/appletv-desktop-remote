import { EventEmitter } from 'events';
import type { Menubar } from 'menubar';
import type { ATVCredentials } from '../shared/types';

export function $(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

export function $$(sel: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(sel);
}

export let atv_connected = false;
export let atv_credentials: ATVCredentials | false = false;
export let pairDevice = '';
export let connecting = false;

export const atv_events = new EventEmitter();

export function setAtvConnected(val: boolean): void {
  atv_connected = val;
}
export function setAtvCredentials(val: ATVCredentials | false): void {
  atv_credentials = val;
}
export function setPairDevice(val: string): void {
  pairDevice = val;
}
export function setConnecting(val: boolean): void {
  connecting = val;
}

// Electron @electron/remote modules (initialized at runtime via require)
export let nativeTheme: Electron.NativeTheme | null = null;
export let remote: typeof import('@electron/remote') | null = null;
export let mb: Menubar | null = null;
export let Menu: typeof Electron.Menu | null = null;

export function setRemoteModules(r: typeof import('@electron/remote'), nt: Electron.NativeTheme, m: Menubar | null, menu: typeof Electron.Menu): void {
  remote = r;
  nativeTheme = nt;
  mb = m;
  Menu = menu;
}
