/**
 * Parsing `/proc/<pid>/stat` and `/proc/stat`, kept apart from the reader so the hazards can be
 * tested against captured kernel output rather than against a live `/proc` that this project's
 * development machines do not have.
 *
 * The format is documented in `proc(5)`. Only four of its fifty-two fields are wanted here, but
 * getting to them is the entire difficulty, because field 2 is hostile:
 *
 *     9 (weird) app)) S 1 1 1 0 -1 4194304 136 0 2 0 0 ...
 *
 * That is a real line, from a real process whose executable was named `weird) app)`. The kernel
 * wraps `comm` in parentheses and escapes nothing, so a `comm` may contain spaces, parentheses, or
 * both. Splitting the line on whitespace — the obvious implementation, and the one every broken
 * `/proc` parser in the world contains — desynchronises every field after it, which here would mean
 * reading somebody's `minflt` as a process group and a page count as a start time. Both would be
 * silently plausible numbers, which is what makes the bug worth this much prose.
 *
 * The rule that works, and the only one that does: `comm` ends at the **last** `)` in the line.
 * Nothing after it can contain a parenthesis, because everything after it is a number.
 */

export interface ProcStatFields {
  /** Field 1. Read back rather than assumed, so a caller can check it against the PID it asked for. */
  pid: number;
  /** Field 2, unwrapped. Retained because it is half of the Linux command fingerprint. */
  comm: string;
  /** Field 3. `Z` is a zombie. */
  state: string;
  /** Field 5, the process group this process belongs to. */
  pgrp: number;
  /**
   * Field 22, in clock ticks since boot, kept as the digits the kernel printed. It is never
   * arithmetic here — it is one half of an opaque identity string — so converting it to a number
   * would only add a way to lose it.
   */
  startTimeTicks: string;
}

/** The index into the post-`comm` fields of `/proc/<pid>/stat` field number `n`. */
function fieldIndex(n: number): number { return n - 3; }

/**
 * Returns `null` for anything that is not a well-formed `stat` line. The caller decides what that
 * means, and for every caller here it means *failure*, never absence: absence is a missing file.
 */
export function parseProcStat(content: string): ProcStatFields | null {
  const line = content.replace(/\n$/, '');
  const opening = line.indexOf('(');
  const closing = line.lastIndexOf(')');
  if (opening < 0 || closing < opening) return null;

  const pid = parseDigits(line.slice(0, opening).trim());
  if (pid === null || pid < 1) return null;

  const comm = line.slice(opening + 1, closing);
  const rest = line.slice(closing + 1).trim().split(/\s+/).filter((field) => field.length > 0);
  // Field 22 must be present; a line shorter than that is truncated, not merely from an older
  // kernel, since fields are only ever appended.
  if (rest.length <= fieldIndex(22)) return null;

  const state = rest[fieldIndex(3)] as string;
  if (state.length !== 1) return null;
  const pgrp = parseDigits(rest[fieldIndex(5)] as string);
  if (pgrp === null) return null;
  const startTimeTicks = rest[fieldIndex(22)] as string;
  if (!/^\d+$/.test(startTimeTicks)) return null;

  return { pid, comm, state, pgrp, startTimeTicks };
}

/**
 * The `btime` line of `/proc/stat`: the wall-clock second at which the kernel booted.
 *
 * Start time on Linux is measured from boot, so it repeats after every reboot — PID 412 started at
 * tick 2778072 of this boot and PID 412 started at tick 2778072 of the last one are indistinguishable
 * without it. Pairing the two is what makes a Linux identity as unique as the macOS `lstart` string
 * it sits in the same database column as.
 */
export function parseBootTime(content: string): string | null {
  for (const line of content.split('\n')) {
    if (!line.startsWith('btime ')) continue;
    const value = line.slice('btime '.length).trim();
    return /^\d+$/.test(value) ? value : null;
  }
  return null;
}

/**
 * The start-time string a Linux identity stores: `<btime>:<starttime>`, decimal digits throughout.
 *
 * Both halves being digits is not incidental. macOS stores a `ps` `lstart` string — `Tue Sep  1
 * 21:27:02 2026` — which contains letters and spaces and therefore cannot equal this, so one state
 * column holds both platforms' identities without a version tag and without a migration.
 */
export function linuxStartTime(bootTime: string, startTimeTicks: string): string {
  return `${bootTime}:${startTimeTicks}`;
}

function parseDigits(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
