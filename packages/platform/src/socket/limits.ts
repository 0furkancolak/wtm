/**
 * `sizeof(sun_path)` — how many bytes of a Unix socket address the kernel will hold.
 *
 * It is the one platform fact in this port, and the two platforms disagree by four bytes. The
 * numbers live here, apart from the code that applies them, because their *provenance* differs:
 * one is confirmed wherever a developer runs the suite, the other only where CI runs it. Both are
 * now measured rather than asserted — `__tests__/limit-measurement.test.ts` binds real addresses
 * on the host and compares the boundary against whichever of these two numbers governs it — and
 * each comment below says under what conditions.
 */

/**
 * The longest Unix socket address that works on macOS, in bytes.
 *
 * macOS declares `sun_path[104]` and libuv refuses anything longer than that buffer, so 104
 * bytes bind and 105 fail. Measured on macOS 15 / Node 24 by binding paths of every length
 * from 96 to 112 bytes: 104 listens, 105 raises `EINVAL`, and `connect()` draws the line in
 * exactly the same place (105 gives `EINVAL` where 104 gives `ENOENT`).
 *
 * That sweep is no longer a one-off recorded in prose: `__tests__/limit-measurement.test.ts`
 * re-runs the experiment — the bind sweep, widened to 128 bytes, and the `connect()` comparison
 * with it — on every macOS run.
 *
 * Bun is more permissive — its own limit sits at 118 bytes — so a `bun test` or a `bun run`
 * of the daemon will happily bind a path the shipped Node SEA cannot. That divergence is the
 * reason this preflight exists as a measurement rather than as a rescued `EINVAL`: the
 * failure does not reproduce in the environment the code is developed in.
 *
 * The limit is a property of the platform's socket address, not of any filesystem: it counts
 * bytes, so a `HOME` holding non-ASCII characters is longer than its character count.
 */
export const darwinSocketPathLimitBytes = 104;

/**
 * The same limit on Linux, where `sun_path` is four bytes longer.
 *
 * 108 is the value in `linux/un.h` and has been for the lifetime of the ABI. Through C1 it was
 * only that — a citation, with no Linux kernel in this repository to bind against, and the comment
 * here said so. `__tests__/limit-measurement.test.ts` closes that gap: on the Linux CI job it
 * sweeps every address length from 96 to 128 bytes in a Node child and asserts that the largest
 * that listens is exactly the number above and the next raises `EINVAL`, with `connect()` drawing
 * the same line. 108 is now an experiment rather than a quotation.
 *
 * The bound on that claim is worth stating precisely, because "measured" invites more than it
 * earns. It is measured on the kernel and glibc that `ubuntu-latest` x64 was running under Node 24
 * the last time the job ran. It is not measured on musl, on arm64, or on whatever a user has, and
 * this line is not evidence about those.
 *
 * What the test buys is therefore not universality but *notice*. A kernel or libc that moved the
 * boundary would otherwise show up as a daemon that refuses a path it could have bound, or — worse
 * — accepts one it cannot; with the measurement in the suite it shows up as a red build naming
 * this constant, which is the whole reason for writing the number down here instead of reading it
 * out of a header at runtime.
 */
export const linuxSocketPathLimitBytes = 108;

/**
 * A Windows named pipe's name, not a `sun_path` — cited, not measured (Increment D1,
 * `2026-09-03-windows-trust-and-transport-seam.md`, D7/D8), because there is no Windows kernel in
 * this repository to bind against, the same position C1 was in for 108 before C2.
 *
 * Microsoft's own `CreateNamedPipe` reference states the entire pipe name string — including the
 * mandatory `\\.\pipe\` prefix — may be up to 256 characters. That is a materially different limit
 * from a `sun_path` in nature as well as size: it is a character count on a name, not a byte count
 * on a filesystem address, and a named pipe has no bind-then-link step for `boundPathFor` to
 * derive a private name for (D7's finding: there is nothing to quarantine). `boundPathFor` is
 * therefore the identity function here, not a placeholder standing in for missing logic — D2 is
 * where a real Windows host confirms both the number and the identity choice.
 */
export const windowsPipeNameLimitCharacters = 256;
