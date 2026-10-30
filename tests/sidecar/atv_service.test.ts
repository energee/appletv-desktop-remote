// ATVService state machine: it alone owns the Apple TV connection (connect, backoff reconnect,
// device switching, wake, pairing), so stale work must never change state.
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { PlaybackState, type ConnectionState } from '../../src/shared/types';

const mockScan = vi.fn();
const mockConnect = vi.fn();
const mockStartPairing = vi.fn();
const mockSendKeyCommand = vi.fn();
const mockPairingSession = { finish: vi.fn() };
/** Every AppleTV the service created, in order, so tests can tell old devices from new. */
let devices: MockAppleTV[] = [];

class MockAppleTV extends EventEmitter {
  deviceId?: string;
  connect = vi.fn((credentials: unknown) => mockConnect(credentials));
  startPairing = vi.fn(() => mockStartPairing());
  sendKeyCommand = vi.fn((key: unknown) => mockSendKeyCommand(key));
  setPosition = vi.fn(async (_seconds: number) => {});
  close = vi.fn(async () => {});
  constructor(discovered: { deviceId?: string }) {
    super();
    this.deviceId = discovered.deviceId;
    devices.push(this);
  }
}

class MockCredentials {
  static constructorArgs: unknown[][] = [];
  constructor(...args: unknown[]) {
    MockCredentials.constructorArgs.push(args);
  }
  serialize() {
    return 'serialized-creds';
  }
  // Like credentials saved before single-PIN pairing, which include Companion keys.
  static deserialize(data: unknown) {
    return { companionCredentials: 'companion-creds', serialized: data };
  }
}

const mockHidKeyMap = { play_pause: { usagePage: 12, usage: 0xb0 } };
vi.mock('node-appletv-remote/dist/mrp/messages.js', () => ({ HID_KEY_MAP: mockHidKeyMap }));

vi.mock('node-appletv-remote', () => ({
  scan: (...args: unknown[]) => mockScan(...args),
  AppleTV: MockAppleTV,
  Credentials: MockCredentials,
  Key: {
    PlayPause: 0,
    Left: 1,
    Right: 2,
    Down: 3,
    Up: 4,
    Select: 5,
    Menu: 6,
    TopMenu: 7,
    Home: 8,
    HomeHold: 9,
    SkipBackward: 10,
    SkipForward: 11,
    VolumeUp: 12,
    VolumeDown: 13,
    Play: 14,
    Pause: 15,
  },
}));

const living = { name: 'Living Room', address: '1.2.3.4', port: 7000, deviceId: 'tv1' };
const bedroom = { name: 'Bedroom', address: '1.2.3.5', port: 7000, deviceId: 'tv2' };
const tv1 = { credentials: 'creds-1', identifier: 'tv1' };
const tv2 = { credentials: 'creds-2', identifier: 'tv2' };

/** Runs due timers and lets every pending promise continuation settle. */
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

let ATVService: typeof import('../../src/sidecar/atv_service').default;

beforeAll(async () => {
  ATVService = (await import('../../src/sidecar/atv_service')).default;
});

