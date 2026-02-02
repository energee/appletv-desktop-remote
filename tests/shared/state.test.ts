import { describe, it, expect, beforeEach } from 'vitest';
import {
  safeParse,
  setAtvConnected,
  setAtvCredentials,
  setPairDevice,
  setConnecting,
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

describe('state setters', () => {
  beforeEach(() => {
    setAtvConnected(false);
    setAtvCredentials(false);
    setPairDevice('');
    setConnecting(false);
  });

  it('setAtvConnected updates atv_connected', async () => {
    setAtvConnected(true);
    // Re-import to get the updated value
    const mod = await import('../../src/renderer/state');
    expect(mod.atv_connected).toBe(true);
  });

  it('setAtvCredentials updates atv_credentials', async () => {
    const creds = { credentials: 'test', identifier: 'id1' };
    setAtvCredentials(creds);
    const mod = await import('../../src/renderer/state');
    expect(mod.atv_credentials).toEqual(creds);
  });

  it('setPairDevice updates pairDevice', async () => {
    setPairDevice('Test Device');
    const mod = await import('../../src/renderer/state');
    expect(mod.pairDevice).toBe('Test Device');
  });

  it('setConnecting updates connecting', async () => {
    setConnecting(true);
    const mod = await import('../../src/renderer/state');
    expect(mod.connecting).toBe(true);
  });
});
