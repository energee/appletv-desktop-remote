// The renderer only displays the sidecar's connection state and forwards user actions; these
// tests drive it with `state` events and check the screen, status text, and requests sent.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackState, type ConnectionState, type NowPlayingInfo } from '../../src/shared/types';
import { icon } from '../../src/renderer/icons';

const desktopAPI = {
  connect: vi.fn(),
  reconnect: vi.fn(),
  disconnect: vi.fn(),
  scan: vi.fn(),
  sendKey: vi.fn(),
  seek: vi.fn(),
  startPair: vi.fn(),
  finishPair: vi.fn(),
  showContextMenu: vi.fn(),
  showWindow: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  importCredentials: vi.fn(),
  onAtvState: vi.fn(),
  onAtvNowPlaying: vi.fn(),
  onBackendLost: vi.fn(),
  onShortcutWin: vi.fn(),
  onPowerResume: vi.fn(),
  onScrollGestureBegan: vi.fn(() => () => {}),
  onErrorMessage: vi.fn(),
  onContextMenuAction: vi.fn(),
};

vi.mock('../../src/shared/desktop-api', () => ({ desktopAPI }));

const mockElement = {
  style: { display: '' },
  innerHTML: '',
  textContent: '',
  value: '',
  classList: { add: vi.fn(), remove: vi.fn() },
  firstChild: { textContent: '' },
  appendChild: vi.fn(),
  addEventListener: vi.fn(),
};
const statusElement = { textContent: '', style: { display: '' } };
const defaultQuery = (selector: string) =>
  selector === '#statusText' ? statusElement : mockElement;

vi.stubGlobal('window', {
  ...globalThis.window,
  addEventListener: vi.fn(),
  location: { reload: vi.fn() },
  matchMedia: vi.fn(() => ({ matches: false, addEventListener: vi.fn() })),
});
const documentStub = {
  querySelector: vi.fn(defaultQuery),
  createElement: vi.fn(() => ({ ...mockElement, style: { display: '' } })),
  querySelectorAll: vi.fn().mockReturnValue([]),
  getElementById: vi.fn(() => mockElement),
  addEventListener: vi.fn(),
  body: mockElement,
  activeElement: null as unknown,
};
vi.stubGlobal('document', documentStub);
const storage = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};
vi.stubGlobal('localStorage', storage);

function fakeElement(value = '') {
  return {
    style: { display: '' },
    innerHTML: '',
    textContent: '',
    value,
    checked: false,
    classList: { add: vi.fn(), remove: vi.fn() },
    firstChild: { textContent: '' },
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
    querySelectorAll: vi.fn(() => []),
  };
}

/** Gives each selector its own element (and the theme radios), so tests can read UI state. */
function useElements() {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const radios = ['systemmode', 'darkmode', 'lightmode'].map(fakeElement);
  const get = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector)!;
  };
  vi.mocked(document.querySelector).mockImplementation(
    (selector: string) => (selector === '#statusText' ? statusElement : get(selector)) as never,
  );
  vi.mocked(document.querySelectorAll).mockImplementation(
    (selector: string) => (selector.includes('name="theme"') ? radios : []) as never,
  );
  vi.mocked(document.getElementById).mockImplementation((id: string) => get(`#${id}`) as never);
  const listener = (selector: string, event: string) =>
    get(selector).addEventListener.mock.calls.find(([name]) => name === event)![1] as () => void;
  return { get, radios, listener };
}

/** Backs the localStorage mock with a map, so values the renderer writes can be read back. */
function useStorage(values: Record<string, string>) {
  const store = new Map(Object.entries(values));
  storage.getItem.mockImplementation((key: string) => store.get(key) ?? null);
  storage.setItem.mockImplementation((key: string, value: string) => void store.set(key, value));
  storage.removeItem.mockImplementation((key: string) => void store.delete(key));
}

let remote: typeof import('../../src/renderer/atv_remote');
let web: typeof import('../../src/renderer/web_remote');
let keydown: (event: unknown) => void;
let setState: (state: ConnectionState) => void;
let nowPlaying: (info: NowPlayingInfo) => void;
let powerResume: () => void;
let backendLost: () => void;
let contextMenuAction: (action: string, payload?: string) => void;