describe('ATVService', () => {
  let service: InstanceType<typeof ATVService>;
  let states: ConnectionState['status'][];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    devices = [];
    MockCredentials.constructorArgs = [];
    mockScan.mockResolvedValue([living, bedroom]);
    mockConnect.mockResolvedValue(undefined);
    mockStartPairing.mockResolvedValue(mockPairingSession);
    mockSendKeyCommand.mockResolvedValue(undefined);
    service = new ATVService();
    states = [];
    service.on('state', (state: ConnectionState) => states.push(state.status));
    service.on('error', () => {});
  });

  afterEach(async () => {
    await service.destroy();
    vi.useRealTimers();
  });

  async function connected(creds = tv1): Promise<MockAppleTV> {
    service.connect(creds);
    await flush();
    expect(service.state).toEqual({ status: 'connected' });
    return devices.at(-1)!;
  }

  describe('scan()', () => {
    it('returns formatted device labels and keeps them for pairing', async () => {
      await expect(service.scan(1000)).resolves.toEqual([
        'Living Room (1.2.3.4)',
        'Bedroom (1.2.3.5)',
      ]);
      expect(service.scanResults['Living Room (1.2.3.4)']).toBe(living);
    });

    // It listed every AirPlay device (Roku and other smart TVs, Macs), which can never pair.
    it('lists only Apple TVs, the only devices the remote can control', async () => {
      await service.scan();
      const [{ filter }] = mockScan.mock.calls[0];
      expect(filter({ model: 'AppleTV6,2' })).toBe(true);
      expect(filter({ model: 'AppleTV5,3' })).toBe(true);
      expect(filter({ model: '7104X' })).toBe(false); // TCL Roku TV
      expect(filter({ model: 'Mac16,12' })).toBe(false);
    });

    it('times out with a safety net', async () => {
      mockScan.mockReturnValue(new Promise(() => {}));
      const scanning = expect(service.scan(100)).rejects.toThrow('Scan timed out');
      await flush(2100);
      await scanning;
    });

    it('starts pairing mode: closes the connection and stops reconnecting', async () => {
      const device = await connected();
      await service.scan();

      expect(device.close).toHaveBeenCalledTimes(1);
      expect(service.state).toEqual({ status: 'pairing' });
      // The closed connection's own close event must not start a reconnect.
      device.emit('close');
      await flush(60_000);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(service.state).toEqual({ status: 'pairing' });
    });
  });

  describe('startPair()', () => {
    it('throws on an unknown device', async () => {
      await expect(service.startPair('Unknown Device')).rejects.toThrow('Device not found');
    });

    it('starts an AirPlay pairing session, listening for device errors first', async () => {
      await service.scan();
      await service.startPair('Living Room (1.2.3.4)');

      expect(service.pairingSession).toBe(mockPairingSession);
      // An unhandled EventEmitter 'error' would crash the sidecar process.
      const [device] = devices;
      expect(device.listenerCount('error')).toBe(1);
      expect(() => device.emit('error', new Error('socket'))).not.toThrow();
    });

    // Bugs (a) and (b): an older connect finishing during pairing must not mark the remote
    // connected (Enter would send Select) nor attach to the pairing device.
    it('ignores a connect that completes after pairing started, and closes its device', async () => {
      const pending = Promise.withResolvers<void>();
      mockConnect.mockReturnValueOnce(pending.promise);
      service.connect(tv1);
      await flush();
      const [stale] = devices;

      await service.scan();
      await service.startPair('Living Room (1.2.3.4)');
      pending.resolve();
      await flush();

      expect(stale.close).toHaveBeenCalled();
      expect(service.state).toEqual({ status: 'pairing' });
      expect(states).not.toContain('connected');
      const pairingDevice = devices[1];
      expect(service.device).toBe(pairingDevice);
      expect(pairingDevice.listenerCount('close')).toBe(0);
      await expect(service.sendKey('select')).rejects.toThrow('Not connected');
    });

    it('ignores a connect whose device scan finishes after pairing started', async () => {
      const scanning = Promise.withResolvers<(typeof living)[]>();
      mockScan.mockReturnValueOnce(scanning.promise);
      service.connect(tv1);
      await service.scan();
      scanning.resolve([living]);
      await flush();

      expect(devices).toHaveLength(0);
      expect(service.state).toEqual({ status: 'pairing' });
    });

    // The renderer starts pairing again after a wrong PIN; by then the user may have connected.
    it('is ignored once pairing has ended, so a late retry cannot end a connection', async () => {
      await service.scan();
      const device = await connected();
      await service.startPair('Living Room (1.2.3.4)');

      expect(service.state).toEqual({ status: 'connected' });
      expect(device.close).not.toHaveBeenCalled();
      expect(mockStartPairing).not.toHaveBeenCalled();
    });
  });

  describe('finishPair()', () => {
    it('returns AirPlay-only credentials after the one PIN', async () => {
      await service.scan();
      await service.startPair('Living Room (1.2.3.4)');
      mockPairingSession.finish.mockResolvedValue('airplay-creds');

      const result = await service.finishPair('1234');

      expect(result).toEqual({ credentials: 'serialized-creds', identifier: 'tv1' });
      expect(MockCredentials.constructorArgs).toEqual([['airplay-creds']]);
      expect(service.pairingSession).toBeNull();
      // Pairing mode lasts until the renderer connects with the new credentials.
      expect(service.state).toEqual({ status: 'pairing' });
    });

    // The library's finish() closes the session whether or not the PIN was right.
    it('forgets the session after a wrong PIN, and a new one can start', async () => {
      await service.scan();
      await service.startPair('Living Room (1.2.3.4)');
      mockPairingSession.finish.mockRejectedValue(new Error('M4 missing Proof (error=2)'));

      await expect(service.finishPair('0000')).rejects.toThrow('M4 missing Proof');
      expect(service.pairingSession).toBeNull();

      await service.startPair('Living Room (1.2.3.4)');
      expect(service.pairingSession).toBe(mockPairingSession);
      expect(mockStartPairing).toHaveBeenCalledTimes(2);
    });

    // Cancel connects to the saved device; a result arriving after that is nobody's concern.
    it('returns null, right PIN or wrong, once pairing was cancelled during the check', async () => {
      for (const settle of ['resolve', 'reject'] as const) {
        await service.scan();
        await service.startPair('Living Room (1.2.3.4)');
        const checking = Promise.withResolvers<unknown>();
        mockPairingSession.finish.mockReturnValueOnce(checking.promise);

        const result = service.finishPair('1234');
        service.connect(tv1);
        if (settle === 'resolve') checking.resolve('airplay-creds');
        else checking.reject(new Error('M4 missing Proof (error=2)'));

        await expect(result).resolves.toBeNull();
      }
    });
  });

  describe('connect()', () => {
    it('returns before the connection completes and reports progress as state', async () => {
      const pending = Promise.withResolvers<void>();
      mockConnect.mockReturnValueOnce(pending.promise);

      expect(service.connect(tv1)).toBeUndefined();
      expect(service.state).toEqual({ status: 'connecting' });
      pending.resolve();
      await flush();

      expect(states).toEqual(['connecting', 'connected']);
      expect(service.state).toEqual({ status: 'connected' });
    });

    it('connects over MRP only, ignoring Companion keys in older saved credentials', async () => {
      const device = await connected();
      expect(device.connect).toHaveBeenCalledWith({
        companionCredentials: 'companion-creds',
        serialized: 'creds-1',
      });
      expect(device.eventNames()).not.toContain('companionClose');
    });

    // A scan otherwise runs its full timeout, delaying every connect by two seconds.
    it('stops scanning as soon as the saved device answers', async () => {
      await connected();
      const [{ timeout, until }] = mockScan.mock.calls[0];
      expect(timeout).toBe(2000);
      expect(until(living)).toBe(true);
      expect(until(bedroom)).toBe(false);
    });

    it('leaves pairing mode', async () => {
      await service.scan();
      await connected();
    });

    it('lets the latest device win over a connect still in flight', async () => {
      const pending = Promise.withResolvers<void>();
      mockConnect.mockReturnValueOnce(pending.promise);
      service.connect(tv1);
      await flush();
      const [first] = devices;

      service.connect(tv2);
      await flush();
      expect(first.close).toHaveBeenCalled();
      expect(service.device?.deviceId).toBe('tv2');

      pending.resolve();
      await flush();
      expect(service.device?.deviceId).toBe('tv2');
      expect(service.state).toEqual({ status: 'connected' });
      first.emit('close');
      await flush(60_000);
      expect(service.state).toEqual({ status: 'connected' });
    });

    it('forwards now-playing only from the current device', async () => {
      const nowPlaying = vi.fn();
      service.on('now-playing', nowPlaying);
      const first = await connected(tv1);
      const second = await connected(tv2);

      first.emit('nowPlaying', { title: 'old' });
      second.emit('nowPlaying', { title: 'new' });
      expect(nowPlaying.mock.calls).toEqual([[{ title: 'new' }]]);
    });

    it('reconnects with backoff after the connection drops, reusing the found device', async () => {
      const device = await connected();
      mockConnect.mockRejectedValueOnce(new Error('refused'));

      device.emit('close');
      expect(service.state).toEqual({ status: 'connecting' });
      await flush(499);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      await flush(1);
      // The first retry skips the 2 s scan; after it fails, the next one scans again.
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockScan).toHaveBeenCalledTimes(1);
      await flush(999);
      expect(mockConnect).toHaveBeenCalledTimes(2);
      await flush(1);
      expect(mockScan).toHaveBeenCalledTimes(2);
      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(service.state).toEqual({ status: 'connected' });
      expect(states).toEqual(['connecting', 'connected', 'connecting', 'connecting', 'connected']);
    });

    it('reports disconnected after five quick retries, then retries every 30 s', async () => {
      mockScan.mockResolvedValue([]);
      service.connect(tv1);
      await flush();
      for (const delay of [500, 1000, 2000, 4000]) {
        await flush(delay);
        expect(service.state).toEqual({ status: 'connecting' });
      }
      await flush(8000);
      expect(mockScan).toHaveBeenCalledTimes(6);
      expect(service.state).toEqual({ status: 'disconnected' });

      await flush(29_999);
      expect(mockScan).toHaveBeenCalledTimes(6);
      await flush(1);
      expect(mockScan).toHaveBeenCalledTimes(7);

      // The TV is back: the next slow retry connects, without flashing "connecting" first.
      mockScan.mockResolvedValue([living]);
      await flush(30_000);
      expect(service.state).toEqual({ status: 'connected' });
      expect(states.slice(-2)).toEqual(['disconnected', 'connected']);
    });

    it('stops the slow retries on disconnect', async () => {
      mockScan.mockResolvedValue([]);
      service.connect(tv1);
      await flush(15_500);
      expect(service.state).toEqual({ status: 'disconnected' });

      await service.disconnect();
      await flush(60_000);
      expect(mockScan).toHaveBeenCalledTimes(6);
    });

    it('retries after a connect timeout, closing the device that timed out', async () => {
      mockConnect.mockReturnValueOnce(new Promise(() => {}));
      service.connect(tv1);
      await flush(15_000);

      expect(devices[0].close).toHaveBeenCalled();
      expect(service.state).toEqual({ status: 'connecting' });
      await flush(500);
      expect(service.state).toEqual({ status: 'connected' });
    });
  });

  describe('reconnect()', () => {
    it('forces a fresh connection, even while the old one still looks connected (wake)', async () => {
      const stale = await connected();
      service.reconnect(tv1);
      await flush();

      expect(stale.close).toHaveBeenCalled();
      expect(mockScan).toHaveBeenCalledTimes(2);
      expect(devices).toHaveLength(2);
      expect(service.device).toBe(devices[1]);
      expect(service.state).toEqual({ status: 'connected' });
    });

    it('does nothing while pairing', async () => {
      await service.scan();
      service.reconnect(tv1);
      await flush();

      expect(mockConnect).not.toHaveBeenCalled();
      expect(service.state).toEqual({ status: 'pairing' });
    });
  });

  describe('sendKey()', () => {
    it('throws when not connected, including while connecting', async () => {
      await expect(service.sendKey('play_pause')).rejects.toThrow('Not connected');
      mockConnect.mockReturnValueOnce(new Promise(() => {}));
      service.connect(tv1);
      await flush();
      await expect(service.sendKey('play_pause')).rejects.toThrow('Not connected');
    });

    it('rejects unknown keys, including inherited object properties', async () => {
      const device = await connected();
      await expect(service.sendKey('invalid_key' as never)).rejects.toThrow('Unknown key');
      await expect(service.sendKey('toString' as never)).rejects.toThrow('Unknown key: toString');
      expect(device.sendKeyCommand).not.toHaveBeenCalled();
    });

    it('sends every valid key', async () => {
      const device = await connected();
      const keys = [
        'play_pause',
        'left',
        'right',
        'down',
        'up',
        'select',
        'menu',
        'top_menu',
        'home',
        'home_hold',
        'skip_backward',
        'skip_forward',
        'volume_up',
        'volume_down',
      ] as const;
      for (const key of keys) await service.sendKey(key);
      expect(device.sendKeyCommand.mock.calls).toEqual(keys.map((_key, index) => [index]));
    });

    describe('play_pause', () => {
      /** The key play_pause sent after the device reported `playbackState`. */
      async function sentAfter(device: MockAppleTV, playbackState?: number): Promise<unknown> {
        if (playbackState !== undefined) device.emit('nowPlaying', { playbackState });
        device.sendKeyCommand.mockClear();
        await service.sendKey('play_pause');
        return device.sendKeyCommand.mock.calls[0][0];
      }

      // Some apps (Plex) treat the play/pause key as play only, so a known state picks the
      // explicit command.
      it('pauses while playing and plays while paused, stopped, or interrupted', async () => {
        const device = await connected();
        expect(await sentAfter(device, PlaybackState.Playing)).toBe(15);
        expect(await sentAfter(device, PlaybackState.Paused)).toBe(14);
        expect(await sentAfter(device, PlaybackState.Stopped)).toBe(14);
        expect(await sentAfter(device, PlaybackState.Interrupted)).toBe(14);
      });

      it('sends the play/pause toggle while the state is unknown or seeking', async () => {
        const device = await connected();
        expect(await sentAfter(device)).toBe(0);
        expect(await sentAfter(device, PlaybackState.Unknown)).toBe(0);
        expect(await sentAfter(device, PlaybackState.Seeking)).toBe(0);
      });

      // Plex never registers as the now-playing app: the TV reports its empty default player,
      // which accepts play/pause commands and does nothing with them.
      // The library maps the key to consumer usage 0xB0 (Play); 0xCD is the Play/Pause toggle.
      it('makes the toggle key press send Play/Pause, not Play', async () => {
        await connected();
        expect(mockHidKeyMap.play_pause.usage).toBe(0xcd);
      });

      it('sends the toggle while the TV reports its default player', async () => {
        const device = await connected();
        device.emit('nowPlaying', {
          playerIdentifier: 'MediaRemote-DefaultPlayer',
          playbackState: PlaybackState.Paused,
        });
        expect(await sentAfter(device)).toBe(0);
      });

      it('forgets the state when the device changes or the connection is replaced', async () => {
        const first = await connected(tv1);
        first.emit('nowPlaying', { playbackState: PlaybackState.Playing });
        const second = await connected(tv2);
        expect(await sentAfter(second)).toBe(0);

        second.emit('nowPlaying', { playbackState: PlaybackState.Playing });
        service.reconnect(tv2);
        await flush();
        expect(await sentAfter(devices.at(-1)!)).toBe(0);
      });

      it('forgets the state when the connection drops and comes back', async () => {
        const device = await connected();
        device.emit('nowPlaying', { playbackState: PlaybackState.Playing });
        device.emit('close');
        await flush(500);
        expect(service.state).toEqual({ status: 'connected' });
        expect(await sentAfter(devices.at(-1)!)).toBe(0);
      });

      it('ignores now-playing from a replaced device', async () => {
        const first = await connected(tv1);
        const second = await connected(tv2);
        first.emit('nowPlaying', { playbackState: PlaybackState.Playing });
        expect(await sentAfter(second)).toBe(0);
      });
    });

    it('times out when the Apple TV does not answer', async () => {
      await connected();
      mockSendKeyCommand.mockReturnValueOnce(new Promise(() => {}));
      const sending = expect(service.sendKey('up')).rejects.toThrow('did not respond');
      await flush(5000);
      await sending;
    });
  });

  describe('seek()', () => {
    it('moves the playing item to the position', async () => {
      const device = await connected();
      await service.seek(90.5);
      expect(device.setPosition).toHaveBeenCalledWith(90.5);
    });

    it('throws when not connected or the position is not a time', async () => {
      await expect(service.seek(10)).rejects.toThrow('Not connected');
      const device = await connected();
      await expect(service.seek(-1)).rejects.toThrow('Invalid position');
      await expect(service.seek(Number.NaN)).rejects.toThrow('Invalid position');
      expect(device.setPosition).not.toHaveBeenCalled();
    });

    it('times out when the Apple TV does not answer', async () => {
      const device = await connected();
      device.setPosition.mockReturnValueOnce(new Promise(() => {}));
      const seeking = expect(service.seek(10)).rejects.toThrow('did not respond');
      await flush(5000);
      await seeking;
    });
  });

  describe('disconnect()', () => {
    it('closes the device, stops reconnecting, and reports idle', async () => {
      const device = await connected();
      await service.disconnect();

      expect(device.close).toHaveBeenCalled();
      expect(service.state).toEqual({ status: 'idle' });
      device.emit('close');
      await flush(60_000);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('times out when closing the device hangs', async () => {
      const device = await connected();
      device.close.mockReturnValueOnce(new Promise(() => {}));
      const disconnecting = expect(service.disconnect()).rejects.toThrow('Disconnect timed out');
      await flush(5000);
      await disconnecting;
      expect(service.state).toEqual({ status: 'idle' });
    });
  });

  it('destroy() clears scan results and the pairing session', async () => {
    await service.scan();
    await service.startPair('Living Room (1.2.3.4)');
    await service.destroy();

    expect(service.scanResults).toEqual({});
    expect(service.pairingSession).toBeNull();
    expect(service.state).toEqual({ status: 'idle' });
  });
});

