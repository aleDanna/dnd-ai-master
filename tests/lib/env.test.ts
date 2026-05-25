import { afterEach, describe, expect, test, vi } from 'vitest';
import { envBool, envInt, envPositiveInt } from '@/lib/env';

const KEY = 'TEST_ENV_VAR_XYZ';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('envInt', () => {
  test('undefined → fallback', () => {
    expect(envInt(KEY, 42)).toBe(42);
  });

  test('empty string → fallback (Vercel sensitive footgun)', () => {
    vi.stubEnv(KEY, '');
    expect(envInt(KEY, 42)).toBe(42);
  });

  test('whitespace-only → fallback', () => {
    vi.stubEnv(KEY, '   ');
    expect(envInt(KEY, 42)).toBe(42);
  });

  test('valid integer → parsed', () => {
    vi.stubEnv(KEY, '200');
    expect(envInt(KEY, 42)).toBe(200);
  });

  test('zero → 0 (explicit disable is valid)', () => {
    vi.stubEnv(KEY, '0');
    expect(envInt(KEY, 42)).toBe(0);
  });

  test('negative integer → parsed (envInt allows negatives)', () => {
    vi.stubEnv(KEY, '-7');
    expect(envInt(KEY, 42)).toBe(-7);
  });

  test('garbage → fallback', () => {
    vi.stubEnv(KEY, 'abc');
    expect(envInt(KEY, 42)).toBe(42);
  });

  test('non-integer numeric → fallback', () => {
    vi.stubEnv(KEY, '1.5');
    expect(envInt(KEY, 42)).toBe(42);
  });

  test('surrounding whitespace is trimmed', () => {
    vi.stubEnv(KEY, '  200  ');
    expect(envInt(KEY, 42)).toBe(200);
  });
});

describe('envPositiveInt', () => {
  test('undefined → fallback', () => {
    expect(envPositiveInt(KEY, 100)).toBe(100);
  });

  test('empty string → fallback (Vercel sensitive footgun)', () => {
    vi.stubEnv(KEY, '');
    expect(envPositiveInt(KEY, 100)).toBe(100);
  });

  test('whitespace-only → fallback', () => {
    vi.stubEnv(KEY, '\t \n');
    expect(envPositiveInt(KEY, 100)).toBe(100);
  });

  test('valid positive integer → parsed', () => {
    vi.stubEnv(KEY, '250');
    expect(envPositiveInt(KEY, 100)).toBe(250);
  });

  test('zero → 0 (explicit disable is valid)', () => {
    vi.stubEnv(KEY, '0');
    expect(envPositiveInt(KEY, 100)).toBe(0);
  });

  test('negative → fallback (positive-only)', () => {
    vi.stubEnv(KEY, '-5');
    expect(envPositiveInt(KEY, 100)).toBe(100);
  });

  test('garbage → fallback', () => {
    vi.stubEnv(KEY, 'not-a-number');
    expect(envPositiveInt(KEY, 100)).toBe(100);
  });

  test('non-integer numeric → fallback', () => {
    vi.stubEnv(KEY, '12.34');
    expect(envPositiveInt(KEY, 100)).toBe(100);
  });
});

describe('envBool', () => {
  test('undefined → fallback', () => {
    expect(envBool(KEY, false)).toBe(false);
    expect(envBool(KEY, true)).toBe(true);
  });

  test('empty string → fallback (Vercel sensitive footgun)', () => {
    vi.stubEnv(KEY, '');
    expect(envBool(KEY, false)).toBe(false);
    expect(envBool(KEY, true)).toBe(true);
  });

  test('whitespace-only → fallback', () => {
    vi.stubEnv(KEY, '   ');
    expect(envBool(KEY, false)).toBe(false);
  });

  test('"true" / "1" → true', () => {
    vi.stubEnv(KEY, 'true');
    expect(envBool(KEY, false)).toBe(true);
    vi.stubEnv(KEY, '1');
    expect(envBool(KEY, false)).toBe(true);
  });

  test('"false" / "0" → false', () => {
    vi.stubEnv(KEY, 'false');
    expect(envBool(KEY, true)).toBe(false);
    vi.stubEnv(KEY, '0');
    expect(envBool(KEY, true)).toBe(false);
  });

  test('case-insensitive', () => {
    vi.stubEnv(KEY, 'TRUE');
    expect(envBool(KEY, false)).toBe(true);
    vi.stubEnv(KEY, 'False');
    expect(envBool(KEY, true)).toBe(false);
  });

  test('surrounding whitespace tolerated', () => {
    vi.stubEnv(KEY, '  true  ');
    expect(envBool(KEY, false)).toBe(true);
  });

  test('garbage → fallback', () => {
    vi.stubEnv(KEY, 'maybe');
    expect(envBool(KEY, false)).toBe(false);
    expect(envBool(KEY, true)).toBe(true);
  });
});
