// Extra connections behind the mini bar's rows: one ATVService per other saved Apple TV, so each
// row shows that TV's playback and can control it. The selected TV keeps the main ATVService.
import { EventEmitter } from 'node:events';
import type { ATVCredentials, ATVKeyName, ConnectionState } from '../shared/types';

/** The parts of ATVService a watcher uses. */
export interface WatchedService extends EventEmitter {
  connect(credentials: ATVCredentials): void;
  sendKey(key: ATVKeyName): Promise<void>;
  destroy(): Promise<void>;
}

export type WatchUpdate =
  | { identifier: string; state: ConnectionState }
  | { identifier: string; nowPlaying: unknown };

export default class TvWatchers extends EventEmitter {
  private readonly services = new Map<string, WatchedService>();

  constructor(private readonly createService: () => WatchedService) {
    super();
  }

  /** Keeps a connection to the TV, reporting it as `update` events. Repeat calls do nothing. */
  watch(credentials: ATVCredentials): void {
    const { identifier } = credentials;
    if (this.services.has(identifier)) return;
    const service = this.createService();
    this.services.set(identifier, service);
    service.on('state', (state: ConnectionState) => this.emit('update', { identifier, state }));
    service.on('now-playing', (nowPlaying: unknown) =>
      this.emit('update', { identifier, nowPlaying }),
    );
    // An EventEmitter throws on an unhandled 'error'. The service reconnects by itself.
    service.on('error', (error: Error) => console.error(`Watched TV: ${error.message}`));
    service.connect(credentials);
  }

  async unwatch(identifier: string): Promise<void> {
    const service = this.services.get(identifier);
    this.services.delete(identifier);
    await service?.destroy();
  }

  async sendKey(identifier: string, key: ATVKeyName): Promise<void> {
    const service = this.services.get(identifier);
    if (!service) throw new Error('That Apple TV is not connected.');
    await service.sendKey(key);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.services.keys()].map((identifier) => this.unwatch(identifier)));
  }
}
