// Pairing requests from the webview to the sidecar. Connection state is not tracked here: the
// sidecar reports it as `state` events, which web_remote.ts renders.
import { desktopAPI } from '../shared/desktop-api';
import { safeParse, setPairDevice, pairDevice } from './state';
import { createDropdown, connectToATV, setStatus } from './web_remote';

export async function scanDevices(): Promise<void> {
  try {
    const results = (await desktopAPI.scan()) || [];
    createDropdown(results);
    if (results.length === 0) {
      setStatus('No Apple TV found on this network. Right-click to scan again.');
    }
  } catch (err) {
    createDropdown([]);
    setStatus(err instanceof Error ? err.message : 'Unable to scan for Apple TVs.');
  }
}

export function startPair(dev: string): void {
  setPairDevice(dev);
  desktopAPI.startPair(dev).catch((err: unknown) => {
    setStatus(err instanceof Error ? err.message : 'Unable to start pairing.');
  });
}

// One PIN pairs the Apple TV; save the credentials and connect, which ends pairing. A session
// takes one PIN, right or wrong, so a failure starts a new one and the TV shows a new PIN.
export async function finishPair(code: string): Promise<void> {
  try {
    const result = await desktopAPI.finishPair(code);
    // Cancelled while the TV checked the code; the remote has moved on.
    if (!result) return;
    saveRemote(pairDevice, result);
    localStorage.setItem('atvcreds', JSON.stringify(result));
    connectToATV();
  } catch (err) {
    console.error('Pairing failed:', err);
    setStatus("That code didn't work. Enter the new code shown on your Apple TV.");
    startPair(pairDevice);
  }
}

function saveRemote(name: string, creds: unknown): void {
  const ar = safeParse(localStorage.getItem('remote_credentials'), {} as Record<string, unknown>);
  let c = creds;
  if (typeof c === 'string') c = JSON.parse(c);
  ar[name] = c;
  localStorage.setItem('remote_credentials', JSON.stringify(ar));
}
