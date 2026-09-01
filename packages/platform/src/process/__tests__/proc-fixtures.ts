/**
 * Genuine `/proc` content, not hand-written approximations.
 *
 * Captured on 2026-09-01 from a Debian `postgres:17` container (kernel 7.0.14) run on the macOS
 * development machine, by copying `/bin/sleep` to deliberately awful names and reading the kernel's
 * own output. Hand-written fixtures would have been written by the same understanding that wrote
 * the parser, which is exactly the understanding a fixture is supposed to check.
 *
 * The one accident worth keeping: the `/proc` listing below is the real `ls /proc` output from that
 * container, and it includes two PIDs (11 and 12) belonging to the `ls` and `cat` that produced it —
 * they had exited by the time their `stat` files were read. A process disappearing mid-scan is the
 * case the group reader has to survive, and this is a real instance of it rather than an invented
 * one.
 */

/** `/proc/stat`, trimmed to the lines the reader looks at plus enough context to stay realistic. */
export const procStat = [
  'cpu  142992 0 70907 27525587 2322 0 18207 0 0 0',
  'cpu0 15807 0 8859 2744284 1824 0 9067 0 0 0',
  'cpu1 16960 0 7916 2746186 60 0 3843 0 0 0',
  'ctxt 32873821',
  'btime 1788259322',
  'processes 492957',
  'procs_running 2',
  'procs_blocked 1',
  '',
].join('\n');

export const bootTime = '1788259322';

/** PID 1. An ordinary line, with an ordinary `comm`. */
export const initStat = '1 (bash) S 0 1 1 0 -1 4194560 1306 381 8 6 0 1 0 0 20 0 1 0 2807658 7098368 859 18446744073709551615 187650779185152 187650780499760 281474687886192 0 0 0 65536 4 65538 1 0 0 17 0 0 0 0 0 0 187650780609264 187650780660668 187651791204352 281474687888905 281474687889140 281474687889140 281474687889386 0\n';

/**
 * `/bin/sleep` copied to `weird) app)`. The kernel wraps that in parentheses and escapes nothing,
 * so the line reads `9 (weird) app)) S ...`: three closing parentheses, only the last of which ends
 * the field. A parser that splits on whitespace reads `app))` as the state and every field after it
 * one place to the right — pgrp becomes a fault count, start time becomes a page count.
 */
export const parenthesisedCommStat = '9 (weird) app)) S 1 1 1 0 -1 4194304 136 0 2 0 0 0 0 0 20 0 1 0 2778072 5431296 443 18446744073709551615 187650306277376 187650306313816 281474428577328 0 0 0 0 6 0 1 0 0 17 2 0 0 0 0 0 187650306407120 187650306408680 187650458271744 281474428579530 281474428579550 281474428579550 281474428579815 0\n';
export const parenthesisedCommComm = 'weird) app)\n';
/** NUL-separated, with the trailing NUL the kernel appends: `/tmp/weird) app)` and `30`. */
export const parenthesisedCommCmdline = `${['/tmp/weird) app)', '30'].join('\0')}\0`;

/**
 * `/bin/sleep` copied to `(my (weird) app)`, which is 16 bytes and so is truncated by the kernel to
 * the 15 bytes `(my (weird) app` — losing its own closing parenthesis, and leaving a line whose
 * first `(` is not the one that opens the field.
 */
export const truncatedCommStat = '16 ((my (weird) app) S 1 1 1 0 -1 4194304 137 0 1 0 0 0 0 0 20 0 1 0 2778104 5431296 430 18446744073709551615 187651043491840 187651043528280 281473908401856 0 0 0 0 6 0 1 0 0 17 2 0 0 0 0 0 187651043621584 187651043623144 187652015304704 281473908403899 281473908403924 281473908403924 281473908404194 0\n';

/** A `sleep` its parent had not yet reaped. State `Z`, and most of the line zeroed by the kernel. */
export const zombieStat = '22 (sleep) Z 20 1 1 0 -1 4227084 132 0 0 0 0 0 0 0 20 0 1 0 2778135 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 8 0 0 0 0 0 0 0 0 0 0 0 0 0\n';

