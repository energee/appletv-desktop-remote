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

export type ConnectionDotState = 'connected' | 'connecting' | 'disconnected';

/**
 * The sidecar's connection status, sent as the `state` event whenever it changes. `idle`: no
 * device chosen (or disconnected on request); `connecting`: connecting or waiting to retry;
 * `disconnected`: gave up retrying; `pairing`: scanning or pairing, with no connect running.
 */
export interface ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'pairing';
}

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

/** The parts of the library's now-playing snapshot that reach the webview. */
export interface NowPlayingInfo {
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