const creds = { credentials: 'c', identifier: 'tv' };
const other = { credentials: 'o', identifier: 'tv2' };
const state = (status: ConnectionState['status']) => setState({ status });
const press = (key: string) =>
  keydown({ key, getModifierState: () => false, preventDefault: vi.fn() });

beforeAll(async () => {
  // Import after webview globals are installed; this module registers browser listeners at load time.
  remote = await import('../../src/renderer/atv_remote');
  web = await import('../../src/renderer/web_remote');
  keydown = vi
    .mocked(window.addEventListener)
    .mock.calls.find(([name]) => name === 'keydown')![1] as (event: unknown) => void;
  web.initIPC();
  setState = desktopAPI.onAtvState.mock.calls[0][0];
  nowPlaying = desktopAPI.onAtvNowPlaying.mock.calls[0][0];
  powerResume = desktopAPI.onPowerResume.mock.calls[0][0];
  backendLost = desktopAPI.onBackendLost.mock.calls[0][0];
  contextMenuAction = desktopAPI.onContextMenuAction.mock.calls[0][0];
});

beforeEach(() => {
  vi.clearAllMocks();
  statusElement.textContent = '';
  statusElement.style.display = '';
  documentStub.activeElement = null;
  useStorage({ atvcreds: JSON.stringify(creds) });
  for (const request of [
    desktopAPI.connect,
    desktopAPI.reconnect,
    desktopAPI.disconnect,
    desktopAPI.sendKey,
    desktopAPI.seek,
    desktopAPI.startPair,
    desktopAPI.showContextMenu,
  ]) {
    request.mockResolvedValue(undefined);
  }
  desktopAPI.scan.mockResolvedValue([]);
});

afterEach(() => {
  vi.mocked(document.querySelector).mockImplementation(defaultQuery as never);
  vi.mocked(document.querySelectorAll).mockImplementation(() => [] as never);
  vi.mocked(document.getElementById).mockImplementation(() => mockElement as never);
  // Leave the remote idle for the next test.
  state('idle');
});

it('keeps discovery failures visible after rebuilding the device picker', async () => {
  desktopAPI.scan.mockRejectedValue(new Error('Network unavailable'));
  await remote.scanDevices();
  expect(statusElement.textContent).toBe('Network unavailable');
  expect(statusElement.style.display).toBe('block');
});

describe('screens', () => {
  it('shows the pairing screen while pairing and the remote otherwise', () => {
    const dom = useElements();
    state('pairing');
    expect(dom.get('#addNewElements').style.display).toBe('');
    expect(dom.get('#runningElements').style.display).toBe('none');

    state('connected');
    expect(dom.get('#addNewElements').style.display).toBe('none');
    expect(dom.get('#runningElements').style.display).toBe('');
    expect(dom.get('#touchpad').style.display).toBe('flex');
  });

  it('keeps the settings panel in front when the state changes', async () => {
    const dom = useElements();
    await web.init();
    contextMenuAction('openSettings');
    for (const status of ['connecting', 'connected', 'disconnected', 'pairing'] as const) {
      state(status);
      expect(dom.get('#settingsPanel').style.display).toBe('block');
      expect(dom.get('#runningElements').style.display).toBe('none');
      expect(dom.get('#addNewElements').style.display).toBe('none');
    }
    // Leaving Settings shows the screen for the latest state.
    dom.listener('#settingsBackBtn', 'click')();
    expect(dom.get('#addNewElements').style.display).toBe('');
    expect(dom.get('#runningElements').style.display).toBe('none');
  });
});

