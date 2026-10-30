import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadActiveDevice,
  loadDevices,
  safeParse,
  saveActiveDevice,
  saveDevices,
} from '../../src/renderer/state';

describe('safeParse', () => {
  it('parses valid JSON', () => {
    expect(safeParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeParse('"hello"', '')).toBe('hello');
    expect(safeParse('42', 0)).toBe(42);
    expect(safeParse('true', false)).toBe(true);
  });

  it('returns fallback for invalid JSON', () => {
    expect(safeParse('not json', 'fallback')).toBe('fallback');
    expect(safeParse('{broken', {})).toEqual({});
  });

  it('returns fallback for null', () => {
    expect(safeParse(null, 'default')).toBe('default');
    expect(safeParse(null, false)).toBe(false);
  });

  it('returns fallback for empty string', () => {
    expect(safeParse('', 42)).toBe(42);
  });
});

describe('saved devices', () => {
  const tv = { credentials: 'c', identifier: 'tv' };
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });

  it('saves and loads devices', () => {
    saveDevices({ tv: { ...tv, name: 'Living Room' } });
    expect(loadDevices()).toEqual({ tv: { ...tv, name: 'Living Room' } });
  });

  // Older releases keyed devices by scan label, so a TV whose IP changed was saved twice.
  it('keys devices saved by scan label by identifier, keeping the newest pairing', () => {
    const newer = { credentials: 'new', identifier: 'tv' };
    store.set(
      'remote_credentials',
      JSON.stringify({ 'Living Room (1.2.3.4)': tv, 'Living Room (1.2.3.9)': newer }),
    );
    expect(loadDevices()).toEqual({ tv: { ...newer, name: 'Living Room' } });
    expect(JSON.parse(store.get('remote_credentials')!)).toEqual({
      tv: { ...newer, name: 'Living Room' },
    });
  });

  it('has no devices when none or only unreadable data is saved', () => {
    expect(loadDevices()).toEqual({});
    store.set('remote_credentials', '{broken');
    expect(loadDevices()).toEqual({});
  });

  it('decodes entries older releases stored as JSON strings and saves them decoded', () => {
    store.set(
      'remote_credentials',
      JSON.stringify({ Old: JSON.stringify(JSON.stringify(tv)), Bad: 'not json' }),
    );
    expect(loadDevices()).toEqual({ tv: { ...tv, name: 'Old' } });
    expect(store.get('remote_credentials')).toBe(JSON.stringify({ tv: { ...tv, name: 'Old' } }));
  });

  it('saves, loads, and clears the active device', () => {
    expect(loadActiveDevice()).toBeNull();
    saveActiveDevice(tv);
    expect(loadActiveDevice()).toEqual(tv);
    saveActiveDevice(null);
    expect(store.has('atvcreds')).toBe(false);
    store.set('atvcreds', '{broken');
    expect(loadActiveDevice()).toBeNull();
  });
});
