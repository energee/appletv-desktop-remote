// Renderer helpers and the one piece of pairing state shared by web_remote.ts and atv_remote.ts.
// Connection state lives in the sidecar (ATVService); web_remote.ts renders its `state` events.

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