// The library's real Credentials, not the mock above: saved credentials must survive the move
// from two-PIN (AirPlay + Companion) to one-PIN (AirPlay only) pairing.
describe('saved credentials format', () => {
  const hap = (id: string) => ({
    clientId: `${id}-client`,
    clientLTSK: Buffer.from(`${id}-ltsk`),
    clientLTPK: Buffer.from(`${id}-ltpk`),
    serverLTPK: Buffer.from(`${id}-server-ltpk`),
    serverId: `${id}-server`,
  });
  const hexFields = (id: string) => {
    const c = hap(id);
    return {
      clientId: c.clientId,
      clientLTSK: c.clientLTSK.toString('hex'),
      clientLTPK: c.clientLTPK.toString('hex'),
      serverLTPK: c.serverLTPK.toString('hex'),
      serverId: c.serverId,
    };
  };
  let Credentials: typeof import('../../app/node_modules/node-appletv-remote/dist/credentials.js').Credentials;

  beforeAll(async () => {
    ({ Credentials } =
      await import('../../app/node_modules/node-appletv-remote/dist/credentials.js'));
  });

  it('serializes AirPlay-only credentials without a Companion part and reads them back', () => {
    const serialized = new Credentials(hap('airplay')).serialize();
    expect(JSON.parse(serialized)).toEqual(hexFields('airplay'));

    const restored = Credentials.deserialize(serialized);
    expect(restored).toMatchObject(hap('airplay'));
    expect(restored.companionCredentials).toBeUndefined();
  });

  it('still reads credentials saved with a Companion part by two-PIN pairing', () => {
    const saved = JSON.stringify({ ...hexFields('airplay'), companion: hexFields('companion') });

    const restored = Credentials.deserialize(saved);
    expect(restored).toMatchObject(hap('airplay'));
    expect(restored.companionCredentials).toEqual(hap('companion'));
  });
});

// PlaybackState in shared/types copies the library's enum, because the webview cannot load the
// library; this keeps the copy honest.
describe('PlaybackState', () => {
  it('matches the library enum', async () => {
    const lib = await import('../../app/node_modules/node-appletv-remote/dist/now-playing-info.js');
    for (const [name, value] of Object.entries(PlaybackState)) {
      expect(lib.PlaybackState[name as keyof typeof lib.PlaybackState]).toBe(value);
    }
  });
});