/** `ls /proc`: PID directories mixed with everything else the kernel exposes there. */
export const procListing: readonly string[] = [
  '1', '10', '11', '12', '6', '8', '9', 'asound', 'buddyinfo', 'bus', 'cgroups', 'cmdline',
  'config.gz', 'consoles', 'cpuinfo', 'crypto', 'devices', 'device-tree', 'diskstats', 'driver',
  'execdomains', 'filesystems', 'fs', 'interrupts', 'iomem', 'ioports', 'irq', 'kallsyms', 'keys',
  'key-users', 'kmsg', 'kpagecgroup', 'kpagecount', 'kpageflags', 'loadavg', 'locks', 'meminfo',
  'misc', 'modules', 'mounts', 'net', 'pagetypeinfo', 'partitions', 'self', 'softirqs', 'stat',
  'swaps', 'sys', 'sysrq-trigger', 'sysvipc', 'thread-self', 'timer_list', 'tty', 'uptime',
  'version', 'vmallocinfo', 'vmstat', 'zoneinfo',
];

/**
 * The processes behind that listing: a `setsid bash` at PID 6 leading process group 6, with three
 * `sleep` children in it. PIDs 11 and 12 are deliberately absent from this map — they exited
 * between the listing and the read.
 */
export const groupStats: Readonly<Record<string, string>> = {
  '1': initStat,
  '6': '6 (bash) S 1 6 6 0 -1 4194560 282 0 1 0 0 0 0 0 20 0 1 0 2807663 7098368 859 18446744073709551615 187650125135872 187650126450480 281474555035504 0 0 0 65536 6 65536 1 0 0 17 3 0 0 0 0 0 187650126559984 187650126611388 187650531192832 281474555039422 281474555039458 281474555039458 281474555039722 0\n',
  '8': '8 (sleep) S 6 6 6 0 -1 4194304 133 0 0 0 0 0 0 0 20 0 1 0 2807663 5431296 463 18446744073709551615 187650122383360 187650122419800 281474615791584 0 0 0 0 6 0 1 0 0 17 8 0 0 0 0 0 187650122513104 187650122514664 187650152833024 281474615795418 281474615795426 281474615795426 281474615795689 0\n',
  '9': '9 (sleep) S 6 6 6 0 -1 4194304 133 0 0 0 0 0 0 0 20 0 1 0 2807663 5431296 430 18446744073709551615 187650814377984 187650814414424 281474930094208 0 0 0 0 6 0 1 0 0 17 5 0 0 0 0 0 187650814507728 187650814509288 187651471167488 281474930097882 281474930097890 281474930097890 281474930098153 0\n',
  '10': '10 (sleep) S 6 6 6 0 -1 4194304 102 0 0 0 0 0 0 0 20 0 1 0 2807663 5431296 446 18446744073709551615 187650438463488 187650438499928 281474504650096 0 0 0 0 6 0 1 0 0 17 2 0 0 0 0 0 187650438593232 187650438594792 187650492751872 281474504654554 281474504654562 281474504654562 281474504654825 0\n',
};

/**
 * `ps -ww -p <pid> -o pgid= -o state= -o lstart= -o comm= -o command=` on macOS 15, from the
 * development machine, with the command shortened. The macOS reader's regex is matched against
 * exactly this shape.
 */
export const macosInspectLine = '50437 Ss   Tue Sep  1 21:27:02 2026 /bin/zsh /bin/zsh -c echo hello\n';

/** `ps -ww -p <pid> -o lstart=` on macOS 15, including the trailing padding `ps` emits. */
export const macosLstartLine = 'Tue Sep  1 21:27:02 2026    \n';

/**
 * Real `lstart` strings from macOS, chosen to cover what varies: the single-digit day `ps` pads
 * with two spaces, a two-digit day, midnight, and a leap day.
 */
export const macosStartTimes: readonly string[] = [
  'Tue Sep  1 21:27:02 2026',
  'Tue Sep  1 13:41:36 2026',
  'Mon Dec 31 23:59:59 2029',
  'Sat Feb 29 00:00:00 2020',
];
