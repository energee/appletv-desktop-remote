// The only owner of the Apple TV connection: connects, reconnects with backoff after a drop,
// switches devices, and pairs. Runs in the Node sidecar; it reports every change as a `state`
// event (ConnectionState) and the webview only renders that.
import { EventEmitter } from 'events';
import {
  PlaybackState,
  type ATVCredentials,
  type ATVKeyName,
  type ConnectionState,
  type PairResult,
} from '../shared/types';
import type { AppleTV, DiscoveredDevice, Key as KeyType, PairSetup } from 'node-appletv-remote';

// node-appletv-remote is ESM-only. Use dynamic import wrapper.
let atvLib: typeof import('node-appletv-remote') | null = null;
async function getLib(): Promise<typeof import('node-appletv-remote')> {
  if (!atvLib) {
    const [lib, mrp] = await Promise.all([
      import('node-appletv-remote'),
      import('node-appletv-remote/dist/mrp/messages.js'),
    ]);
    // ponytail: 0.5.0 maps play_pause to consumer usage 0xB0, which is Play, so the "toggle"
    // key only ever plays. 0xCD is Play/Pause. Drop once the library's HID_KEY_MAP is fixed.
    mrp.HID_KEY_MAP.play_pause.usage = 0xcd;
    atvLib = lib;
  }
  return atvLib;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Retries after a failed connect or a dropped connection, 0.5 s apart and doubling. */
const RETRY_LIMIT = 5;
/** How long a key press or closing the device may take before the request fails. */
const COMMAND_TIMEOUT = 5000;
/** Playback states in which play_pause sends Play. */
const PAUSED_STATES: readonly number[] = [
  PlaybackState.Paused,
  PlaybackState.Stopped,
  PlaybackState.Interrupted,
];
/** The player the TV reports when no app has registered as now playing. */
const DEFAULT_PLAYER = 'MediaRemote-DefaultPlayer';

class ATVService extends EventEmitter {
  /** The connected device, the one a connect attempt is using, or the one being paired. */
  device: AppleTV | null = null;
  scanResults: Record<string, DiscoveredDevice> = {};
  pairingSession: PairSetup | null = null;
  state: ConnectionState = { status: 'idle' };
  /**
   * Bumped by every connect, pairing step, and disconnect. Async work checks it after each
   * await and stops if it changed, so a superseded connect can never change state.
   */
  private epoch = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  /** The current device's last reported PlaybackState; each new device starts Unknown. */
  private playbackState: number = PlaybackState.Unknown;

  /**
   * Scanning starts pairing: it ends any connection, and none runs until connect(). Lists Apple
   * TVs only: other AirPlay receivers (smart TVs, Macs, speakers) don't take remote commands.
   */
  async scan(timeout = 2000): Promise<string[]> {
    void this.supersede('pairing');
    const { scan } = await getLib();
    const devices = await withTimeout(
      scan({ timeout, filter: (d) => d.model.startsWith('AppleTV') }),
      timeout + 2000,
      'Scan timed out. Please try again.',
    );
    this.scanResults = {};
    return devices.map((d) => {
      const label = `${d.name} (${d.address})`;
      this.scanResults[label] = d;
      return label;
    });
  }

  /**
   * Starts AirPlay pairing, which makes the Apple TV show a PIN for finishPair. Ignored unless
   * pairing (after scan), so a retry that arrives after the user connected cannot end it.
   */
  async startPair(deviceLabel: string): Promise<void> {
    const discoveredDevice = this.scanResults[deviceLabel];
    if (!discoveredDevice) throw new Error(`Device not found: ${deviceLabel}`);
    const { AppleTV } = await getLib();
    if (this.state.status !== 'pairing') return;
    console.log(`startPair: device=${discoveredDevice.name}, address=${discoveredDevice.address}`);
    void this.supersede('pairing');
    const epoch = this.epoch;
    const device = (this.device = new AppleTV(discoveredDevice));
    // Without an 'error' listener, a socket error would be thrown.
    device.on('error', (err) => console.error('ATV error during pairing:', err));
    try {
      const session = await withTimeout(
        device.startPairing(),
        30000,
        'Pairing timed out. Please try again.',
      );
      if (epoch !== this.epoch) return;
      this.pairingSession = session;
      console.log('startPair: AirPlay pairing started, PIN should appear on TV');
    } catch (err) {
      // A superseded pairing's failure (its device was closed) is nobody's concern.
      if (epoch === this.epoch) throw err;
    }
  }

  /**
   * Completes AirPlay pairing with the PIN. The credentials hold only the AirPlay part: every
   * key the remote sends and now-playing go over MRP, so Companion pairing is not needed.
   * Pairing mode lasts until the caller connects with them. A session takes one PIN, right or
   * wrong (the library closes it either way), so after a failure call startPair again. Resolves
   * null if pairing ended (Cancel connects) while the TV checked the PIN.
   */
  async finishPair(pin: string): Promise<PairResult | null> {
    const session = this.pairingSession;
    const device = this.device;
    if (!session || !device) throw new Error('No active pairing session');
    this.pairingSession = null;
    const epoch = this.epoch;
    const { Credentials } = await getLib();
    try {
      const airplayCreds = await withTimeout(
        session.finish(pin),
        30000,
        'Pairing verification timed out. Please try again.',
      );
      if (epoch !== this.epoch) return null;
      console.log('finishPair: AirPlay pairing complete');
      return {
        credentials: new Credentials(airplayCreds).serialize(),
        identifier: device.deviceId || 'unknown',
      };
    } catch (err) {
      if (epoch !== this.epoch) return null;
      throw err;
    }
  }

  /**
   * Makes `credsData` the device to stay connected to and starts a fresh connection, ending
   * pairing, any other connection, and any connect in flight (the latest request wins).
   * Returns at once; progress arrives as `state` events.
   */
  connect(credsData: ATVCredentials): void {
    void this.supersede('connecting');
    void this.attempt(this.epoch, credsData);
  }

  /**
   * For wake from sleep and a relaunched sidecar: like connect, since a connection that looks
   * open may be dead, but ignored while pairing so it cannot pull the user out of it.
   */
  reconnect(credsData: ATVCredentials): void {
    if (this.state.status !== 'pairing') this.connect(credsData);
  }

  /**
   * One connect attempt for `epoch`. `found` (the device from the last good connection) skips
   * the scan, which otherwise ends as soon as the saved device answers; a failure schedules a
   * retry that scans again. Companion keys in credentials saved by earlier two-PIN pairing are
   * ignored.
   */
  private async attempt(
    epoch: number,
    credsData: ATVCredentials,
    found?: DiscoveredDevice,
  ): Promise<void> {
    let device: AppleTV | undefined;
    try {
      const { AppleTV, Credentials, scan } = await getLib();
      if (!found) {
        const saved = (d: DiscoveredDevice) => d.deviceId === credsData.identifier;
        const devices = await withTimeout(
          scan({ timeout: 2000, until: saved }),
          4000,
          'Device scan timed out during connect.',
        );
        found = devices.find(saved);
      }
      if (epoch !== this.epoch) return;
      if (!found) throw new Error('Device not found on network');
      device = this.device = new AppleTV(found);
      this.listen(device, epoch, credsData, found);
      await withTimeout(
        device.connect(Credentials.deserialize(credsData.credentials)),
        15000,
        'Connection timed out. The Apple TV may be unreachable.',
      );
      // Superseded: supersede() already closed this device.
      if (epoch !== this.epoch) return;
      this.failures = 0;
      this.setState({ status: 'connected' });
    } catch (err) {
      if (epoch !== this.epoch) return;
      console.error('Connect failed:', err);
      if (device) {
        this.device = null;
        void device.close();
      }
      this.retry(epoch, credsData);
    }
  }

  /**
   * Listeners act only while `device` is current, so a replaced device stays silent. Every
   * connect attempt, including reconnects after a drop, gets a new device and comes through
   * here, so this is where the old device's playback state is forgotten.
   */
  private listen(
    device: AppleTV,
    epoch: number,
    credsData: ATVCredentials,
    found: DiscoveredDevice,
  ): void {
    this.playbackState = PlaybackState.Unknown;
    device.on('error', (err) => {
      console.error('ATV error:', err);
      if (device === this.device) this.emit('error', err);
    });
    // 0-100, from outputs with absolute volume (AirPods, HomePod, not TV speakers); undefined, sent
    // as null, when the output loses it.
    device.on('volume', (level) => {
      if (device === this.device) this.emit('volume', level ?? null);
    });
    // A new device starts unknown; the TV reports its state at connect and on every sleep and wake.
    device.on('powerState', (state) => {
      if (device === this.device) this.emit('power-state', state);
    });
    device.on('nowPlaying', (info) => {
      if (device !== this.device) return;
      // Apps such as Plex report through the TV's default player, which accepts the explicit
      // play and pause commands and ignores them, so its state must not choose them.
      this.playbackState =
        info.playerIdentifier === DEFAULT_PLAYER ? PlaybackState.Unknown : info.playbackState;
      this.emit('now-playing', info);
    });
    device.on('close', () => {
      if (device !== this.device) return;
      this.device = null;
      this.retry(epoch, credsData, found);
    });
  }

  private retry(epoch: number, credsData: ATVCredentials, found?: DiscoveredDevice): void {
    if (this.failures >= RETRY_LIMIT) {
      this.setState({ status: 'disconnected' });
      return;
    }
    const delay = 500 * 2 ** this.failures++;
    this.setState({ status: 'connecting' });
    this.retryTimer = setTimeout(() => void this.attempt(epoch, credsData, found), delay);
  }

  /**
   * Starts a new epoch in `status`: cancels the pending retry, drops the pairing session, and
   * closes the device. Returns that close, which never rejects.
   */
  private supersede(status: ConnectionState['status']): Promise<void> {
    this.epoch++;
    clearTimeout(this.retryTimer);
    this.failures = 0;
    this.pairingSession = null;
    const device = this.device;
    this.device = null;
    this.setState({ status });
    return device ? device.close() : Promise.resolve();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit('state', state);
  }

  async sendKey(keyName: ATVKeyName): Promise<void> {
    const { Key } = await getLib();

    const keyMap: Record<ATVKeyName, KeyType> = {
      play_pause: Key.PlayPause,
      left: Key.Left,
      right: Key.Right,
      down: Key.Down,
      up: Key.Up,
      select: Key.Select,
      menu: Key.Menu,
      top_menu: Key.TopMenu,
      home: Key.Home,
      home_hold: Key.HomeHold,
      skip_backward: Key.SkipBackward,
      skip_forward: Key.SkipForward,
      volume_up: Key.VolumeUp,
      volume_down: Key.VolumeDown,
    };

    // hasOwn, not lookup: names like 'toString' come from the prototype. The sidecar relies
    // on this check to reject keys the webview sends.
    if (!Object.hasOwn(keyMap, keyName)) throw new Error(`Unknown key: ${keyName}`);
    const device = this.connectedDevice();
    let key = keyMap[keyName];
    // When the now-playing app's state is known, send the explicit pause or play command so the
    // button never toggles the wrong way; while it is unknown or seeking, the toggle key press.
    if (keyName === 'play_pause') {
      if (this.playbackState === PlaybackState.Playing) key = Key.Pause;
      else if (PAUSED_STATES.includes(this.playbackState)) key = Key.Play;
    }
    await withTimeout(
      device.sendKeyCommand(key),
      COMMAND_TIMEOUT,
      'The Apple TV did not respond to the key press.',
    );
  }

  /** The connected device; while pairing, `device` is the pairing device and must not be used. */
  private connectedDevice(): AppleTV {
    if (!this.device || this.state.status !== 'connected') throw new Error('Not connected');
    return this.device;
  }

  /** Sets the absolute volume, 0 to 100; the TV must have reported one (the `volume` event). */
  async setVolume(level: number): Promise<void> {
    if (!Number.isFinite(level) || level < 0 || level > 100) throw new Error('Invalid volume');
    await withTimeout(
      this.connectedDevice().setVolume(level),
      COMMAND_TIMEOUT,
      'The Apple TV did not respond to the volume change.',
    );
  }

  /**
   * Wakes the TV if it reports being asleep, otherwise puts it to sleep. Over MRP, so no Companion
   * pairing; the library keeps `powerState` current from the TV's DeviceInfo.
   */
  async togglePower(): Promise<void> {
    const device = this.connectedDevice();
    const { PowerState } = await getLib();
    await withTimeout(
      device.powerState === PowerState.Off ? device.wake() : device.suspend(),
      COMMAND_TIMEOUT,
      'The Apple TV did not respond to the power button.',
    );
  }

  /** Moves the playing item to `seconds` from its start. */
  async seek(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid position');
    await withTimeout(
      this.connectedDevice().setPosition(seconds),
      COMMAND_TIMEOUT,
      'The Apple TV did not respond to the seek.',
    );
  }

  /** Closes the device and stops reconnecting until the next connect. */
  async disconnect(): Promise<void> {
    await withTimeout(this.supersede('idle'), COMMAND_TIMEOUT, 'Disconnect timed out.');
  }

  isConnected(): boolean {
    return this.state.status === 'connected';
  }

  async destroy(): Promise<void> {
    await this.disconnect().catch((err: unknown) => console.error('Error closing device:', err));
    this.scanResults = {};
    this.removeAllListeners();
  }
}

export default ATVService;
