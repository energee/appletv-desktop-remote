// Renderer helpers, saved-device storage, and the one piece of pairing state shared by
// web_remote.ts and atv_remote.ts. Connection state lives in the sidecar (ATVService);
// web_remote.ts renders its `state` events.
import type { ATVCredentials } from '../shared/types';

export function $(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

export function $$(sel: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(sel);
}

/** The scan label of the device being paired, under which finishPair saves its credentials. */
export let pairDevice = '';

export function setPairDevice(val: string): void {
  pairDevice = val;
}

export function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/** Parses stored JSON, which older releases sometimes encoded more than once; null if invalid. */
export function parseStored(json: string | null): unknown {
  let value: unknown = json;
  while (typeof value === 'string') value = safeParse<unknown>(value, null);
  return value;
}

/**
 * Saved Apple TVs by scan label ("Name (IP)"). Entries that older releases stored as JSON
 * strings are decoded and saved back once; entries that aren't objects are dropped.
 */
export function loadDevices(): Record<string, ATVCredentials> {
  const json = localStorage.getItem('remote_credentials');
  const stored = parseStored(json);
  const devices: Record<string, ATVCredentials> = {};
  if (typeof stored === 'object' && stored !== null) {
    for (const [name, value] of Object.entries(stored)) {
      const device = typeof value === 'string' ? parseStored(value) : value;
      if (typeof device === 'object' && device !== null) devices[name] = device as ATVCredentials;
    }
  }
  if (json !== null && JSON.stringify(devices) !== json) saveDevices(devices);
  return devices;
}

export function saveDevices(devices: Record<string, ATVCredentials>): void {
  localStorage.setItem('remote_credentials', JSON.stringify(devices));
}

/** The device the remote connects to (`atvcreds`), or null if none is chosen. */
export function loadActiveDevice(): ATVCredentials | null {
  const device = parseStored(localStorage.getItem('atvcreds'));
  return typeof device === 'object' && device !== null ? (device as ATVCredentials) : null;
}

/** Chooses the device to connect to; null forgets the choice. */
export function saveActiveDevice(device: ATVCredentials | null): void {
  if (device) localStorage.setItem('atvcreds', JSON.stringify(device));
  else localStorage.removeItem('atvcreds');
}
