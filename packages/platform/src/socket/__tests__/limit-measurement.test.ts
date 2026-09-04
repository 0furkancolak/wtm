import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';
import type { PlatformId } from '../../ports';
import { supportedPlatforms } from '../../select';
import { socketAddressPolicyFor } from '../index';

/**
 * The experiment behind `limits.ts`, run against the kernel this suite is executing on.
 *
 * Every other test in this directory is a test *about a platform*: it injects a platform and
 * asserts that platform's constant, which is correct on any host and would go on passing if both
 * constants were wrong. This one is the opposite and is the only test in the repository that can
 * tell you the constants are true — it binds real addresses and compares the boundary the kernel
 * draws against the number the port would have used.
 *
 * On macOS it re-proves 104. On Linux it is the first thing in the repository to prove 108: that
 * number entered `limits.ts` as a citation of `linux/un.h` because C1 had no kernel to ask.
 *
 * The measurement runs in a **Node** child, not here. Bun's own Unix socket limit is not the
 * platform's — the same sweep in process would report Bun's number on both platforms, and the
 * inviting conclusion would be to "fix" the constants, which is how you ship a daemon that refuses
 * nothing in development and cannot bind in the SEA. `measure-limit.child.ts` explains the
 * mechanics; this file's job is to insist the child really was Node, which it does by asserting on
 * the runtime the child reports rather than trusting the spawn.
 */

const childPath = fileURLToPath(new URL('./measure-limit.child.ts', import.meta.url));

interface Probe {
  readonly bytes: number;
  readonly listened: boolean;
  readonly code: string | null;
}

interface Report {
  readonly runtime: { readonly node: string; readonly bun: string | null; readonly execPath: string };
  readonly root: string;
  readonly sweep: readonly Probe[];
  readonly largestThatListened: number | null;
  readonly smallestThatFailed: number | null;
  readonly listenFailureCode: string | null;
  readonly connect: { readonly atBoundary: string | null; readonly pastBoundary: string | null };
}

/**
 * The limit the port would apply on this host.
 *
 * `socketAddressPolicyFor` answers `darwin` for anything that is not `linux`, so an unrecognised
 * host would otherwise be silently measured against macOS's number. Nothing here can run on such a
 * host anyway; the guard is so that the failure says which platform was unaccounted for.
 */
function hostPlatform(): PlatformId {
  const platform: string = process.platform;
  if (!(supportedPlatforms as readonly string[]).includes(platform)) {
    throw new Error(`no socket address policy for ${platform}; supported: ${supportedPlatforms.join(', ')}`);
  }
  return platform as PlatformId;
}

let memoized: Report | undefined;

/**
 * Runs the child, or fails.
 *
 * There is deliberately no path through this function that skips. A measurement that quietly did
 * not happen is worse than no measurement at all: `limits.ts` would go on claiming a provenance
 * this test was supposed to supply, and the first sign of trouble would be a daemon that cannot
 * bind. So a missing `node`, a non-zero exit, anything on stderr and unparsable output are all
 * failures, and each says which one it was.
 */
function measure(): Report {
  if (memoized !== undefined) return memoized;
  const result = runScenario('node', ['--import', 'tsx', childPath]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  let report: Report;
  try {
    report = JSON.parse(result.stdout) as Report;
  } catch (error) {
    throw new Error(`the measurement child produced no report: ${String(error)}\n${result.stdout}`);
  }
  memoized = report;
  return report;
}

// `sizeof(sun_path)` is a POSIX kernel fact; Windows has no Unix domain socket to measure (the
// daemon addresses it over a named pipe there instead), and `hostPlatform()` above would only
// throw for a host this suite has no measurement for. Skip the whole sweep on win32 rather than
// let that throw stand in for a real gate.
(process.platform !== 'win32' ? describe : describe.skip)('sizeof(sun_path), measured on this host', () => {
  test('the sweep ran under Node, whose limit is the platform\'s, and not under Bun, whose is its own', () => {
    const report = measure();

    expect(report.runtime.bun).toBeNull();
    expect(report.runtime.node).not.toBe('');
    // `bun test` would have measured Bun no matter what `spawnSync` was asked for if `node` on
    // PATH were a shim; the child's own `process.execPath` is the thing that cannot be faked.
    expect(report.runtime.execPath).not.toContain('bun');
  });

  test('the largest address that binds is exactly the limit this platform\'s policy applies', () => {
    const limitBytes = socketAddressPolicyFor(hostPlatform()).limitBytes;
    const report = measure();

    expect(report.largestThatListened).toBe(limitBytes);
    expect(report.smallestThatFailed).toBe(limitBytes + 1);
  });

  test('the boundary is a single step: every shorter address binds and every longer one is refused', () => {
    const limitBytes = socketAddressPolicyFor(hostPlatform()).limitBytes;
    const report = measure();
    const first = report.sweep[0]?.bytes;
    const last = report.sweep.at(-1)?.bytes;
    if (first === undefined || last === undefined) throw new Error('the child reported an empty sweep');

    // Pinning both whole lists, rather than only the boundary, is what makes this a measurement
    // and not a lookup: a kernel that refused some length below the limit, or bound one above it,
    // would be caught even though the boundary itself still landed where the constant says.
    expect(report.sweep.filter((probe) => probe.listened).map((probe) => probe.bytes))
      .toEqual(range(first, limitBytes));
    expect(report.sweep.filter((probe) => !probe.listened).map((probe) => probe.bytes))
      .toEqual(range(limitBytes + 1, last));
    expect(report.listenFailureCode).toBe('EINVAL');
  });

  test('connect() draws the line in the same place as listen()', () => {
    const report = measure();

    // The claim `limits.ts` makes about macOS, kept as a claim rather than a memory, and now made
    // on whichever platform is running: at the limit the address is legal and merely names nothing
    // (`ENOENT`), one byte past it the address itself is rejected. If the two calls ever disagreed,
    // a client would fail differently from the daemon at the same path — which is a difference the
    // preflight, applying one limit to both, could not express.
    expect(report.connect.atBoundary).toBe('ENOENT');
    expect(report.connect.pastBoundary).toBe('EINVAL');
  });
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
}
