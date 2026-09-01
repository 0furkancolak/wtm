import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { wtmErrorCodeSchema, wtmErrorSchema } from '@wtm/protocol';
import {
  DaemonSocketPathTooLongError,
  assertDaemonSocketPathFits,
  boundDaemonSocketPath,
  darwinSocketPathLimitBytes,
  measureDaemonSocketPath,
  publishedDaemonSocketPath,
} from '../index';

/**
 * The socket root macOS resolves to, spelled here rather than imported.
 *
 * `publishedDaemonSocketPath` takes the root the platform names, so these cases have to name one
 * — and every length in this suite is a length of the macOS path, which is the path Increment B
 * measured the 104-byte limit against. Spelling it out keeps that provenance rather than binding
 * this suite to whatever `PlatformPaths` resolves on the host it runs on.
 */
function darwinSocketRoot(home: string): string {
  return join(home, 'Library', 'Application Support', 'WTM');
}

/** A home whose published path is exactly at the limit. One byte more and nothing binds. */
const bandHome = `/${'h'.repeat(61)}`;

describe('daemon socket path', () => {
  test('publishes the documented per-user path', () => {
    expect(publishedDaemonSocketPath(darwinSocketRoot('/Users/x')))
      .toBe('/Users/x/Library/Application Support/WTM/wtmd.sock');
  });

  test('derives the private bind path by substituting the first character, not by prefixing', () => {
    const published = publishedDaemonSocketPath(darwinSocketRoot('/Users/x'));

    expect(boundDaemonSocketPath(published)).toBe('/Users/x/Library/Application Support/WTM/.tmd.sock');
    expect(boundDaemonSocketPath('/tmp/wtm/.wtmd.sock')).toBe('/tmp/wtm/_wtmd.sock');
    // A one-character name would substitute to `.`, which names the directory itself.
    expect(boundDaemonSocketPath('/tmp/wtm/a')).toBe('/tmp/wtm/_');
  });

  test('the bound path never outgrows the published one, so no length band exists between them', () => {
    for (const path of [
      publishedDaemonSocketPath(darwinSocketRoot('/Users/x')),
      publishedDaemonSocketPath(darwinSocketRoot(bandHome)),
      '/tmp/wtm/.wtmd.sock',
      '/tmp/wtm/a',
      '/tmp/wtm/ümd.sock',
    ]) {
      expect(Buffer.byteLength(boundDaemonSocketPath(path))).toBeLessThanOrEqual(Buffer.byteLength(path));
    }
  });

  test('measures the longer of the two addresses, because both reach bind() or connect()', () => {
    const published = publishedDaemonSocketPath(darwinSocketRoot('/Users/x'));
    const measurement = measureDaemonSocketPath(published, darwinSocketPathLimitBytes);

    expect(measurement.boundPath).toBe(boundDaemonSocketPath(published));
    expect(measurement.byteLength).toBe(Math.max(
      Buffer.byteLength(published),
      Buffer.byteLength(boundDaemonSocketPath(published)),
    ));
    expect(measurement.limitBytes).toBe(darwinSocketPathLimitBytes);
    expect(measurement.fits).toBe(true);

    // A shorter bound path must not lower the measurement below the published address.
    const dotted = measureDaemonSocketPath('/tmp/wtm/ümd.sock', darwinSocketPathLimitBytes);
    expect(Buffer.byteLength(dotted.boundPath)).toBeLessThan(Buffer.byteLength(dotted.publishedPath));
    expect(dotted.measuredPath).toBe(dotted.publishedPath);
  });

  test('the byte at the limit passes and the byte past it is refused', () => {
    const atLimit = publishedDaemonSocketPath(darwinSocketRoot(bandHome));
    const overLimit = publishedDaemonSocketPath(darwinSocketRoot(`${bandHome}h`));

    expect(Buffer.byteLength(atLimit)).toBe(darwinSocketPathLimitBytes);
    expect(measureDaemonSocketPath(atLimit, darwinSocketPathLimitBytes).fits).toBe(true);
    expect(() => assertDaemonSocketPathFits(atLimit, darwinSocketPathLimitBytes)).not.toThrow();

    expect(Buffer.byteLength(overLimit)).toBe(darwinSocketPathLimitBytes + 1);
    expect(measureDaemonSocketPath(overLimit, darwinSocketPathLimitBytes).fits).toBe(false);
    expect(() => assertDaemonSocketPathFits(overLimit, darwinSocketPathLimitBytes)).toThrow(DaemonSocketPathTooLongError);
  });

  test('measures bytes, not code units, so a non-ASCII home is not under-counted', () => {
    // Each 'ü' is two UTF-8 bytes: 40 code units, 80 bytes.
    const home = `/${'ü'.repeat(40)}`;
    const published = publishedDaemonSocketPath(darwinSocketRoot(home));

    expect(published.length).toBeLessThanOrEqual(darwinSocketPathLimitBytes);
    expect(Buffer.byteLength(published)).toBeGreaterThan(darwinSocketPathLimitBytes);
    expect(measureDaemonSocketPath(published, darwinSocketPathLimitBytes).byteLength).toBe(Buffer.byteLength(published));
    expect(measureDaemonSocketPath(published, darwinSocketPathLimitBytes).fits).toBe(false);
  });

  test('the refusal names the measured length, the limit, and the offending path', () => {
    const published = publishedDaemonSocketPath(darwinSocketRoot(`${bandHome}h`));
    let thrown: unknown;
    try { assertDaemonSocketPathFits(published, darwinSocketPathLimitBytes); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(DaemonSocketPathTooLongError);
    const error = thrown as DaemonSocketPathTooLongError;
    expect(error.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(error.severity).toBe('error');
    expect(error.message).toContain(String(darwinSocketPathLimitBytes + 1));
    expect(error.message).toContain(String(darwinSocketPathLimitBytes));
    expect(error.message).toContain(published);
    expect(error.context).toMatchObject({
      path: published,
      byteLength: darwinSocketPathLimitBytes + 1,
      limitBytes: darwinSocketPathLimitBytes,
      publishedPath: published,
      boundPath: boundDaemonSocketPath(published),
    });
    expect(error.remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);
  });

  test('the refusal is a registered error the envelope can carry unchanged', () => {
    const error = new DaemonSocketPathTooLongError(
      measureDaemonSocketPath(publishedDaemonSocketPath(darwinSocketRoot(`${bandHome}h`)), darwinSocketPathLimitBytes),
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

  test('the published path is the socket root the platform names, not a data root it derives', () => {
    // The whole reason `socketRoot` is its own field: on Linux the socket belongs in
    // `$XDG_RUNTIME_DIR`, which is not under the data root at all.
    expect(publishedDaemonSocketPath('/run/user/1000/wtm')).toBe('/run/user/1000/wtm/wtmd.sock');
  });
});
