import { describe, expect, test } from 'bun:test';
import { wtmErrorCodeSchema, wtmErrorSchema } from '@wtm/protocol';
import {
  DaemonSocketPathTooLongError,
  assertDaemonSocketPathFits,
  boundDaemonSocketPath,
  daemonSocketPathLimitBytes,
  measureDaemonSocketPath,
  publishedDaemonSocketPath,
} from '../daemon-socket';

/** A home whose published path is exactly at the limit. One byte more and nothing binds. */
const bandHome = `/${'h'.repeat(61)}`;

describe('daemon socket path', () => {
  test('publishes the documented per-user path', () => {
    expect(publishedDaemonSocketPath('/Users/x')).toBe('/Users/x/Library/Application Support/WTM/wtmd.sock');
  });

  test('derives the private bind path by substituting the first character, not by prefixing', () => {
    const published = publishedDaemonSocketPath('/Users/x');

    expect(boundDaemonSocketPath(published)).toBe('/Users/x/Library/Application Support/WTM/.tmd.sock');
    expect(boundDaemonSocketPath('/tmp/wtm/.wtmd.sock')).toBe('/tmp/wtm/_wtmd.sock');
    // A one-character name would substitute to `.`, which names the directory itself.
    expect(boundDaemonSocketPath('/tmp/wtm/a')).toBe('/tmp/wtm/_');
  });

  test('the bound path never outgrows the published one, so no length band exists between them', () => {
    for (const path of [
      publishedDaemonSocketPath('/Users/x'),
      publishedDaemonSocketPath(bandHome),
      '/tmp/wtm/.wtmd.sock',
      '/tmp/wtm/a',
      '/tmp/wtm/ümd.sock',
    ]) {
      expect(Buffer.byteLength(boundDaemonSocketPath(path))).toBeLessThanOrEqual(Buffer.byteLength(path));
    }
  });

  test('measures the longer of the two addresses, because both reach bind() or connect()', () => {
    const published = publishedDaemonSocketPath('/Users/x');
    const measurement = measureDaemonSocketPath(published);

    expect(measurement.boundPath).toBe(boundDaemonSocketPath(published));
    expect(measurement.byteLength).toBe(Math.max(
      Buffer.byteLength(published),
      Buffer.byteLength(boundDaemonSocketPath(published)),
    ));
    expect(measurement.limitBytes).toBe(daemonSocketPathLimitBytes);
    expect(measurement.fits).toBe(true);

    // A shorter bound path must not lower the measurement below the published address.
    const dotted = measureDaemonSocketPath('/tmp/wtm/ümd.sock');
    expect(Buffer.byteLength(dotted.boundPath)).toBeLessThan(Buffer.byteLength(dotted.publishedPath));
    expect(dotted.measuredPath).toBe(dotted.publishedPath);
  });

  test('the byte at the limit passes and the byte past it is refused', () => {
    const atLimit = publishedDaemonSocketPath(bandHome);
    const overLimit = publishedDaemonSocketPath(`${bandHome}h`);

    expect(Buffer.byteLength(atLimit)).toBe(daemonSocketPathLimitBytes);
    expect(measureDaemonSocketPath(atLimit).fits).toBe(true);
    expect(() => assertDaemonSocketPathFits(atLimit)).not.toThrow();

    expect(Buffer.byteLength(overLimit)).toBe(daemonSocketPathLimitBytes + 1);
    expect(measureDaemonSocketPath(overLimit).fits).toBe(false);
    expect(() => assertDaemonSocketPathFits(overLimit)).toThrow(DaemonSocketPathTooLongError);
  });

  test('measures bytes, not code units, so a non-ASCII home is not under-counted', () => {
    // Each 'ü' is two UTF-8 bytes: 40 code units, 80 bytes.
    const home = `/${'ü'.repeat(40)}`;
    const published = publishedDaemonSocketPath(home);

    expect(published.length).toBeLessThanOrEqual(daemonSocketPathLimitBytes);
    expect(Buffer.byteLength(published)).toBeGreaterThan(daemonSocketPathLimitBytes);
    expect(measureDaemonSocketPath(published).byteLength).toBe(Buffer.byteLength(published));
    expect(measureDaemonSocketPath(published).fits).toBe(false);
  });

  test('the refusal names the measured length, the limit, and the offending path', () => {
    const published = publishedDaemonSocketPath(`${bandHome}h`);
    let thrown: unknown;
    try { assertDaemonSocketPathFits(published); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(DaemonSocketPathTooLongError);
    const error = thrown as DaemonSocketPathTooLongError;
    expect(error.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(error.severity).toBe('error');
    expect(error.message).toContain(String(daemonSocketPathLimitBytes + 1));
    expect(error.message).toContain(String(daemonSocketPathLimitBytes));
    expect(error.message).toContain(published);
    expect(error.context).toMatchObject({
      path: published,
      byteLength: daemonSocketPathLimitBytes + 1,
      limitBytes: daemonSocketPathLimitBytes,
      publishedPath: published,
      boundPath: boundDaemonSocketPath(published),
    });
    expect(error.remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);
  });

  test('the refusal is a registered error the envelope can carry unchanged', () => {
    const error = new DaemonSocketPathTooLongError(
      measureDaemonSocketPath(publishedDaemonSocketPath(`${bandHome}h`)),
    );

    expect(wtmErrorCodeSchema.options).toContain(error.code);
    expect(wtmErrorSchema.parse({
      code: error.code,
      message: error.message,
      severity: error.severity,
      context: error.context,
      remediation: error.remediation,
    }).code).toBe('WTM_SOCKET_PATH_TOO_LONG');
  });
});
