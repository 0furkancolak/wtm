import { basename, dirname, join } from 'node:path';
import type { Remediation } from '@wtm/protocol';

/**
 * Where the daemon's Unix socket lives, how long it may be, and who says so.
 *
 * The path used to be spelled out in three places — the CLI's `defaultDaemonSocketPath`, and
 * twice inside the daemon's runtime factory — and nothing measured any of them. Under a deep
 * `HOME` the bind failed with a bare `listen EINVAL`, which names neither the limit nor the
 * path that broke it. A check attached to one of the three copies is a check the other two do
 * not get, so the path and the measurement are defined here and consumed everywhere.
 *
 * What moved when this file left `@wtm/core`: the *limit* is no longer part of the derivation.
 * It is a platform fact — 104 bytes on macOS, 108 on Linux — supplied by `SocketAddressPolicy`,
 * and every function here takes it as an argument. Nothing below knows which platform it is
 * running on, which is what lets the Linux numbers be exercised from a macOS machine.
 */

export const daemonSocketFileName = 'wtmd.sock';

/**
 * The advertised socket path: the name every client connects to.
 *
 * It takes the *socket root*, not a home and not a data root. On macOS the two coincide; on
 * Linux the socket belongs in `$XDG_RUNTIME_DIR`, which is nowhere near the data root — which
 * is precisely why `PlatformPaths` states `socketRoot` as its own field rather than deriving it.
 */
export function publishedDaemonSocketPath(socketRoot: string): string {
  return join(socketRoot, daemonSocketFileName);
}

/**
 * The path the server actually binds, before it links the published name onto the same inode.
 *
 * The first character of the name is *substituted*, not prefixed, so the bind path is never
 * longer than the published one — for an ASCII name it is exactly as long, and for a name
 * beginning with a multi-byte character it is shorter. That matters here and nowhere else:
 * it means the published path is always the one to measure, and there is no band of `HOME`
 * lengths where the advertised path fits and the bound path does not. `measureDaemonSocketPath`
 * takes the longer of the two anyway, so a future change to this derivation cannot quietly
 * reopen that gap.
 *
 * The derivation is shared by both platforms. Nothing in it is an operating-system fact: what
 * differs between macOS and Linux is only how many bytes the result may be.
 */
export function boundDaemonSocketPath(publishedPath: string): string {
  const original = basename(publishedPath);
  const marker = original.startsWith('.') ? '_' : '.';
  const candidate = `${marker}${original.slice(1)}`;
  if (candidate !== '.' && candidate !== '..') return join(dirname(publishedPath), candidate);
  const fallback = original.startsWith('_') ? '-' : '_';
  return join(dirname(publishedPath), `${fallback}${original.slice(1)}`);
}

export interface DaemonSocketPathMeasurement {
  /** The advertised path, which every client passes to `connect()`. */
  publishedPath: string;
  /** The private path the server passes to `bind()`. */
  boundPath: string;
  /** Whichever of the two is longest: the one that decides whether the daemon can run. */
  measuredPath: string;
  byteLength: number;
  limitBytes: number;
  /** How many bytes over the limit, or 0 when it fits. */
  exceededBy: number;
  fits: boolean;
}

/**
 * The limit is a required argument, and deliberately has no default.
 *
 * A default would have to be one platform's number, and the whole point of this increment is that
 * the operating system is a parameter rather than an assumption. The draft of this module defaulted
 * to macOS's 104 with a comment promising the call sites would be moved onto
 * `PlatformRuntime.socket.limitBytes` later — which is exactly the shape of the defect this seam
 * exists to remove: correct today only because `assertSupportedRuntime` still refuses Linux, and
 * silently wrong the moment it stops. A comment is not a mechanism. The type-checker is.
 *
 * The five call sites outside this package still spell `darwinSocketPathLimitBytes` because Wave 3
 * is what hands them a platform runtime. Spelling it is the point: `grep darwinSocketPathLimitBytes
 * packages/cli packages/daemon` is Wave 3's checklist, and it must come back empty.
 */
export function measureDaemonSocketPath(
  publishedPath: string,
  limitBytes: number,
): DaemonSocketPathMeasurement {
  const boundPath = boundDaemonSocketPath(publishedPath);
  // Ties go to the published path: it is the one the user recognises and the one a client
  // fails on, so naming it makes the refusal readable.
  const measuredPath = Buffer.byteLength(boundPath) > Buffer.byteLength(publishedPath)
    ? boundPath
    : publishedPath;
  const byteLength = Buffer.byteLength(measuredPath);
  return {
    publishedPath,
    boundPath,
    measuredPath,
    byteLength,
    limitBytes,
    exceededBy: Math.max(0, byteLength - limitBytes),
    fits: byteLength <= limitBytes,
  };
}

/**
 * Raised instead of letting `listen`/`connect` fail with a bare `EINVAL`.
 *
 * Carries a `WtmErrorCode`, so the envelope and the exit code follow from the error itself
 * rather than from whichever handler happens to catch it. The message names the limit that was
 * in force rather than a constant, so a reader on either platform is told the number their own
 * kernel enforces.
 */
export class DaemonSocketPathTooLongError extends Error {
  readonly code = 'WTM_SOCKET_PATH_TOO_LONG' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;
  readonly remediation: readonly Remediation[];
  readonly measurement: DaemonSocketPathMeasurement;

  constructor(measurement: DaemonSocketPathMeasurement) {
    super(
      `The WTM daemon socket path is ${measurement.byteLength} bytes, `
      + `${measurement.exceededBy} over the ${measurement.limitBytes}-byte limit for a Unix `
      + `socket address on this platform: ${measurement.measuredPath}. `
      + `Run WTM under a home directory at least ${measurement.exceededBy} bytes shorter.`,
    );
    this.name = 'DaemonSocketPathTooLongError';
    this.measurement = measurement;
    this.context = {
      path: measurement.measuredPath,
      byteLength: measurement.byteLength,
      limitBytes: measurement.limitBytes,
      exceededBy: measurement.exceededBy,
      publishedPath: measurement.publishedPath,
      boundPath: measurement.boundPath,
    };
    this.remediation = [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }];
  }
}

/** Refuses before anything is bound, connected, or created on disk. */
export function assertDaemonSocketPathFits(
  publishedPath: string,
  limitBytes: number,
): DaemonSocketPathMeasurement {
  const measurement = measureDaemonSocketPath(publishedPath, limitBytes);
  if (!measurement.fits) throw new DaemonSocketPathTooLongError(measurement);
  return measurement;
}
