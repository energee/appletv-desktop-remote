import { describe, it, expect } from 'vitest';
import { safeParse } from '../../src/renderer/state';

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