describe('two-finger swipe', () => {
  afterEach(() => vi.useRealTimers());

  /** Scroll events every 16 ms, as a trackpad sends them, including momentum after lifting. */
  function scroll(wheel: (event: unknown) => void, count: number, deltaX: number): void {
    for (let i = 0; i < count; i++) {
      wheel({ deltaX, deltaY: 0, preventDefault: vi.fn() });
      vi.advanceTimersByTime(16);
    }
  }

  it('moves once per gesture, however long its momentum lasts', () => {
    vi.useFakeTimers();
    const dom = useElements();
    state('connected');
    const wheel = dom.listener('#touchpad', 'wheel') as (event: unknown) => void;

    // About 0.8 s of scrolling: the swipe, then momentum tailing off.
    scroll(wheel, 20, 30);
    scroll(wheel, 30, 4);
    expect(desktopAPI.sendKey.mock.calls).toEqual([['left']]);

    // Once the events stop, the next swipe moves again.
    vi.advanceTimersByTime(200);
    scroll(wheel, 5, 30);
    expect(desktopAPI.sendKey.mock.calls).toEqual([['left'], ['left']]);
  });

  // macOS reports when fingers start a new gesture, so a swipe during the last one's momentum
  // moves at once.
  it('moves again as soon as the fingers start a new gesture', () => {
    vi.useFakeTimers();
    const dom = useElements();
    state('connected');
    const wheel = dom.listener('#touchpad', 'wheel') as (event: unknown) => void;
    const gestureBegan = desktopAPI.onScrollGestureBegan.mock.lastCall![0] as () => void;

    scroll(wheel, 20, 30);
    gestureBegan();
    scroll(wheel, 5, -30);
    expect(desktopAPI.sendKey.mock.calls).toEqual([['left'], ['right']]);
  });
});

describe('keys', () => {
  // Bug (a): a connect that settled during pairing used to make Enter send Select.
  it('Enter in the PIN field submits the PIN while pairing, even right after a connection', () => {
    const dom = useElements();
    desktopAPI.finishPair.mockReturnValue(new Promise(() => {}));
    state('connected');
    state('pairing');
    documentStub.activeElement = dom.get('#pairCode');
    dom.get('#pairCode').value = '1234';

    press('Enter');

    expect(desktopAPI.finishPair).toHaveBeenCalledWith('1234');
    expect(desktopAPI.sendKey).not.toHaveBeenCalled();
    // Pairing closed the old connection; that is not a reconnect.
    expect(statusElement.textContent).not.toBe('Reconnecting...');
  });

  it('sends keys only while connected', async () => {
    useElements();
    state('connecting');
    press('Enter');
    expect(desktopAPI.sendKey).not.toHaveBeenCalled();

    state('connected');
    press('Enter');
    expect(desktopAPI.sendKey).toHaveBeenCalledWith('select');
  });
});

