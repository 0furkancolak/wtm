import { describe, expect, test } from 'bun:test';
import type { SocketAddressPolicy } from '../../ports';
import {
  DaemonSocketPathTooLongError,
  assertDaemonSocketPathFits,
  boundDaemonSocketPath,
  darwinSocketAddressPolicy,
  darwinSocketPathLimitBytes,
  linuxSocketAddressPolicy,
  linuxSocketPathLimitBytes,
  measureDaemonSocketPath,
  socketAddressPolicyFor,
} from '../index';

/** A path of exactly `bytes` bytes, all ASCII, so the length is the byte count. */
function pathOfBytes(bytes: number): string {
  return `/${'h'.repeat(bytes - 1)}`;
}

describe('socket address policy', () => {
  test('states sizeof(sun_path) for each platform: 104 on macOS, 108 on Linux', () => {
    expect(darwinSocketPathLimitBytes).toBe(104);
    expect(linuxSocketPathLimitBytes).toBe(108);
    expect(darwinSocketAddressPolicy.limitBytes).toBe(darwinSocketPathLimitBytes);
    expect(linuxSocketAddressPolicy.limitBytes).toBe(linuxSocketPathLimitBytes);
  });

  test('is selected by platform id', () => {
    expect(socketAddressPolicyFor('darwin')).toBe(darwinSocketAddressPolicy);
    expect(socketAddressPolicyFor('linux')).toBe(linuxSocketAddressPolicy);
  });

  test('both platforms derive the bound path the same way, because the trick is not an OS fact', () => {
    // Substituting the first character of the name is a property of the derivation, not of the
    // kernel: what differs between the platforms is only how many bytes the result may be.
    for (const policy of [darwinSocketAddressPolicy, linuxSocketAddressPolicy] as SocketAddressPolicy[]) {
      expect(policy.boundPathFor('/tmp/wtm/wtmd.sock')).toBe(boundDaemonSocketPath('/tmp/wtm/wtmd.sock'));
      expect(policy.boundPathFor('/tmp/wtm/.wtmd.sock')).toBe('/tmp/wtm/_wtmd.sock');
    }
  });

  test('the four bytes between the two limits are refused on macOS and accepted on Linux', () => {
    for (const bytes of [105, 106, 107, 108]) {
      const path = pathOfBytes(bytes);

      expect(measureDaemonSocketPath(path, darwinSocketAddressPolicy.limitBytes).fits).toBe(false);
      expect(measureDaemonSocketPath(path, linuxSocketAddressPolicy.limitBytes).fits).toBe(true);
    }
  });

  test('Linux refuses at 109, one byte past its own sun_path', () => {
    const limit = linuxSocketAddressPolicy.limitBytes;

    expect(measureDaemonSocketPath(pathOfBytes(limit), limit).fits).toBe(true);
    expect(() => assertDaemonSocketPathFits(pathOfBytes(limit), limit)).not.toThrow();
    expect(measureDaemonSocketPath(pathOfBytes(limit + 1), limit).fits).toBe(false);
    expect(() => assertDaemonSocketPathFits(pathOfBytes(limit + 1), limit))
      .toThrow(DaemonSocketPathTooLongError);
  });

  test('the refusal names whichever limit is in force, not a limit the reader is not running under', () => {
    const path = pathOfBytes(linuxSocketPathLimitBytes + 1);
    let thrown: unknown;
    try { assertDaemonSocketPathFits(path, linuxSocketPathLimitBytes); } catch (error) { thrown = error; }

    const error = thrown as DaemonSocketPathTooLongError;
    expect(error.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(error.message).toContain(`${linuxSocketPathLimitBytes}-byte limit`);
    expect(error.message).not.toContain(`${darwinSocketPathLimitBytes}-byte limit`);
    expect(error.context).toMatchObject({
      limitBytes: linuxSocketPathLimitBytes,
      byteLength: linuxSocketPathLimitBytes + 1,
      exceededBy: 1,
    });
  });

  test('every policy flows through the same measurement, so neither platform gets its own machinery', () => {
    const path = pathOfBytes(120);

    for (const policy of [darwinSocketAddressPolicy, linuxSocketAddressPolicy]) {
      const measurement = measureDaemonSocketPath(path, policy.limitBytes);

      expect(measurement.limitBytes).toBe(policy.limitBytes);
      expect(measurement.boundPath).toBe(policy.boundPathFor(path));
      expect(measurement.exceededBy).toBe(120 - policy.limitBytes);
    }
  });
});
