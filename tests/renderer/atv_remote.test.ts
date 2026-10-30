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
  togglePower: vi.fn(),
  seek: vi.fn(),
  startPair: vi.fn(),
  finishPair: vi.fn(),
  showContextMenu: vi.fn(),
  showWindow: vi.fn(),
  quit: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  setWindowTheme: vi.fn(),
  importCredentials: vi.fn(),
  onAtvState: vi.fn(),
  onAtvNowPlaying: vi.fn(),
  onAtvPowerState: vi.fn(),
  onAtvVolume: vi.fn(),
  onAtvOutputs: vi.fn(),
  speakers: vi.fn(),
  setSpeaker: vi.fn(),
  setVolume: vi.fn(),
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

class ButtonElement {}
vi.stubGlobal('HTMLButtonElement', ButtonElement);

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
    disabled: false,
    classList: { add: vi.fn(), remove: vi.fn() },
    firstChild: { textContent: '' },
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
    focus: vi.fn(),
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
let powerState: (state: 'on' | 'off' | 'unknown') => void;
let volume: (level: number | null) => void;
let outputs: (ids: string[]) => void;
let powerResume: () => void;
let backendLost: () => void;
let contextMenuAction: (action: string, payload?: string) => void;
let errorMessage: (message: string) => void;
let focus: () => void;

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
  focus = vi
    .mocked(window.addEventListener)
    .mock.calls.find(([name]) => name === 'focus')?.[1] as () => void;
  web.initIPC();
  setState = desktopAPI.onAtvState.mock.calls[0][0];
  nowPlaying = desktopAPI.onAtvNowPlaying.mock.calls[0][0];
  powerState = desktopAPI.onAtvPowerState.mock.calls[0][0];
  volume = desktopAPI.onAtvVolume.mock.calls[0][0];
  outputs = desktopAPI.onAtvOutputs.mock.calls[0][0];
  powerResume = desktopAPI.onPowerResume.mock.calls[0][0];
  backendLost = desktopAPI.onBackendLost.mock.calls[0][0];
  contextMenuAction = desktopAPI.onContextMenuAction.mock.calls[0][0];
  errorMessage = desktopAPI.onErrorMessage.mock.calls[0][0];
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
  desktopAPI.speakers.mockResolvedValue([]);
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

it('says so when the scan finds no Apple TV, instead of an empty picker', async () => {
  desktopAPI.scan.mockResolvedValue([]);
  await remote.scanDevices();
  expect(statusElement.textContent).toBe(
    'No Apple TV found on this network. Right-click to scan again.',
  );
  expect(statusElement.style.display).toBe('block');
});

