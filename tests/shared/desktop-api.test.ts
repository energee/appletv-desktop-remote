// Checks how desktopAPI maps calls onto Tauri commands and surfaces host errors.
import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const listen = vi.fn(async () => () => {});
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.stubGlobal('window', { addEventListener: vi.fn() });

const { desktopAPI } = await import('../../src/shared/desktop-api');

describe('desktopAPI', () => {
  it('rejects with an Error carrying the Rust message so the renderer can display it', async () => {
    invoke.mockRejectedValue('Cannot start Apple TV backend: missing');

    await expect(desktopAPI.scan()).rejects.toThrow(
      new Error('Cannot start Apple TV backend: missing'),
    );
  });

  it('hands the credential export to the native save dialog action', async () => {
    invoke.mockResolvedValue(true);

    await expect(desktopAPI.exportCredentials('{"version":1}')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('desktop_action', {
      action: 'exportCredentials',
      args: { contents: '{"version":1}' },
    });
  });

  it('reads the credential import through the native open dialog action', async () => {
    invoke.mockResolvedValue(null);

    await expect(desktopAPI.importCredentials()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith('desktop_action', {
      action: 'importCredentials',
      args: {},
    });
  });

  it('passes the numeric playback state through with now-playing', async () => {
    await desktopAPI.start();
    const [, onBackendEvent] = listen.mock.calls.find(([name]) => name === 'backend-event')! as [
      string,
      (event: { payload: { event: string; data: unknown } }) => void,
    ];
    const nowPlaying = vi.fn();
    desktopAPI.onAtvNowPlaying(nowPlaying);

    onBackendEvent({
      payload: { event: 'now-playing', data: { title: 'Movie', playbackState: 1, extra: true } },
    });
    onBackendEvent({ payload: { event: 'now-playing', data: { playbackState: 'playing' } } });

    expect(nowPlaying.mock.calls).toEqual([[{ title: 'Movie', playbackState: 1 }], [{}]]);
  });

  it('passes on the selected outputs only as a list of IDs', async () => {
    await desktopAPI.start();
    const [, onBackendEvent] = listen.mock.calls.find(([name]) => name === 'backend-event')! as [
      string,
      (event: { payload: { event: string; data: unknown } }) => void,
    ];
    const outputs = vi.fn();
    desktopAPI.onAtvOutputs(outputs);

    for (const data of [['psi-kitchen'], 'psi-kitchen', [1]]) {
      onBackendEvent({ payload: { event: 'outputs', data } });
    }
    expect(outputs.mock.calls).toEqual([[['psi-kitchen']]]);
  });

  it('passes on the absolute volume, or null when there is none', async () => {
    await desktopAPI.start();
    const [, onBackendEvent] = listen.mock.calls.find(([name]) => name === 'backend-event')! as [
      string,
      (event: { payload: { event: string; data: unknown } }) => void,
    ];
    const volume = vi.fn();
    desktopAPI.onAtvVolume(volume);

    for (const data of [40, null, 'loud']) {
      onBackendEvent({ payload: { event: 'volume', data } });
    }
    expect(volume.mock.calls).toEqual([[40], [null], [null]]);
  });

  it('passes on only known power states', async () => {
    await desktopAPI.start();
    const [, onBackendEvent] = listen.mock.calls.find(([name]) => name === 'backend-event')! as [
      string,
      (event: { payload: { event: string; data: unknown } }) => void,
    ];
    const power = vi.fn();
    desktopAPI.onAtvPowerState(power);

    for (const data of ['off', 'on', 'unknown', 'asleep', 1]) {
      onBackendEvent({ payload: { event: 'power-state', data } });
    }
    expect(power.mock.calls).toEqual([['off'], ['on'], ['unknown']]);
  });

  it('passes the app name through with now-playing', async () => {
    await desktopAPI.start();
    const [, onBackendEvent] = listen.mock.calls.find(([name]) => name === 'backend-event')! as [
      string,
      (event: { payload: { event: string; data: unknown } }) => void,
    ];
    const nowPlaying = vi.fn();
    desktopAPI.onAtvNowPlaying(nowPlaying);

    onBackendEvent({
      payload: { event: 'now-playing', data: { title: 'Movie', appDisplayName: 'TV' } },
    });
    onBackendEvent({ payload: { event: 'now-playing', data: { appDisplayName: 7 } } });

    expect(nowPlaying.mock.calls).toEqual([[{ title: 'Movie', appDisplayName: 'TV' }], [{}]]);
  });

  it('passes the playing position through with now-playing, for the seek bar', async () => {
    await desktopAPI.start();
    const [, onBackendEvent] = listen.mock.calls.find(([name]) => name === 'backend-event')! as [
      string,
      (event: { payload: { event: string; data: unknown } }) => void,
    ];
    const nowPlaying = vi.fn();
    desktopAPI.onAtvNowPlaying(nowPlaying);
    const timing = { duration: 3600, elapsedTime: 60, playbackRate: 1, timestamp: 815000000 };

    onBackendEvent({ payload: { event: 'now-playing', data: { ...timing, duration: '1h' } } });
    onBackendEvent({ payload: { event: 'now-playing', data: timing } });

    const { duration: _duration, ...withoutDuration } = timing;
    expect(nowPlaying.mock.calls).toEqual([[withoutDuration], [timing]]);
  });

  it('asks the sidecar to seek', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await desktopAPI.seek(42);
    expect(invoke).toHaveBeenCalledWith('backend_request', {
      method: 'seek',
      params: { seconds: 42 },
    });
  });
});
