declare module 'node-appletv-remote' {
  export interface ScanOptions {
    timeout?: number;
    /** Stop browsing early once a device satisfies this; `timeout` still caps the wait. */
    until?: (device: DiscoveredDevice) => boolean;
    /** Keep only devices for which this returns true. */
    filter?: (device: DiscoveredDevice) => boolean;
  }

  export interface DiscoveredDevice {
    name: string;
    address: string;
    port: number;
    deviceId?: string;
    /** Such as `AppleTV6,2`; other AirPlay receivers report their own (`Mac16,12`, `7104X`). */
    model: string;
  }

  export function scan(options?: ScanOptions): Promise<DiscoveredDevice[]>;

  export class AppleTV {
    name: string;
    address: string;
    deviceId?: string;

    constructor(device: DiscoveredDevice);
    connect(credentials: Credentials): Promise<void>;
    startPairing(): Promise<PairingSession>;
    sendKeyCommand(key: Key): Promise<void>;
    setPosition(seconds: number): Promise<void>;
    close(): Promise<void>;
    removeAllListeners(): void;
    on(event: 'close', listener: () => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'nowPlaying', listener: (info: NowPlayingInfo) => void): void;
  }

  export class Credentials {
    constructor(airplay: unknown);
    serialize(): string;
    static deserialize(data: string): Credentials;
  }

  /** Only the fields this app reads; playbackState is a PlaybackState value. */
  export interface NowPlayingInfo {
    title: string;
    artist: string;
    album: string;
    playbackState: number;
    playerIdentifier?: string;
    /** Seconds; 0 when unknown. */
    duration: number;
    /** Seconds into the item as of `timestamp`, which is the TV's clock in seconds since 2001. */
    elapsedTime: number;
    playbackRate: number;
    timestamp: number;
  }

  export interface PairingSession {
    finish(pin: string): Promise<unknown>;
  }

  export enum Key {
    PlayPause,
    Play,
    Pause,
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

declare module 'node-appletv-remote/dist/mrp/messages.js' {
  /** The HID usage each key press sends; mutable, see getLib in atv_service.ts. */
  export const HID_KEY_MAP: Record<string, { usagePage: number; usage: number }>;
}