describe('window appearance', () => {
  // A pinned appearance also pins the webview's prefers-color-scheme, so "Follow system" must
  // hand the window back to the system or the remote stops following it.
  it('pins the window only for an explicit Light or Dark choice', async () => {
    for (const [uimode, theme] of [
      ['systemmode', null],
      ['darkmode', 'dark'],
      ['lightmode', 'light'],
    ] as const) {
      useStorage({ atvcreds: JSON.stringify(creds), uimode });
      useElements();
      await web.init();
      expect(desktopAPI.setWindowTheme).toHaveBeenLastCalledWith(theme);
    }
  });
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

describe('remote', () => {
  afterEach(() => vi.useRealTimers());

  // Holding the touchpad selects after a second; dragging off it first means "never mind".
  it('selects nothing when a press leaves the touchpad', () => {
    vi.useFakeTimers();
    const dom = useElements();
    state('connected');
    (dom.listener('#touchpad', 'mousedown') as (event: unknown) => void)({
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    dom.listener('#touchpad', 'mouseleave')();
    vi.advanceTimersByTime(1000);
    expect(desktopAPI.sendKey).not.toHaveBeenCalled();
  });

  // A right-click opens the context menu, which takes the mouseup, so the long-press timer
  // that mousedown started used to fire a second later and press the key.
  it('sends nothing for a right-click on the touchpad or a button', () => {
    vi.useFakeTimers();
    const dom = useElements();
    const button = { ...fakeElement(), dataset: { key: 'home' } };
    vi.mocked(document.querySelectorAll).mockImplementation(
      (selector: string) => (selector === '[data-key]' ? [button] : []) as never,
    );
    state('connected');
    const rightClick = { button: 2, clientX: 10, clientY: 10 };
    (dom.listener('#touchpad', 'mousedown') as (event: unknown) => void)(rightClick);
    (
      button.addEventListener.mock.calls.find(([name]) => name === 'mousedown')![1] as (
        event: unknown,
      ) => void
    )(rightClick);
    vi.advanceTimersByTime(1000);
    expect(desktopAPI.sendKey).not.toHaveBeenCalled();
  });

  // A held press: Select opens tvOS context menus, Home opens Control Center.
  it('holds the key after a long press on the touchpad or a button', () => {
    vi.useFakeTimers();
    const dom = useElements();
    const button = { ...fakeElement(), dataset: { key: 'home' } };
    vi.mocked(document.querySelectorAll).mockImplementation(
      (selector: string) => (selector === '[data-key]' ? [button] : []) as never,
    );
    state('connected');
    const press = { button: 0, clientX: 10, clientY: 10 };
    (dom.listener('#touchpad', 'mousedown') as (event: unknown) => void)(press);
    vi.advanceTimersByTime(1000);
    (
      button.addEventListener.mock.calls.find(([name]) => name === 'mousedown')![1] as (
        event: unknown,
      ) => void
    )(press);
    vi.advanceTimersByTime(1000);
    expect(desktopAPI.sendKey.mock.calls).toEqual([
      ['select', true],
      ['home', true],
    ]);
  });

  // The hint is for a new user at launch; after a wake the window is usually hidden.
  it('shows the keyboard hint once per launch, not after every reconnect', () => {
    useElements();
    for (const status of ['connected', 'connecting', 'connected'] as const) state(status);
    const hints = storage.setItem.mock.calls.filter(([key]) => key === 'kbHintCount');
    expect(hints.length).toBeLessThanOrEqual(1);
  });

  // A connection that survives an error needs no message; one that drops says Reconnecting.
  it('keeps device errors off the remote while it is connected', () => {
    useElements();
    state('connected');
    errorMessage('read ECONNRESET');
    expect(statusElement.textContent).not.toBe('read ECONNRESET');

    state('connecting');
    errorMessage('connect ECONNREFUSED');
    expect(statusElement.textContent).toBe('connect ECONNREFUSED');
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
    expect(desktopAPI.sendKey.mock.calls).toEqual([['left', false]]);

    // Once the events stop, the next swipe moves again.
    vi.advanceTimersByTime(200);
    scroll(wheel, 5, 30);
    expect(desktopAPI.sendKey.mock.calls).toEqual([
      ['left', false],
      ['left', false],
    ]);
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
    expect(desktopAPI.sendKey.mock.calls).toEqual([
      ['left', false],
      ['right', false],
    ]);
  });
});

describe('keys', () => {
  it('leaves focused-button activation to the browser without sending TV commands', () => {
    useElements();
    state('connected');
    const preventDefault = vi.fn();
    const target = new ButtonElement();

    for (const key of ['Enter', ' ']) {
      keydown({ key, target, getModifierState: () => false, preventDefault });
    }

    expect(desktopAPI.sendKey).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    keydown({ key: 'ArrowUp', target, getModifierState: () => false, preventDefault });
    expect(desktopAPI.sendKey.mock.calls).toEqual([['up']]);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  // Bug (a): a connect that settled during pairing used to make Enter send Select.
  it('Enter in the PIN boxes sends nothing while pairing, even right after a connection', () => {
    const dom = useElements();
    state('connected');
    state('pairing');
    documentStub.activeElement = dom.get('#pairCode');
    dom.get('#pairCode').value = '1234';

    press('Enter');

    expect(desktopAPI.sendKey).not.toHaveBeenCalled();
    // Pairing closed the old connection; that is not a reconnect.
    expect(statusElement.textContent).not.toBe('Reconnecting...');
  });

  // Holding Space must not toggle play/pause over and over, nor holding Q quit the app.
  it('repeats a held key only for moving and volume', () => {
    useElements();
    state('connected');
    const hold = (key: string) =>
      keydown({ key, repeat: true, getModifierState: () => false, preventDefault: vi.fn() });
    for (const key of ['ArrowUp', '+', ' ', 'Enter', 'q', 'q', 'q']) hold(key);
    expect(desktopAPI.sendKey.mock.calls).toEqual([
      ['up', false],
      ['volume_up', false],
    ]);
    expect(desktopAPI.quit).not.toHaveBeenCalled();
  });

  it('sends keys only while connected', async () => {
    useElements();
    state('connecting');
    press('Enter');
    expect(desktopAPI.sendKey).not.toHaveBeenCalled();

    state('connected');
    press('Enter');
    expect(desktopAPI.sendKey).toHaveBeenCalledWith('select', false);
  });
});

describe('PIN entry', () => {
  /** Opens the PIN boxes for a picked device, as choosing it in the device picker does. */
  async function openPin() {
    const dom = useElements();
    await web.init();
    state('pairing');
    web.createDropdown(['Living Room (1.2.3.4)']);
    const picker = dom.get('#atv_picker') as ReturnType<typeof dom.get> & { onchange(): void };
    picker.value = 'Living Room (1.2.3.4)';
    picker.onchange();
    const pin = dom.get('#pairCode');
    const type = (value: string) => {
      pin.value = value;
      dom.listener('#pairCode', 'input')();
    };
    return { pin, type };
  }

  it('focuses the boxes when they open and submits the fourth digit', async () => {
    const { pin, type } = await openPin();
    expect(pin.focus).toHaveBeenCalled();
    desktopAPI.finishPair.mockReturnValue(new Promise(() => {}));

    type('12a3');
    expect(pin.value).toBe('123');
    expect(desktopAPI.finishPair).not.toHaveBeenCalled();

    type('1234');
    expect(desktopAPI.finishPair).toHaveBeenCalledWith('1234');
    // Locked while the TV checks the code, so typing cannot submit it twice.
    expect(pin.disabled).toBe(true);
  });

  // A pairing session takes one PIN, right or wrong, so the user needs a new one on the TV.
  it('starts over after a wrong code, so the TV shows a new one', async () => {
    const { pin, type } = await openPin();
    desktopAPI.finishPair.mockRejectedValue(new Error('M4 missing Proof (error=2)'));
    pin.focus.mockClear();

    type('0000');
    await vi.waitFor(() => expect(desktopAPI.startPair).toHaveBeenCalledTimes(2));

    expect(desktopAPI.startPair).toHaveBeenLastCalledWith('Living Room (1.2.3.4)');
    expect(statusElement.textContent).toBe(
      "That code didn't work. Enter the new code shown on your Apple TV.",
    );
    expect(pin.value).toBe('');
    expect(pin.disabled).toBe(false);
    expect(pin.focus).toHaveBeenCalled();
  });

  // The sidecar answers null when Cancel ended pairing while the TV checked the code.
  it('ignores a code checked after pairing was cancelled', async () => {
    const { pin, type } = await openPin();
    desktopAPI.finishPair.mockResolvedValue(null);

    type('1234');
    await vi.waitFor(() => expect(pin.disabled).toBe(false));

    expect(storage.getItem('remote_credentials')).toBeNull();
    expect(desktopAPI.startPair).toHaveBeenCalledTimes(1);
  });

  // Cancel used to reload the whole window, which flashed "Starting up...".
  it('Cancel goes back to the saved device, or scans again without one', async () => {
    const dom = useElements();
    await web.init();
    desktopAPI.connect.mockClear();
    state('pairing');
    dom.listener('#cancelPairing', 'click')();
    expect(desktopAPI.connect).toHaveBeenCalledWith(creds);

    useStorage({});
    desktopAPI.scan.mockClear();
    dom.listener('#cancelPairing', 'click')();
    expect(desktopAPI.scan).toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});

describe('header', () => {
  it('sleeps or wakes the TV from the power button, shown only while connected', async () => {
    const dom = useElements();
    desktopAPI.togglePower.mockResolvedValue(undefined);
    await web.init();
    state('connecting');
    expect(dom.get('#powerButton').style.display).toBe('none');
    state('connected');
    expect(dom.get('#powerButton').style.display).toBe('');

    dom.listener('#powerButton', 'click')();
    expect(desktopAPI.togglePower).toHaveBeenCalledTimes(1);
  });

  // The TV keeps its connection while asleep, so the dot alone can't tell.
  it('says the TV is asleep while it is, and only while connected', () => {
    const dom = useElements();
    useStorage({
      atvcreds: JSON.stringify(creds),
      remote_credentials: JSON.stringify({ 'Living Room (1.2.3.4)': creds }),
    });
    const header = dom.get('#topTextHeader').firstChild;
    state('connected');
    expect(header.textContent).toBe('Living Room');

    powerState('off');
    expect(header.textContent).toBe('Living Room · Asleep');
    powerState('on');
    expect(header.textContent).toBe('Living Room');

    powerState('off');
    state('connecting');
    expect(header.textContent).toBe('Living Room');
    state('connected');
    expect(header.textContent).toBe('Living Room');
  });
});

describe('speakers', () => {
  it('lists AirPlay speakers in the menu once connected, and toggles the one picked', async () => {
    useElements();
    const kitchen = { id: 'psi-kitchen', name: 'Kitchen', selected: false };
    desktopAPI.speakers.mockResolvedValue([kitchen]);
    desktopAPI.setSpeaker.mockResolvedValue(undefined);
    const menuSpeakers = () => desktopAPI.showContextMenu.mock.lastCall![0].speakers;

    state('connected');
    await vi.waitFor(() =>
      expect(menuSpeakers()).toEqual([{ label: 'Kitchen', id: 'psi-kitchen', checked: false }]),
    );
    contextMenuAction('toggleSpeaker', 'psi-kitchen');
    expect(desktopAPI.setSpeaker).toHaveBeenCalledWith('psi-kitchen', true);

    // The TV confirms the new outputs; the menu follows without scanning again.
    outputs(['psi-kitchen']);
    expect(menuSpeakers()).toEqual([{ label: 'Kitchen', id: 'psi-kitchen', checked: true }]);
    contextMenuAction('toggleSpeaker', 'psi-kitchen');
    expect(desktopAPI.setSpeaker).toHaveBeenLastCalledWith('psi-kitchen', false);
    expect(desktopAPI.speakers).toHaveBeenCalledTimes(1);

    state('connecting');
    expect(menuSpeakers()).toEqual([]);
  });
});

describe('volume slider', () => {
  // TV speakers have no absolute volume; outputs such as AirPods or HomePod do.
  it('shows the absolute volume, hides without one, and sets it when released', async () => {
    const dom = useElements();
    desktopAPI.setVolume.mockResolvedValue(undefined);
    await web.init();
    const box = dom.get('#volume');
    const bar = dom.get('#volumeBar');
    state('connecting');
    state('connected');
    expect(box.style.display).toBe('none');

    volume(40);
    expect(box.style.display).toBe('');
    expect(bar.value).toBe('40');

    // While dragging, reports don't move the thumb; releasing sets the level.
    bar.value = '70';
    dom.listener('#volumeBar', 'input')();
    volume(45);
    expect(bar.value).toBe('70');
    dom.listener('#volumeBar', 'change')();
    expect(desktopAPI.setVolume).toHaveBeenCalledWith(70);

    volume(null);
    expect(box.style.display).toBe('none');
    volume(40);
    state('connecting');
    expect(box.style.display).toBe('none');
  });
});

describe('now playing', () => {
  it('names the app that is playing above the title', () => {
    const dom = useElements();
    state('connected');
    nowPlaying({ title: 'Movie', artist: 'Studio', appDisplayName: 'TV' });
    expect(dom.get('#npApp').textContent).toBe('TV');
    nowPlaying({ title: 'Movie' });
    expect(dom.get('#npApp').textContent).toBe('');
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
    // Kept until pairing succeeds, so Cancel goes back to it rather than the first saved device.
    expect(storage.getItem('atvcreds')).toBe(JSON.stringify(creds));

    remote.startPair('Living Room (1.2.3.4)');
    desktopAPI.finishPair.mockResolvedValue(repaired);
    await remote.finishPair('1234');

    expect(desktopAPI.connect).toHaveBeenCalledWith(repaired);
    expect(JSON.parse(storage.getItem('remote_credentials'))).toEqual({
      'Living Room (1.2.3.4)': repaired,
    });
  });

  it('disconnects the active device when it is removed in Settings', async () => {
    useElements();
    useStorage({
      atvcreds: JSON.stringify(creds),
      remote_credentials: JSON.stringify({ 'Living Room': creds }),
    });
    await web.init();
    contextMenuAction('openSettings');
    // The device row's Remove button, created by the settings panel.
    const remove = mockElement.addEventListener.mock.calls.find(
      ([name]) => name === 'click',
    )![1] as () => void;

    remove();

    expect(storage.getItem('atvcreds')).toBeNull();
    expect(desktopAPI.disconnect).toHaveBeenCalled();
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
        speakers: [],
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
    // No active device, so nothing is reconnecting.
    expect(statusElement.textContent).toBe('Credentials imported.');
    expect(desktopAPI.showContextMenu).toHaveBeenLastCalledWith(
      {
        devices: [{ label: 'Living Room', identifier: 'tv', checked: false }],
        uiMode: 'darkmode',
        alwaysOnTop: true,
        speakers: [],
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

  // Reconnecting replaces the connection, so focus must not do it while one is working.
  it('retries on window focus only after the sidecar gave up', () => {
    useStorage({ atvcreds: JSON.stringify(creds) });
    state('connected');
    focus();
    state('connecting');
    focus();
    expect(desktopAPI.reconnect).not.toHaveBeenCalled();

    state('disconnected');
    focus();
    expect(desktopAPI.reconnect).toHaveBeenCalledWith(creds);
  });
});
