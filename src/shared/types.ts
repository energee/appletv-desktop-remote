export interface ATVCredentials {
  credentials: string;
  identifier: string;
}

export interface PairResult {
  needsCompanionPin?: boolean;
  credentials?: string;
  identifier?: string;
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

export type PairingPhase = 'airplay' | 'companion' | null;

export type ConnectionDotState = 'connected' | 'connecting' | 'disconnected';
