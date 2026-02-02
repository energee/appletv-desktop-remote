declare module 'node-appletv-remote' {
  export interface ScanOptions {
    timeout?: number;
  }

  export interface DiscoveredDevice {
    name: string;
    address: string;
    port: number;
    companionPort?: number;
    deviceId?: string;
  }

  export function scan(options?: ScanOptions): Promise<DiscoveredDevice[]>;

  export class AppleTV {
    name: string;
    address: string;
    deviceId?: string;
    companionPort?: number;

    constructor(device: DiscoveredDevice);
    connect(credentials: Credentials): Promise<void>;
    connectCompanion(companionCredentials: unknown): Promise<void>;
    startPairing(): Promise<PairingSession>;
    startCompanionPairing(): Promise<PairingSession>;
    sendKeyCommand(key: Key): Promise<void>;
    close(): Promise<void>;
    removeAllListeners(): void;
    on(event: 'close', listener: () => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'nowPlaying', listener: (info: unknown) => void): void;
    on(event: 'companionClose', listener: () => void): void;
    on(event: 'companionError', listener: (err: Error) => void): void;
  }

  export class Credentials {
    companionCredentials?: unknown;
    constructor(airplay: unknown, companion?: unknown);
    serialize(): string;
    static deserialize(data: string): Credentials;
  }

  export interface PairingSession {
    finish(pin: string): Promise<unknown>;
  }

  export enum Key {
    PlayPause,
    Left,
    Right,
    Down,
    Up,
    Select,
    Menu,
    TopMenu,
    Home,
    HomeHold,
    SkipBackward,
    SkipForward,
    VolumeUp,
    VolumeDown,
  }
}
