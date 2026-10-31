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
  type Speaker,
} from '../shared/types';
import type {
  AppleTV,
  CompanionPairSetup,
  DiscoveredDevice,
  Key as KeyType,
  PairSetup,
} from 'node-appletv-remote';
import type { HAPCredentials } from 'node-appletv-remote/dist/auth/types.js';

// node-appletv-remote is ESM-only. Use dynamic import wrapper.
let atvLib: typeof import('node-appletv-remote') | null = null;
/** The library's keys with a HID usage: the only ones it can hold. */
let hidKeys: Record<string, unknown> = {};
async function getLib(): Promise<typeof import('node-appletv-remote')> {
  if (!atvLib) {
    const [lib, mrp] = await Promise.all([
      import('node-appletv-remote'),
      import('node-appletv-remote/dist/mrp/messages.js'),
    ]);
    // ponytail: 0.5.0 maps play_pause to consumer usage 0xB0, which is Play, so the "toggle"
    // key only ever plays. 0xCD is Play/Pause. Drop once the library's HID_KEY_MAP is fixed.
    mrp.HID_KEY_MAP.play_pause.usage = 0xcd;
    hidKeys = mrp.HID_KEY_MAP;
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
/** After those, how often to keep trying while disconnected, until the TV comes back. */
const SLOW_RETRY_MS = 30_000;
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
/** PlaybackQueueRequest error for an idle receiver with no now-playing client. */
const NO_NOW_PLAYING_CLIENT = 35;

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
  private companionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private companionFailures = 0;
  private companionSetup: { device: AppleTV; attempt: number } | null = null;
  private companionAttempt = 0;
  private companionRecoveryEnabled = false;
  /** The current device's last reported PlaybackState; each new device starts Unknown. */
  private playbackState: number = PlaybackState.Unknown;
  /** Optional Companion pairing never replaces the ordinary MRP connection. */
  private companionPairing: CompanionPairSetup | null = null;
  private companionPairEpoch = 0;
  private companion: {
    status: 'unpaired' | 'pairing' | 'connecting' | 'connected' | 'unavailable';
    identifier: string | null;
    error?: string;
  } = { status: 'unpaired', identifier: null };
  private textWrites: Promise<void> = Promise.resolve();
  private touchActive = false;
  private activeCredentials: ATVCredentials | null = null;
  private textFocusGeneration = 0;
  private textReadGeneration = 0;

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
      const opening = device.startPairing();
      const session = await withTimeout(
        opening,
        30000,
        'Pairing timed out. Please try again.',
      ).catch((error: unknown) => {
        void opening.then(
          (lateSession) => lateSession.destroy(),
          () => {},
        );
        throw error;
      });
      if (epoch !== this.epoch) {
        session.destroy();
        return;
      }
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
        name: device.name,
      };
    } catch (err) {
      if (epoch !== this.epoch) return null;
      throw err;
    } finally {
      if (this.pairingSession === session) this.pairingSession = null;
      session.destroy();
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
   * retry that scans again. Saved Companion credentials reconnect only after MRP is ready, and
   * failure there remains isolated from the ordinary remote connection.
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
      this.activeCredentials = credsData;
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
      // Some receivers push state without metadata at connect; seed the queue once.
      void device.getState().catch((error: unknown) => {
        if (device !== this.device) return;
        if (
          error instanceof Error &&
          'errorCode' in error &&
          error.errorCode === NO_NOW_PLAYING_CLIENT
        )
          return;
        this.emit('error', error);
      });
      void this.restoreCompanion(device, credsData, epoch);
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
    // The outputs the TV plays to, by output ID, whenever its DeviceInfo changes them.
    device.on('outputDevices', (outputs: { identifier: string }[]) => {
      if (device === this.device)
        this.emit(
          'outputs',
          outputs.map((o) => o.identifier),
        );
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
    device.on('textFocusState', (state) => {
      if (device !== this.device) return;
      const focused = state === 'focused';
      this.textFocusGeneration++;
      this.emit('text-focus', { focused });
      if (focused) void this.refreshText(device, epoch, this.textFocusGeneration);
    });
    device.on('textInput', () => {
      if (device === this.device) void this.refreshText(device, epoch, this.textFocusGeneration);
    });
    device.on('companionClose', () => {
      if (device !== this.device || this.companion.status === 'pairing') return;
      this.recoverCompanion(device, credsData, epoch, 'Companion connection closed.');
    });
    device.on('companionError', (error: Error) => {
      if (device !== this.device || this.companion.status === 'pairing') return;
      this.recoverCompanion(device, credsData, epoch, error.message);
    });
    device.on('close', () => {
      if (device !== this.device) return;
      this.touchActive = false;
      this.stopCompanionRecovery();
      this.setCompanionState('unavailable', credsData.identifier, 'Connection lost.');
      this.device = null;
      void device.close();
      this.retry(epoch, credsData, found);
    });
  }

  companionStatus(): {
    status: 'unpaired' | 'pairing' | 'connecting' | 'connected' | 'unavailable';
    identifier: string | null;
    error?: string;
  } {
    return { ...this.companion };
  }

  async startCompanionPair(): Promise<void> {
    const device = this.connectedDevice();
    const epoch = this.epoch;
    const pairEpoch = ++this.companionPairEpoch;
    await this.stopCompanionRecovery();
    if (epoch !== this.epoch || pairEpoch !== this.companionPairEpoch || device !== this.device)
      return;
    this.companionPairing?.destroy();
    this.companionPairing = null;
    this.setCompanionState('pairing');
    try {
      const pairing = await device.startCompanionPairing();
      if (epoch !== this.epoch || pairEpoch !== this.companionPairEpoch || device !== this.device) {
        pairing.destroy();
        return;
      }
      this.companionPairing = pairing;
    } catch (error) {
      if (epoch !== this.epoch || pairEpoch !== this.companionPairEpoch) return;
      this.setCompanionState(
        'unavailable',
        undefined,
        error instanceof Error ? error.message : 'Unable to start Companion pairing.',
      );
      throw error;
    }
  }

  async finishCompanionPair(pin: string): Promise<PairResult | null> {
    const session = this.companionPairing;
    const device = this.connectedDevice();
    if (!session) throw new Error('No active Companion pairing session');
    const pairEpoch = this.companionPairEpoch;
    const epoch = this.epoch;
    try {
      const companionCredentials = await withTimeout(
        session.finish(pin),
        30000,
        'Companion pairing verification timed out. Please try again.',
      );
      if (!this.isCurrentCompanionPair(device, epoch, pairEpoch)) return null;
      const { Credentials } = await getLib();
      if (!this.isCurrentCompanionPair(device, epoch, pairEpoch)) return null;
      const credentials = Credentials.deserialize(this.requireCredentials().credentials);
      const merged = new Credentials(credentials, companionCredentials).serialize();
      this.companionPairing = null;
      session.destroy();
      try {
        await this.openCompanion(device, companionCredentials, epoch);
        if (!this.isCurrentCompanionPair(device, epoch, pairEpoch)) return null;
        this.commitCompanionCredentials(merged);
        this.companionFailures = 0;
        this.setCompanionState('connected');
        const focused = device.textFocusState === 'focused';
        this.emit('text-focus', { focused });
        if (focused) this.refreshText(device, epoch, ++this.textFocusGeneration);
      } catch (error) {
        if (!this.isCurrentCompanionPair(device, epoch, pairEpoch)) return null;
        const activeCredentials = this.commitCompanionCredentials(merged);
        this.recoverCompanion(
          device,
          activeCredentials,
          epoch,
          error instanceof Error ? error.message : 'Unable to connect Companion.',
        );
      }
      if (!this.isCurrentCompanionPair(device, epoch, pairEpoch)) return null;
      return {
        credentials: merged,
        identifier: this.requireCredentials().identifier,
        name: device.name,
      };
    } catch (error) {
      if (!this.isCurrentCompanionPair(device, epoch, pairEpoch)) return null;
      this.setCompanionState(
        'unavailable',
        undefined,
        error instanceof Error ? error.message : 'Companion pairing failed.',
      );
      throw error;
    } finally {
      if (this.companionPairing === session) this.companionPairing = null;
      session.destroy();
    }
  }

  async cancelCompanionPair(): Promise<void> {
    this.companionPairEpoch++;
    if (this.companion.status === 'pairing' || this.companion.status === 'connecting')
      this.setCompanionState('unpaired');
    await this.stopCompanionRecovery();
    this.companionPairing?.destroy();
    this.companionPairing = null;
  }

  async apps(): Promise<Array<{ name: string; bundleId: string }>> {
    return this.connectedCompanion().appList();
  }

  async launchApp(bundleId: string): Promise<void> {
    if (!bundleId) throw new Error('App bundle ID is required.');
    await this.connectedCompanion().launchApp(bundleId);
  }

  setText(text: string): Promise<string> {
    if (typeof text !== 'string') return Promise.reject(new Error('Text must be a string.'));
    return this.enqueueText((device) => device.setText(text));
  }

  clearText(): Promise<string> {
    return this.enqueueText((device) => device.clearText());
  }

  async touch(x: number, y: number, phase: 'press' | 'hold' | 'release'): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1000 || y < 0 || y > 1000)
      throw new Error('Touch coordinates must be between 0 and 1000.');
    const device = this.connectedCompanion();
    const epoch = this.epoch;
    const { TouchAction } = await getLib();
    if (epoch !== this.epoch || device !== this.device) return;
    const action = {
      press: TouchAction.Press,
      hold: TouchAction.Hold,
      release: TouchAction.Release,
    }[phase];
    if (phase === 'hold' && !this.touchActive) throw new Error('Touch hold requires a press.');
    if (phase === 'release' && !this.touchActive) return;
    await device.touchAction(x, y, action);
    if (epoch !== this.epoch || device !== this.device) return;
    this.touchActive = phase !== 'release';
  }

  private refreshText(device: AppleTV, epoch: number, focusGeneration: number): void {
    if (this.companion.status !== 'connected' || device.textFocusState !== 'focused') return;
    const readGeneration = ++this.textReadGeneration;
    const run = this.textWrites.then(async () => {
      if (
        epoch !== this.epoch ||
        focusGeneration !== this.textFocusGeneration ||
        readGeneration !== this.textReadGeneration ||
        device !== this.device
      )
        return;
      const text = await device.getText();
      if (
        epoch === this.epoch &&
        focusGeneration === this.textFocusGeneration &&
        readGeneration === this.textReadGeneration &&
        device === this.device
      ) {
        this.emit('text-input', { text });
      }
    });
    this.textWrites = run.catch((error: unknown) => {
      if (
        epoch === this.epoch &&
        focusGeneration === this.textFocusGeneration &&
        device === this.device
      ) {
        const message = error instanceof Error ? error.message : 'Unable to read the text field.';
        this.setCompanionState(
          'connected',
          undefined,
          `${message} Select the text field again to retry.`,
        );
      }
    });
  }

  private async restoreCompanion(
    device: AppleTV,
    credsData: ATVCredentials,
    epoch: number,
  ): Promise<void> {
    const { Credentials } = await getLib();
    if (epoch !== this.epoch || device !== this.device) return;
    const credentials = Credentials.deserialize(credsData.credentials);
    if (!credentials.companionCredentials) {
      this.companionRecoveryEnabled = false;
      this.setCompanionState('unpaired', credsData.identifier);
      return;
    }
    this.companionRecoveryEnabled = true;
    await this.attemptCompanion(device, credsData, epoch, credentials.companionCredentials);
  }

  private async attemptCompanion(
    device: AppleTV,
    credsData: ATVCredentials,
    epoch: number,
    credentials: HAPCredentials,
  ): Promise<void> {
    try {
      await this.openCompanion(device, credentials, epoch);
      if (epoch !== this.epoch || device !== this.device) return;
      this.companionFailures = 0;
      this.setCompanionState('connected');
      const focused = device.textFocusState === 'focused';
      this.emit('text-focus', { focused });
      if (focused) this.refreshText(device, epoch, ++this.textFocusGeneration);
    } catch (error) {
      if (epoch !== this.epoch || device !== this.device || !this.companionRecoveryEnabled) return;
      this.recoverCompanion(
        device,
        credsData,
        epoch,
        error instanceof Error ? error.message : 'Unable to reconnect Companion.',
      );
    }
  }

  private async openCompanion(
    device: AppleTV,
    credentials: HAPCredentials,
    epoch: number,
  ): Promise<void> {
    const attempt = ++this.companionAttempt;
    this.companionSetup = { device, attempt };
    this.setCompanionState('connecting');
    try {
      await withTimeout(
        device.connectCompanion(credentials),
        15000,
        'Companion connection timed out. Reconnect the remote to try again.',
      );
      if (
        epoch !== this.epoch ||
        device !== this.device ||
        this.companionSetup?.device !== device ||
        this.companionSetup.attempt !== attempt
      )
        throw new Error('Companion setup cancelled.');
      this.companionSetup = null;
    } catch (error) {
      if (this.companionSetup?.device === device && this.companionSetup.attempt === attempt) {
        this.companionSetup = null;
        await device.closeCompanion();
      }
      throw error;
    }
  }

  private recoverCompanion(
    device: AppleTV,
    credsData: ATVCredentials,
    epoch: number,
    message: string,
  ): void {
    if (
      !this.companionRecoveryEnabled ||
      epoch !== this.epoch ||
      device !== this.device ||
      this.companionSetup ||
      this.companionRetryTimer
    )
      return;
    this.setCompanionState('unavailable', undefined, message);
    const delay =
      this.companionFailures >= RETRY_LIMIT ? SLOW_RETRY_MS : 500 * 2 ** this.companionFailures++;
    this.companionRetryTimer = setTimeout(() => {
      this.companionRetryTimer = undefined;
      void this.restoreCompanion(device, credsData, epoch);
    }, delay);
  }

  private async stopCompanionRecovery(): Promise<void> {
    this.companionRecoveryEnabled = false;
    this.companionAttempt++;
    this.companionFailures = 0;
    clearTimeout(this.companionRetryTimer);
    this.companionRetryTimer = undefined;
    const setup = this.companionSetup;
    this.companionSetup = null;
    if (setup) await setup.device.closeCompanion();
  }

  private setCompanionState(
    status: 'unpaired' | 'pairing' | 'connecting' | 'connected' | 'unavailable',
    identifier = this.activeCredentials?.identifier ?? null,
    error?: string,
  ): void {
    this.companion = { status, identifier, ...(error ? { error } : {}) };
    this.emit('companion-state', this.companionStatus());
  }

  private connectedCompanion(): AppleTV {
    if (this.companion.status !== 'connected')
      throw new Error(
        'Companion features are not connected. Pair this device in the feature dialog.',
      );
    return this.connectedDevice();
  }

  private requireCredentials(): ATVCredentials {
    if (!this.activeCredentials) throw new Error('No active device credentials.');
    return this.activeCredentials;
  }

  private isCurrentCompanionPair(device: AppleTV, epoch: number, pairEpoch: number): boolean {
    return epoch === this.epoch && pairEpoch === this.companionPairEpoch && device === this.device;
  }

  private commitCompanionCredentials(credentials: string): ATVCredentials {
    const activeCredentials = this.requireCredentials();
    activeCredentials.credentials = credentials;
    this.companionRecoveryEnabled = true;
    return activeCredentials;
  }

  private enqueueText(edit: (device: AppleTV) => Promise<string>): Promise<string> {
    const epoch = this.epoch;
    const focusGeneration = this.textFocusGeneration;
    const device = this.connectedCompanion();
    const run = this.textWrites.then(async () => {
      if (
        epoch !== this.epoch ||
        focusGeneration !== this.textFocusGeneration ||
        device !== this.device
      )
        throw new Error('Device or text field changed while editing.');
      return edit(device);
    });
    this.textWrites = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private retry(epoch: number, credsData: ATVCredentials, found?: DiscoveredDevice): void {
    if (this.failures >= RETRY_LIMIT) {
      // Stays disconnected, rather than flashing "connecting" every 30 s; a success connects.
      if (this.state.status !== 'disconnected') this.setState({ status: 'disconnected' });
      this.retryTimer = setTimeout(() => void this.attempt(epoch, credsData), SLOW_RETRY_MS);
      return;
    }
    const delay = 500 * 2 ** this.failures++;
    this.setState({ status: 'connecting' });
    this.retryTimer = setTimeout(() => void this.attempt(epoch, credsData, found), delay);
  }

  /**
   * Starts a new epoch in `status`: cancels retries and pairing sessions, then closes the device.
   */
  private async supersede(status: ConnectionState['status']): Promise<void> {
    this.epoch++;
    this.companionPairEpoch++;
    this.textFocusGeneration++;
    this.textReadGeneration++;
    this.textWrites = Promise.resolve();
    clearTimeout(this.retryTimer);
    this.failures = 0;
    this.pairingSession?.destroy();
    this.pairingSession = null;
    this.companionPairing?.destroy();
    this.companionPairing = null;
    this.touchActive = false;
    this.activeCredentials = null;
    this.setCompanionState('unpaired', null);
    const device = this.device;
    this.device = null;
    this.setState({ status });
    await this.stopCompanionRecovery();
    if (device) await device.close();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit('state', state);
  }

  /**
   * Presses `keyName`, or with `hold` holds it for a second, as a long press on the Siri Remote
   * does (Select opens context menus, Home opens Control Center). Keys the library cannot hold,
   * the skip keys, get an ordinary press.
   */
  async sendKey(keyName: ATVKeyName, hold = false): Promise<void> {
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
    // A hold keeps the toggle key: Play and Pause have no HID usage, so they cannot be held.
    if (keyName === 'play_pause' && !hold) {
      if (this.playbackState === PlaybackState.Playing) key = Key.Pause;
      else if (PAUSED_STATES.includes(this.playbackState)) key = Key.Play;
    }
    await withTimeout(
      hold && Object.hasOwn(hidKeys, key)
        ? device.sendKeyCommand(key, 'hold')
        : device.sendKeyCommand(key),
      COMMAND_TIMEOUT,
      'The Apple TV did not respond to the key press.',
    );
  }

  /** The connected device; while pairing, `device` is the pairing device and must not be used. */
  private connectedDevice(): AppleTV {
    if (!this.device || this.state.status !== 'connected') throw new Error('Not connected');
    return this.device;
  }

  /**
   * AirPlay receivers the TV can play to (HomePods, AirPlay speakers, other TVs): a scan with no
   * Apple TV filter, keeping those with an output ID (`airplayPsi`), less the connected TV.
   */
  async speakers(): Promise<Speaker[]> {
    const device = this.connectedDevice();
    const { scan } = await getLib();
    const found = await withTimeout(scan({ timeout: 2000 }), 4000, 'Speaker scan timed out.');
    const selected = new Set(device.outputDevices.map((output) => output.identifier));
    return found.flatMap(({ airplayPsi: id, name, deviceId }) =>
      id && deviceId !== device.deviceId ? [{ id, name, selected: selected.has(id) }] : [],
    );
  }

  /** Adds speaker `id` to the TV's outputs, or removes it; resolves once the TV confirms. */
  async setSpeaker(id: string, on: boolean): Promise<void> {
    const device = this.connectedDevice();
    // The library waits up to 5 s for the TV to report the new outputs.
    await withTimeout(
      on ? device.addOutputDevices([id]) : device.removeOutputDevices([id]),
      COMMAND_TIMEOUT + 2000,
      'The Apple TV did not confirm the speaker change.',
    );
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

  async destroy(): Promise<void> {
    await this.disconnect().catch((err: unknown) => console.error('Error closing device:', err));
    this.scanResults = {};
    this.removeAllListeners();
  }
}

export default ATVService;
