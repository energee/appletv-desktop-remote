// Watchers hold the extra connections behind the mini bar's live rows; these tests use fake
// services, since ATVService has its own suite.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import TvWatchers from '../../src/sidecar/watchers';

class FakeService extends EventEmitter {
  connect = vi.fn();
  sendKey = vi.fn(async () => {});
  destroy = vi.fn(async () => {});
}

function setup() {
  const services: FakeService[] = [];
  const watchers = new TvWatchers(() => {
    const service = new FakeService();
    services.push(service);
    return service;
  });
  const updates = vi.fn();
  watchers.on('update', updates);
  return { services, watchers, updates };
}

const tv = { identifier: 'tv', credentials: 'keys' };

describe('TvWatchers', () => {
  it('connects once per TV, however often it is asked', () => {
    const { services, watchers } = setup();
    watchers.watch(tv);
    watchers.watch(tv);

    expect(services).toHaveLength(1);
    expect(services[0].connect).toHaveBeenCalledWith(tv);
  });

  it('labels each update with its TV', () => {
    const { services, watchers, updates } = setup();
    watchers.watch(tv);

    services[0].emit('state', { status: 'connected' });
    services[0].emit('now-playing', { title: 'Movie' });

    expect(updates.mock.calls).toEqual([
      [{ identifier: 'tv', state: { status: 'connected' } }],
      [{ identifier: 'tv', nowPlaying: { title: 'Movie' } }],
    ]);
  });

  it('survives a connection error, which would otherwise crash the sidecar', () => {
    const { services, watchers } = setup();
    watchers.watch(tv);

    expect(() => services[0].emit('error', new Error('lost'))).not.toThrow();
  });

  it('closes a TV it stops watching, and can watch it again', async () => {
    const { services, watchers } = setup();
    watchers.watch(tv);
    await watchers.unwatch('tv');

    expect(services[0].destroy).toHaveBeenCalled();
    watchers.watch(tv);
    expect(services).toHaveLength(2);
  });

  it('sends keys only to the named TV', async () => {
    const { services, watchers } = setup();
    watchers.watch(tv);
    watchers.watch({ identifier: 'other', credentials: 'keys' });

    await watchers.sendKey('other', 'play_pause');

    expect(services[0].sendKey).not.toHaveBeenCalled();
    expect(services[1].sendKey).toHaveBeenCalledWith('play_pause');
  });

  it('rejects a key for a TV it is not watching', async () => {
    const { watchers } = setup();
    await expect(watchers.sendKey('tv', 'play_pause')).rejects.toThrow('not connected');
  });

  it('closes everything on shutdown', async () => {
    const { services, watchers } = setup();
    watchers.watch(tv);
    await watchers.closeAll();

    expect(services[0].destroy).toHaveBeenCalled();
  });
});