describe('play button', () => {
  it('shows pause while playing, and play when paused or not connected', () => {
    const dom = useElements();
    const button = dom.get('#playPauseIcon');
    state('connected');

    nowPlaying({ title: 'Movie', playbackState: PlaybackState.Playing });
    expect(button.innerHTML).toBe(icon('pause'));
    nowPlaying({ title: 'Movie', playbackState: PlaybackState.Paused });
    expect(button.innerHTML).toBe(icon('play'));

    // Without a title the now-playing panel hides, but the button still follows the state.
    nowPlaying({ playbackState: PlaybackState.Playing });
    expect(button.innerHTML).toBe(icon('pause'));
    state('connecting');
    expect(button.innerHTML).toBe(icon('play'));
  });

  // After a press the TV repeats its old state for a moment, so the icon flips at once.
  it('flips at once on a press and ignores the stale report that follows', async () => {
    const dom = useElements();
    const button = dom.get('#playPauseIcon');
    state('connected');
    nowPlaying({ title: 'Movie', playbackState: PlaybackState.Paused });

    await web.sendCommand('Space');
    expect(button.innerHTML).toBe(icon('pause'));
    nowPlaying({ title: 'Movie', playbackState: PlaybackState.Paused });
    expect(button.innerHTML).toBe(icon('pause'));
    nowPlaying({ title: 'Movie', playbackState: PlaybackState.Playing });
    expect(button.innerHTML).toBe(icon('pause'));
  });

  it('goes back to the reported state when a press changed nothing', async () => {
    vi.useFakeTimers();
    try {
      const dom = useElements();
      const button = dom.get('#playPauseIcon');
      state('connected');
      nowPlaying({ title: 'Movie', playbackState: PlaybackState.Paused });

      await web.sendCommand('Space');
      nowPlaying({ title: 'Movie', playbackState: PlaybackState.Paused });
      expect(button.innerHTML).toBe(icon('pause'));
      vi.advanceTimersByTime(3000);
      expect(button.innerHTML).toBe(icon('play'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('seek bar', () => {
  /** The TV's clock for `ms` since the Unix epoch: seconds since 2001-01-01, as MRP sends it. */
  const tvTime = (ms: number) => ms / 1000 - 978307200;
  const NOW = Date.UTC(2026, 9, 29, 12);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('shows the position, counting on from when the TV reported it while playing', () => {
    const dom = useElements();
    state('connected');
    nowPlaying({
      title: 'Movie',
      playbackState: PlaybackState.Playing,
      duration: 600,
      elapsedTime: 60,
      playbackRate: 1,
      timestamp: tvTime(NOW - 5000),
    });

    expect(dom.get('#seek').style.display).toBe('');
    expect(dom.get('#seekBar').max).toBe('600');
    expect(dom.get('#seekBar').value).toBe('65');
    // The played part of the track is drawn as a background sized to the position.
    expect(dom.get('#seekBar').style.backgroundSize).toBe('10.8% 100%, 100% 100%');
    expect(dom.get('#npElapsed').textContent).toBe('1:05');
    expect(dom.get('#npDuration').textContent).toBe('10:00');
  });

  it('stays put while paused, and hides without a duration', () => {
    const dom = useElements();
    state('connected');
    const paused = { title: 'Movie', playbackState: PlaybackState.Paused, elapsedTime: 3725 };
    // The TV can still report rate 1 just after pausing.
    nowPlaying({ ...paused, duration: 7200, playbackRate: 1, timestamp: tvTime(NOW - 5000) });
    expect(dom.get('#npElapsed').textContent).toBe('1:02:05');

    nowPlaying({ title: 'Live', playbackState: PlaybackState.Playing });
    expect(dom.get('#seek').style.display).toBe('none');
  });

  it('seeks to where the bar is dropped', async () => {
    const dom = useElements();
    await web.init();
    state('connected');
    dom.get('#seekBar').value = '120';
    dom.listener('#seekBar', 'change')();
    expect(desktopAPI.seek).toHaveBeenCalledWith(120);
  });
});

describe('status text', () => {
  it('describes connecting, reconnecting, and giving up', () => {
    useElements();
    state('connecting');
    expect(statusElement.textContent).toBe('Connecting to ATV...');
    state('connected');
    expect(statusElement.style.display).toBe('none');
    state('connecting');
    expect(statusElement.textContent).toBe('Reconnecting...');
    // A retry reports connecting again; the text stays.
    statusElement.textContent = 'Reconnecting...';
    state('connecting');
    expect(statusElement.textContent).toBe('Reconnecting...');
    state('disconnected');
    expect(statusElement.textContent).toBe('Connection lost. Right-click to reconnect.');
  });

  it('shows why a connect request failed', async () => {
    desktopAPI.connect.mockRejectedValue(new Error('Cannot start Apple TV backend: missing'));
    web.connectToATV();
    await vi.waitFor(() =>
      expect(statusElement.textContent).toBe('Cannot start Apple TV backend: missing'),
    );
  });
});

describe('requests', () => {
  it('connects to the saved device at startup', async () => {
    useElements();
    await web.init();
    expect(desktopAPI.connect).toHaveBeenCalledWith(creds);
    expect(desktopAPI.scan).not.toHaveBeenCalled();
  });

  it('scans for pairing at startup without a saved device', async () => {
    useElements();
    useStorage({});
    await web.init();
    expect(desktopAPI.connect).not.toHaveBeenCalled();
    expect(desktopAPI.scan).toHaveBeenCalled();
  });

  it('asks the sidecar to reconnect the saved device on wake and after a backend restart', () => {
    powerResume();
    backendLost();
    expect(desktopAPI.reconnect.mock.calls).toEqual([[creds], [creds]]);
    expect(desktopAPI.connect).not.toHaveBeenCalled();
  });

  it('connects to a device picked from the menu', () => {
    useElements();
    useStorage({
      atvcreds: JSON.stringify(creds),
      remote_credentials: JSON.stringify({ 'Living Room': creds, Bedroom: other }),
    });
    contextMenuAction('selectDevice', 'Bedroom');
    expect(desktopAPI.connect).toHaveBeenCalledWith(other);
    expect(storage.getItem('atvcreds')).toBe(JSON.stringify(other));
  });

  it('re-pairs the current device: scans, then connects with the new credentials', async () => {
    useElements();
    const repaired = { credentials: 'new', identifier: 'tv' };
    contextMenuAction('repairCurrent');
    expect(desktopAPI.scan).toHaveBeenCalled();
    expect(storage.getItem('atvcreds')).toBeNull();

    remote.startPair('Living Room (1.2.3.4)');
    desktopAPI.finishPair.mockResolvedValue(repaired);
    await remote.finishPair('1234');

    expect(desktopAPI.connect).toHaveBeenCalledWith(repaired);
    expect(JSON.parse(storage.getItem('remote_credentials'))).toEqual({
      'Living Room (1.2.3.4)': repaired,
    });
  });

  it('sends every saved device to the menu with a string identifier', () => {
    // Older releases stored some devices as JSON strings, which have no identifier property.
    useStorage({ remote_credentials: JSON.stringify({ Old: JSON.stringify(creds) }) });
    contextMenuAction('setTheme', 'darkmode');
    expect(desktopAPI.showContextMenu).toHaveBeenLastCalledWith(
      {
        devices: [{ label: 'Old', identifier: '', checked: false }],
        uiMode: 'darkmode',
        alwaysOnTop: false,
      },
      false,
    );
  });

  it('applies imported settings to the tray menu and the settings panel', async () => {
    const dom = useElements();
    await web.init();
    desktopAPI.showContextMenu.mockClear();
    desktopAPI.connect.mockClear();
    desktopAPI.importCredentials.mockResolvedValue(
      JSON.stringify({
        version: 1,
        atvcreds: null,
        remote_credentials: JSON.stringify({ 'Living Room': creds }),
        uimode: 'darkmode',
        alwaysOnTopChecked: 'true',
      }),
    );

    dom.listener('#settingsImportCredentialsBtn', 'click')();
    await vi.waitFor(() => expect(desktopAPI.disconnect).toHaveBeenCalled());

    expect(desktopAPI.connect).not.toHaveBeenCalled();
    expect(desktopAPI.showContextMenu).toHaveBeenLastCalledWith(
      {
        devices: [{ label: 'Living Room', identifier: 'tv', checked: false }],
        uiMode: 'darkmode',
        alwaysOnTop: true,
      },
      false,
    );
    expect(dom.radios.map((radio) => radio.checked)).toEqual([false, true, false]);
    expect(dom.get('#settingsAlwaysOnTop').checked).toBe(true);
  });

  it('reconnects with imported credentials', async () => {
    const dom = useElements();
    await web.init();
    desktopAPI.connect.mockClear();
    desktopAPI.importCredentials.mockResolvedValue(
      JSON.stringify({
        version: 1,
        atvcreds: JSON.stringify(other),
        remote_credentials: JSON.stringify({ Bedroom: other }),
      }),
    );

    dom.listener('#settingsImportCredentialsBtn', 'click')();
    await vi.waitFor(() => expect(desktopAPI.connect).toHaveBeenCalledWith(other));
    expect(desktopAPI.disconnect).not.toHaveBeenCalled();
  });

  it('does not reconnect on window focus, matching the Electron release', async () => {
    await web.init();
    const windowEvents = vi.mocked(window.addEventListener).mock.calls.map(([name]) => name);
    expect(windowEvents).not.toContain('focus');
    expect(windowEvents).not.toContain('pageshow');
    const documentEvents = vi.mocked(document.addEventListener).mock.calls.map(([name]) => name);
    expect(documentEvents).not.toContain('visibilitychange');
  });
});
