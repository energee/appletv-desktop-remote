import type { ATVCredentials } from '../shared/types';

// Simple browser-compatible event emitter (no Node.js 'events' dependency)
class SimpleEventEmitter {
  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  on(event: string, fn: (...args: unknown[]) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  emit(event: string, ...args: unknown[]): void {
    const fns = this.listeners[event];
    if (fns) fns.forEach((fn) => fn(...args));
  }
}

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

export const atv_events = new SimpleEventEmitter();

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

export function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
