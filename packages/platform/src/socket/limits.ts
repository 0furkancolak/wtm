/**
 * `sizeof(sun_path)` — how many bytes of a Unix socket address the kernel will hold.
 *
 * It is the one platform fact in this port, and the two platforms disagree by four bytes. The
 * numbers live here, apart from the measurement, because their *provenance* differs: one was
 * measured on the machine this code was written on and the other cannot be.
 */

/**
 * The longest Unix socket address that works on macOS, in bytes.
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
export const darwinSocketPathLimitBytes = 104;

/**
 * The same limit on Linux, where `sun_path` is four bytes longer — and **this number was not
 * measured**.
 *
 * 108 is the value in `linux/un.h` and has been for the lifetime of the ABI. Nothing in this
 * repository can confirm it: there is no Linux kernel here to bind against, so unlike the macOS
 * number above there is no experiment behind it, only a documented constant. Increment C2 binds
 * a 108-byte and a 109-byte address on a real kernel and is where this stops being a citation.
 *
 * Recording that gap is the point of writing the number down here rather than reading it out of
 * a header at runtime: a wrong constant would show up as a daemon that refuses a path it could
 * have bound, or — worse — accepts one it cannot, and neither failure would name this line
 * unless the line says what it is.
 */
export const linuxSocketPathLimitBytes = 108;
