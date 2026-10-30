// Renderer helpers: DOM queries, JSON parsing, and saved-device storage. Connection state lives
// in the sidecar (ATVService); web_remote.ts renders its `state` events.
import type { ATVCredentials, PairResult } from '../shared/types';

export function $(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

export function $$(sel: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(sel);
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
 * Saved Apple TVs by identifier. Older releases' entries are converted and saved back once:
 * those stored as JSON strings are decoded, and those keyed by scan label ("Name (IP)"), which
 * duplicated a TV whose IP changed, are rekeyed with the label's name (later, newer pairings
 * win). Entries that aren't objects are dropped.
 */
export function loadDevices(): Record<string, PairResult> {
  const json = localStorage.getItem('remote_credentials');
  const stored = parseStored(json);
  const devices: Record<string, PairResult> = {};
  if (typeof stored === 'object' && stored !== null) {
    for (const [key, value] of Object.entries(stored)) {
      const device = typeof value === 'string' ? parseStored(value) : value;
      if (typeof device !== 'object' || device === null) continue;
      const { identifier = key, name = key.replace(/\s*\([^()]*\)$/, '') } = device as PairResult;
      devices[identifier] = { ...(device as PairResult), identifier, name };
    }
  }
  if (json !== null && JSON.stringify(devices) !== json) saveDevices(devices);
  return devices;
}

export function saveDevices(devices: Record<string, PairResult>): void {
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
