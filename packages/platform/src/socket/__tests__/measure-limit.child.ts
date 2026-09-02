/**
 * Binds real Unix sockets across a range of address lengths and reports where the kernel draws
 * the line.
 *
 * This is the experiment behind `limits.ts`. It exists as a spawned child rather than as an
 * ordinary test body for one reason: **the test runner is Bun, and Bun's Unix socket limit is not
 * the platform's.** Bun accepts 118 bytes on both macOS and Linux, so the same sweep run in
 * process would measure Bun and conclude that `sizeof(sun_path)` is 118 everywhere — which would
 * invite "correcting" the constants and shipping a daemon that refuses nothing here and then
 * cannot bind in the Node SEA users actually run. The shipped binary is Node, so the measurement
 * has to be Node, and the only way to be Node from inside `bun test` is to leave the process.
 *
 * The child therefore refuses to run anywhere but Node (see `assertNodeRuntime`) and reports the
 * runtime it measured under, so its caller can check rather than assume.
 *
 * Nothing here imports `../limits` or `../policy`. A measurement that read the constant it is
 * meant to confirm could not contradict it; the numbers below come from the kernel alone and the
 * comparison happens in the test.
 *
 * Usage: `node --import tsx measure-limit.child.ts` — writes one JSON report to stdout.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The lengths to bind, in bytes of the address handed to `bind(2)`.
 *
 * The lower bound matches the darwin measurement recorded in `limits.ts` (96). The upper bound is
 * past every limit any runtime that could execute this file is known to have, so that a boundary
 * always falls *inside* the sweep and "nothing in range was refused" never has to be interpreted:
 * a report with no refusal in it is a broken measurement, not a large limit. Bun's is the largest
 * and the reason the ceiling is not simply 112 — `limits.ts` records it as 118, and a sweep under
 * Bun 1.3.14 / macOS 15 while writing this reached 122.
 */
const sweepFrom = 96;
const sweepTo = 128;

/** Filler for the socket name. ASCII, so one character is one byte — see `pathOfBytes`. */
const fill = 'a';

interface Probe {
  readonly bytes: number;
  readonly listened: boolean;
  /** The errno of the refusal, or `null` when the address bound. */
  readonly code: string | null;
}

interface Report {
  readonly runtime: { readonly node: string; readonly bun: string | null; readonly execPath: string };
  readonly root: string;
  readonly sweep: readonly Probe[];
  readonly largestThatListened: number | null;
  readonly smallestThatFailed: number | null;
  readonly listenFailureCode: string | null;
  /**
   * What `connect(2)` says at the boundary and one byte past it, against paths that do not exist.
   *
   * `limits.ts` claims the two calls draw the line in the same place on macOS — 104 gives
   * `ENOENT` (a legal address naming nothing), 105 gives `EINVAL` (an address the kernel will not
   * hold). Reporting both keeps that a checked claim on every host rather than a remembered one.
   */
  readonly connect: { readonly atBoundary: string | null; readonly pastBoundary: string | null };
}

assertNodeRuntime();
process.stdout.write(JSON.stringify(await measure()));

