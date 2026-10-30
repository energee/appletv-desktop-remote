// Renderer helpers and nonsecret saved-device metadata. Credentials remain in the native vault.
import { desktopAPI } from '../shared/desktop-api';
import type { SavedDevice } from '../shared/types';

let devices: Record<string, SavedDevice> = {};
let activeIdentifier: string | null = null;

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

function cache(saved: SavedDevice[], active: string | null): void {
  devices = Object.fromEntries(saved.map((device) => [device.identifier, device]));
  activeIdentifier = active && devices[active] ? active : null;
}

/** Migrates legacy renderer credentials once, then loads metadata from the native vault. */
export async function initializeDevices(): Promise<void> {
  const legacy = {
    devices: localStorage.getItem('remote_credentials'),
    active: localStorage.getItem('atvcreds'),
  };
  if (legacy.devices !== null || legacy.active !== null) {
    await desktopAPI.migrateDevices(legacy);
    // Native acknowledgement means every valid pairing is now secure. Never delete before it.
    localStorage.removeItem('remote_credentials');
    localStorage.removeItem('atvcreds');
  }
  await refreshDevices();
}

/** Synchronous cache for render/event paths after initializeDevices has resolved. */
export function loadDevices(): Record<string, SavedDevice> {
  return devices;
}

export function loadActiveDevice(): SavedDevice | null {
  return activeIdentifier ? (devices[activeIdentifier] ?? null) : null;
}

export async function saveActiveDevice(device: SavedDevice | null): Promise<void> {
  await desktopAPI.selectDevice(device?.identifier ?? null);
  activeIdentifier = device?.identifier ?? null;
}

export async function removeDevice(identifier: string): Promise<void> {
  await desktopAPI.removeDevice(identifier);
  delete devices[identifier];
  if (activeIdentifier === identifier) activeIdentifier = null;
}

export async function refreshDevices(): Promise<void> {
  const [saved, active] = await Promise.all([desktopAPI.loadDevices(), desktopAPI.activeDevice()]);
  cache(saved, active);
}
