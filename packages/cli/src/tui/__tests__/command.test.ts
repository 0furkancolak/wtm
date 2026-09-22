import { describe, expect, test } from 'bun:test';
import { parseTuiIntervalMs, tuiNonInteractiveRefusal } from '../command';

describe('tuiNonInteractiveRefusal', () => {
  test('allows a real TTY through', () => {
    expect(tuiNonInteractiveRefusal({ isTTY: true })).toBeNull();
  });

  test('refuses piped or redirected output with WTM_CONFIG_INVALID', () => {
    const refusal = tuiNonInteractiveRefusal({ isTTY: false });
    expect(refusal?.code).toBe('WTM_CONFIG_INVALID');
    expect(refusal?.severity).toBe('error');
    expect(refusal?.message).toContain('interactive terminal');
  });

  test('refuses when isTTY is entirely absent, as for a piped stream', () => {
    expect(tuiNonInteractiveRefusal({})?.code).toBe('WTM_CONFIG_INVALID');
  });
});

describe('parseTuiIntervalMs', () => {
  test('defaults to 3000ms when no --interval is given', () => {
    expect(parseTuiIntervalMs(undefined)).toBe(3000);
  });

  test('accepts an explicit value at or above the minimum', () => {
    expect(parseTuiIntervalMs('250')).toBe(250);
    expect(parseTuiIntervalMs('10000')).toBe(10000);
  });

  test('rejects a value below the minimum', () => {
    expect(() => parseTuiIntervalMs('100')).toThrow(RangeError);
  });

  test('rejects a non-numeric value', () => {
    expect(() => parseTuiIntervalMs('soon')).toThrow(RangeError);
  });
});