async function measure(): Promise<Report> {
  const root = await shortLivedRoot();
  try {
    const sweep: Probe[] = [];
    for (let bytes = sweepFrom; bytes <= sweepTo; bytes += 1) {
      const code = await tryListen(pathOfBytes(root, bytes));
      sweep.push({ bytes, listened: code === null, code });
    }
    const listened = sweep.filter((probe) => probe.listened);
    const refused = sweep.filter((probe) => !probe.listened);
    const largestThatListened = listened.at(-1)?.bytes ?? null;
    const smallestThatFailed = refused[0]?.bytes ?? null;
    return {
      runtime: {
        node: process.versions.node,
        bun: process.versions.bun ?? null,
        execPath: process.execPath,
      },
      root,
      sweep,
      largestThatListened,
      smallestThatFailed,
      listenFailureCode: refused[0]?.code ?? null,
      connect: {
        // A name that was never created, so a legal-length address can only fail as `ENOENT`.
        atBoundary: largestThatListened === null ? null : await tryConnect(pathOfBytes(root, largestThatListened, 'c')),
        pastBoundary: smallestThatFailed === null ? null : await tryConnect(pathOfBytes(root, smallestThatFailed, 'c')),
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A directory short enough that a 96-byte socket address inside it is still reachable.
 *
 * `os.tmpdir()` on macOS is a per-user `/var/folders/…/T` roughly fifty bytes deep, which leaves
 * too little room to place the low end of the sweep and none at all for the assertion that the low
 * end binds. `/tmp` is the same directory reached through a symlink to `/private/tmp`, and
 * `bind(2)` counts **the bytes it is given**, not the bytes of the resolved path — the kernel
 * resolves the symlink after the address has already been copied into `sun_path`. So the symlinked
 * spelling is both shorter and the honest thing to measure, and this function must never call
 * `realpath`: doing so would silently move the whole sweep thirteen bytes and measure lengths that
 * were never bound.
 *
 * `/tmp` is not assumed to exist. Where it does not, `os.tmpdir()` is used and a base too long for
 * the sweep fails loudly here rather than producing a short sweep that looks like a measurement.
 */
async function shortLivedRoot(): Promise<string> {
  const bases = ['/tmp', tmpdir()];
  let lastFailure: unknown;
  for (const base of bases) {
    try {
      const root = await mkdtemp(join(base, 'wtm-sun-'));
      const headroom = sweepFrom - Buffer.byteLength(root) - 1;
      if (headroom < 1) {
        await rm(root, { recursive: true, force: true });
        throw new Error(`${base} is ${Buffer.byteLength(root)} bytes, too long to place a ${sweepFrom}-byte address`);
      }
      return root;
    } catch (error) {
      lastFailure = error;
    }
  }
  throw new Error(`no writable directory short enough for the sweep: ${String(lastFailure)}`);
}

/**
 * A path under `root` whose address is exactly `bytes` bytes.
 *
 * The unit is bytes, not characters, because `sun_path` is a byte buffer: a UTF-8 name is longer
 * than its `length` suggests. `root` and the filler are ASCII so the two coincide here, and the
 * check below is what keeps that an established fact rather than an assumption — if a `TMPDIR`
 * ever carries a non-ASCII component, this throws instead of sweeping the wrong lengths.
 */
function pathOfBytes(root: string, bytes: number, filler: string = fill): string {
  const name = filler.repeat(bytes - Buffer.byteLength(root) - 1);
  const path = join(root, name);
  if (Buffer.byteLength(path) !== bytes) {
    throw new Error(`built a ${Buffer.byteLength(path)}-byte path while aiming for ${bytes}`);
  }
  return path;
}

/** Binds and listens, then removes the socket. Returns `null` on success, else the errno. */
async function tryListen(path: string): Promise<string | null> {
  const server = createServer();
  let failure: string | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { resolve(); });
    });
  } catch (error) {
    failure = errorCode(error);
  } finally {
    // `close()` on a server that never listened calls back with `ERR_SERVER_NOT_RUNNING`; the
    // callback shape is used only to wait, so that error is not a result. Node does not unlink a
    // Unix socket it closes, hence the explicit removal: a sweep that left twenty-five sockets
    // behind would be a measurement that littered `/tmp` on every CI run.
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    await rm(path, { force: true });
  }
  return failure;
}

/** Connects to a path that does not exist. Returns the errno, or `'connected'` if one answered. */
async function tryConnect(path: string): Promise<string> {
  const socket = connect(path);
  try {
    return await new Promise<string>((resolve) => {
      socket.once('error', (error: unknown) => { resolve(errorCode(error)); });
      socket.once('connect', () => { resolve('connected'); });
    });
  } finally {
    socket.destroy();
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : String(error);
}

/**
 * Refuses to measure anything but Node.
 *
 * Reporting the runtime would be enough for an honest caller, but the failure this guards against
 * is a wrong *number* propagating into a constant that decides whether the daemon can bind at all.
 * A child that exits non-zero cannot be misread; a report labelled `bun` might be.
 */
function assertNodeRuntime(): void {
  if (process.versions.bun !== undefined) {
    throw new Error(
      `this measurement must run under Node: Bun's Unix socket limit is its own (118 bytes), not the platform's. Ran under Bun ${process.versions.bun} at ${process.execPath}.`,
    );
  }
}
