"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
// node-appletv-remote is ESM-only. Use dynamic import wrapper.
let atvLib = null;
async function getLib() {
    if (!atvLib) {
        atvLib = await import('node-appletv-remote');
    }
    return atvLib;
}
class ATVService extends events_1.EventEmitter {
    device = null;
    scanResults = {};
    pairingSession = null;
    pairingPhase = null;
    airplayCreds = null;
    async scan(timeout = 2000) {
        const { scan } = await getLib();
        const devices = await scan({ timeout });
        this.scanResults = {};
        return devices.map((d) => {
            const label = `${d.name} (${d.address})`;
            this.scanResults[label] = d;
            return label;
        });
    }
    async startPair(deviceLabel) {
        const { AppleTV } = await getLib();
        const discoveredDevice = this.scanResults[deviceLabel];
        if (!discoveredDevice)
            throw new Error(`Device not found: ${deviceLabel}`);
        console.log(`startPair: device=${discoveredDevice.name}, companionPort=${discoveredDevice.companionPort}, address=${discoveredDevice.address}`);
        this.device = new AppleTV(discoveredDevice);
        this.pairingPhase = 'airplay';
        this.pairingSession = await this.device.startPairing();
        console.log('startPair: AirPlay pairing started, PIN should appear on TV');
    }
    async finishPair(pin) {
        if (!this.pairingSession)
            throw new Error('No active pairing session');
        const { Credentials } = await getLib();
        if (this.pairingPhase === 'airplay') {
            this.airplayCreds = await this.pairingSession.finish(pin);
            console.log('finishPair: AirPlay pairing complete, starting companion pairing...');
            this.pairingPhase = 'companion';
            this.pairingSession = await this.device.startCompanionPairing();
            console.log('finishPair: Companion pairing started, PIN should appear on TV');
            return { needsCompanionPin: true };
        }
        if (this.pairingPhase === 'companion') {
            const companionCreds = await this.pairingSession.finish(pin);
            console.log('finishPair: Companion pairing complete');
            const credentials = new Credentials(this.airplayCreds, companionCreds);
            const serialized = credentials.serialize();
            this.pairingSession = null;
            this.pairingPhase = null;
            this.airplayCreds = null;
            return {
                credentials: serialized,
                identifier: this.device.deviceId || 'unknown',
            };
        }
        return {};
    }
    async connect(credsData) {
        const { AppleTV, Credentials, scan } = await getLib();
        const credentials = Credentials.deserialize(credsData.credentials);
        if (!this.device) {
            const devices = await scan({ timeout: 2000 });
            const match = devices.find((d) => d.deviceId === credsData.identifier);
            if (!match) {
                this.emit('connection-failure');
                throw new Error('Device not found on network');
            }
            this.device = new AppleTV(match);
        }
        try {
            await this.device.connect(credentials);
            this.setupListeners();
            if (credentials.companionCredentials && this.device.companionPort) {
                try {
                    await this.device.connectCompanion(credentials.companionCredentials);
                    console.log('Companion connected');
                }
                catch (err) {
                    console.error('Companion connect failed (non-fatal):', err.message);
                }
            }
            this.emit('connected');
        }
        catch (err) {
            this.emit('connection-failure');
            throw err;
        }
    }
    setupListeners() {
        if (!this.device)
            return;
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
        this.device.on('companionClose', () => {
            console.log('Companion connection closed');
        });
        this.device.on('companionError', (err) => {
            console.error('Companion error:', err);
        });
    }
    async sendKey(keyName) {
        if (!this.device)
            throw new Error('Not connected');
        const { Key } = await getLib();
        const keyMap = {
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
        const key = keyMap[keyName];
        if (key === undefined)
            throw new Error(`Unknown key: ${keyName}`);
        await this.device.sendKeyCommand(key);
    }
    async disconnect() {
        if (this.device) {
            try {
                await this.device.close();
            }
            catch (err) {
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
        this.pairingPhase = null;
        this.airplayCreds = null;
        this.removeAllListeners();
    }
}
exports.default = ATVService;
