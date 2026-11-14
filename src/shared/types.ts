export interface ATVCredentials {
  credentials: string;
  identifier: string;
}

/**
 * finishPair's result, saved as is under its identifier: the serialized AirPlay credentials, the
 * Apple TV's device ID, and its name for menus.
 */
export interface PairResult {
  credentials: string;
  identifier: string;
  name: string;
}

/** Persisted device information that may cross the native-to-renderer boundary. */
export interface SavedDevice {
  identifier: string;
  name: string;
  companionPaired: boolean;
}

export type ATVKeyName =
  | 'play_pause'
  | 'left'
  | 'right'
  | 'down'
  | 'up'
  | 'select'
  | 'menu'
  | 'top_menu'
  | 'home'
  | 'home_hold'
  | 'skip_backward'
  | 'skip_forward'
  | 'volume_up'
  | 'volume_down';

export type KeyboardKeyMap = Record<string, ATVKeyName>;

export type ConnectionDotState = 'connected' | 'connecting' | 'disconnected' | 'idle';

/** An AirPlay receiver the TV can play to; `id` is its output ID (the scan's `airplayPsi`). */
export interface Speaker {
  id: string;
  name: string;
  selected: boolean;
}

/** The library's PowerState: the TV reports `off` while asleep and keeps the connection open. */
export type PowerStatus = 'on' | 'off' | 'unknown';

/**
 * The sidecar's connection status, sent as the `state` event whenever it changes. `idle`: no
 * device chosen (or disconnected on request); `connecting`: connecting or waiting to retry;
 * `disconnected`: quick retries failed, now retrying every 30 s; `pairing`: scanning or pairing,
 * with no connect running.
 */
export interface ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'pairing';
}

/** Seconds from the Unix epoch to 2001-01-01, the epoch of the TV's MRP timestamps. */
export const MRP_EPOCH_OFFSET = 978307200;

/**
 * NowPlayingInfo.playbackState values: node-appletv-remote's PlaybackState enum (MRP
 * SetStateMessage.playbackState), copied because the webview cannot load the library.
 */
export const PlaybackState = {
  Unknown: 0,
  Playing: 1,
  Paused: 2,
  Stopped: 3,
  Interrupted: 4,
  Seeking: 5,
} as const;

/** A change on a TV other than the selected one, reported while the mini bar watches it. */
export interface WatchedTvUpdate {
  identifier: string;
  state?: ConnectionState;
  nowPlaying?: NowPlayingInfo;
}

/** The parts of the library's now-playing snapshot that reach the webview. */
export interface NowPlayingInfo {
  /** The item's title, or the app's name while it plays or is paused without a title or artist. */
  title?: string;
  artist?: string;
  album?: string;
  /** A PlaybackState value. */
  playbackState?: number;
  /** Seconds; 0 or missing when the item has no known length (live TV). */
  duration?: number;
  /** Seconds into the item as of `timestamp`. */
  elapsedTime?: number;
  playbackRate?: number;
  /** When `elapsedTime` was measured: the TV's clock, in seconds since 2001-01-01 UTC. */
  timestamp?: number;
}
