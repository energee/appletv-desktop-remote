import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDevices, loadActiveDevice, loadDevices } from '../../src/renderer/state';

const api = vi.hoisted(() => ({
  migrateDevices: vi.fn(),
  loadDevices: vi.fn(),
  activeDevice: vi.fn(),
  selectDevice: vi.fn(),
  removeDevice: vi.fn(),
}));
vi.mock('../../src/shared/desktop-api', () => ({ desktopAPI: api }));

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('secure device state migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', new MemoryStorage());
    api.loadDevices.mockResolvedValue([]);
    api.activeDevice.mockResolvedValue(null);
  });

  it('only clears old credential bytes after the native vault acknowledges migration', async () => {
    localStorage.setItem('remote_credentials', '{"tv":{"identifier":"id","credentials":"secret"}}');
    localStorage.setItem('atvcreds', '{"identifier":"id","credentials":"secret"}');
    const migration = Promise.withResolvers<void>();
    api.migrateDevices.mockReturnValueOnce(migration.promise);

    const initializing = initializeDevices();
    expect(localStorage.getItem('remote_credentials')).toContain('secret');
    expect(localStorage.getItem('atvcreds')).toContain('secret');
    migration.resolve();
    await initializing;

    expect(api.migrateDevices).toHaveBeenCalledWith({
      devices: '{"tv":{"identifier":"id","credentials":"secret"}}',
      active: '{"identifier":"id","credentials":"secret"}',
    });
    expect(localStorage.getItem('remote_credentials')).toBeNull();
    expect(localStorage.getItem('atvcreds')).toBeNull();
    expect(loadDevices()).toEqual({});
  });

  it('retains legacy credentials and does not replace metadata when native storage fails', async () => {
    const devices = '{"tv":{"identifier":"id","credentials":"secret"}}';
    const active = '{"identifier":"id","credentials":"secret"}';
    localStorage.setItem('remote_credentials', devices);
    localStorage.setItem('atvcreds', active);
    api.migrateDevices.mockRejectedValue(new Error('Secure storage: denied'));

    await expect(initializeDevices()).rejects.toThrow('Secure storage: denied');

    expect(localStorage.getItem('remote_credentials')).toBe(devices);
    expect(localStorage.getItem('atvcreds')).toBe(active);
    expect(api.loadDevices).not.toHaveBeenCalled();
  });

  it('caches only metadata returned by native storage', async () => {
    api.loadDevices.mockResolvedValue([
      { identifier: 'id', name: 'Living Room', companionPaired: true },
    ]);
    api.activeDevice.mockResolvedValue('id');

    await initializeDevices();

    expect(loadDevices()).toEqual({
      id: { identifier: 'id', name: 'Living Room', companionPaired: true },
    });
    expect(loadActiveDevice()).toEqual({
      identifier: 'id',
      name: 'Living Room',
      companionPaired: true,
    });
    expect(JSON.stringify(loadDevices())).not.toContain('credentials');
  });
});
