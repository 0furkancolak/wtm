import { basename, dirname, join } from 'node:path';
import type { Remediation } from '@wtm/protocol';

/**
 * Where the daemon's Unix socket lives, how long it may be, and who says so.
 *
 * The path used to be spelled out in three places — the CLI's `defaultDaemonSocketPath`, and
 * twice inside the daemon's runtime factory — and nothing measured any of them. Under a deep
 * `HOME` the bind failed with a bare `listen EINVAL`, which names neither the limit nor the
 * path that broke it. A check attached to one of the three copies is a check the other two do
 * not get, so the path and the limit are defined here and consumed everywhere.
 */

export const daemonSocketFileName = 'wtmd.sock';
export const daemonDataDirectorySegments = ['Library', 'Application Support', 'WTM'] as const;

/**
 * The longest Unix socket address that works, in bytes.
 *
 * macOS declares `sun_path[104]` and libuv refuses anything longer than that buffer, so 104
 * bytes bind and 105 fail. Measured on macOS 15 / Node 24 by binding paths of every length
 * from 96 to 112 bytes: 104 listens, 105 raises `EINVAL`, and `connect()` draws the line in
 * exactly the same place (105 gives `EINVAL` where 104 gives `ENOENT`).
 *
 * Bun is more permissive — its own limit sits at 118 bytes — so a `bun test` or a `bun run`
 * of the daemon will happily bind a path the shipped Node SEA cannot. That divergence is the
 * reason this preflight exists as a measurement rather than as a rescued `EINVAL`: the
 * failure does not reproduce in the environment the code is developed in.
 *
 * The limit is a property of the platform's socket address, not of any filesystem: it counts
 * bytes, so a `HOME` holding non-ASCII characters is longer than its character count.
 */
export const daemonSocketPathLimitBytes = 104;

/** The per-user data directory that holds the socket, the database and the global config. */
export function daemonDataRoot(home: string): string {
  return join(home, ...daemonDataDirectorySegments);
}

/** The advertised socket path: the name every client connects to. */
export function publishedDaemonSocketPath(home: string): string {
  return join(daemonDataRoot(home), daemonSocketFileName);
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

export function measureDaemonSocketPath(
  publishedPath: string,
  limitBytes = daemonSocketPathLimitBytes,
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
 * rather than from whichever handler happens to catch it.
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
  limitBytes = daemonSocketPathLimitBytes,
): DaemonSocketPathMeasurement {
  const measurement = measureDaemonSocketPath(publishedPath, limitBytes);
  if (!measurement.fits) throw new DaemonSocketPathTooLongError(measurement);
  return measurement;
}
