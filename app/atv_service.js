const EventEmitter = require('events');

// node-appletv-remote is ESM-only. Use dynamic import wrapper.
let atvLib = null;
async function getLib() {
  if (!atvLib) {
    atvLib = await import('node-appletv-remote');
  }
  return atvLib;
}

class ATVService extends EventEmitter {
  constructor() {
    super();
    this.device = null;
    this.scanResults = {};
    this.pairingSession = null;
    this.reconnecting = false;
  }

  async scan(timeout = 5000) {
    const { scan } = await getLib();
    const devices = await scan({
      timeout,
      filter: (d) => d.model && d.model.toLowerCase().includes('tv')
    });
    this.scanResults = {};
    const results = devices.map(d => {
      const label = `${d.name} (${d.address})`;
      this.scanResults[label] = d;
      return label;
    });
    return results;
  }

  async startPair(deviceLabel) {
    const { AppleTV } = await getLib();
    const discoveredDevice = this.scanResults[deviceLabel];
    if (!discoveredDevice) throw new Error(`Device not found: ${deviceLabel}`);
    this.device = new AppleTV(discoveredDevice);
    this.pairingSession = await this.device.startPairing();
  }

  async finishPair(pin) {
    if (!this.pairingSession) throw new Error('No active pairing session');
    const { Credentials } = await getLib();
    const hapCreds = await this.pairingSession.finish(pin);
    const credentials = new Credentials(hapCreds);
    const serialized = credentials.serialize();
    this.pairingSession = null;
    return {
      credentials: serialized,
      identifier: this.device.deviceId || 'unknown'
    };
  }

  async connect(credsData) {
    const { AppleTV, Credentials, scan } = await getLib();
    const credentials = Credentials.deserialize(credsData.credentials);

    if (!this.device) {
      const devices = await scan({ timeout: 5000 });
      const match = devices.find(d => d.deviceId === credsData.identifier);
      if (!match) {
        this.emit('connection-failure');
        throw new Error('Device not found on network');
      }
      this.device = new AppleTV(match);
    }

    try {
      await this.device.connect(credentials);
      this._setupListeners();
      this.emit('connected');
    } catch (err) {
      this.emit('connection-failure');
      throw err;
    }
  }

  _setupListeners() {
    if (!this.device) return;
    this.device.removeAllListeners();

    this.device.on('close', () => {
      this.emit('connection-lost');
    });

    this.device.on('error', (err) => {
      console.error('ATV error:', err);
      this.emit('error', err);
    });

    this.device.on('nowPlaying', (info) => {
      this.emit('now-playing', info);
    });
  }

  async sendKey(keyName, action) {
    if (!this.device) throw new Error('Not connected');
    const { Key } = await getLib();

    const keyMap = {
      'play_pause': Key.PlayPause,
      'left': Key.Left,
      'right': Key.Right,
      'down': Key.Down,
      'up': Key.Up,
      'select': Key.Select,
      'menu': Key.Menu,
      'top_menu': Key.TopMenu,
      'home': Key.Home,
      'home_hold': Key.HomeHold,
      'skip_backward': Key.SkipBackward,
      'skip_forward': Key.SkipForward,
      'volume_up': Key.VolumeUp,
      'volume_down': Key.VolumeDown,
    };

    const key = keyMap[keyName];
    if (key === undefined) throw new Error(`Unknown key: ${keyName}`);
    await this.device.sendKeyCommand(key);
  }

  async disconnect() {
    if (this.device) {
      try {
        await this.device.close();
      } catch (err) {
        console.error('Error closing device:', err);
      }
      this.device = null;
    }
    this.emit('disconnected');
  }

  isConnected() {
    return this.device !== null;
  }

  async destroy() {
    await this.disconnect();
    this.scanResults = {};
    this.pairingSession = null;
    this.removeAllListeners();
  }
}

module.exports = ATVService;
