import { describe, expect, test } from 'bun:test';
import { createDarwinProcessPlatform } from '../darwin';
import { createLinuxProcessPlatform, type ProcReader } from '../linux';
import { linuxStartTime, parseProcStat } from '../proc-stat';
import {
  groupStats, macosStartTimes, parenthesisedCommCmdline, parenthesisedCommComm,
  parenthesisedCommStat, procStat, truncatedCommStat, zombieStat,
} from './proc-fixtures';

/**
 * `ObservedProcessIdentity.processStartTime` is one column in one state database, and this
 * increment starts writing two platforms' spellings into it with no version tag and no migration.
 * The only thing making that safe is that the two spellings are disjoint: a macOS identity can
 * never be read as a Linux one or the reverse, so the worst a cross-platform read can produce is a
 * mismatch — "not the same process" — and never a false match, which would be a live process
 * mistaken for a dead one.
 *
 * Disjointness is a property of the formats and not of any particular pair of samples, so it is
 * proved from both ends: what the Linux writer can emit, and what the macOS reader can accept.
 */

const linuxIdentity = /^\d+:\d+$/;

function linuxPlatform(files: Readonly<Record<string, string>>) {
  const reader: ProcReader = {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    },
    readDirectory: async () => Object.keys(files),
  };
  return createLinuxProcessPlatform({ proc: reader });
}

describe('the two start-time formats cannot collide', () => {
  test('every Linux start time is digits, a colon, and digits', async () => {
    const platform = linuxPlatform({
      '/proc/stat': procStat,
      '/proc/9/stat': parenthesisedCommStat,
      '/proc/9/comm': parenthesisedCommComm,
      '/proc/9/cmdline': parenthesisedCommCmdline,
    });
    const inspection = await platform.inspectProcess(9);
    expect(inspection.status === 'present' ? inspection.identity.processStartTime : '')
      .toMatch(linuxIdentity);
    expect(await platform.readStartTime(9)).toMatch(linuxIdentity);
  });

  test('every start time the Linux reader can build out of real kernel lines is digits and a colon', () => {
    const lines = [...Object.values(groupStats), parenthesisedCommStat, truncatedCommStat, zombieStat];
    for (const line of lines) {
      const ticks = parseProcStat(line)?.startTimeTicks;
      expect(ticks).toBeDefined();
      expect(linuxStartTime('1788259322', ticks as string)).toMatch(linuxIdentity);
    }
  });

  /**
   * The macOS half. `lstart` is `ps`'s `%c` date: a weekday name, a month name, a day, a clock time
   * and a year, separated by spaces. Letters and whitespace both disqualify it from the Linux
   * pattern, and neither is optional in the format.
   */
  test('no real macOS lstart string can be read as a Linux one', () => {
    for (const startTime of macosStartTimes) {
      expect(startTime).not.toMatch(linuxIdentity);
      expect(startTime).toMatch(/\s/);
      expect(startTime).toMatch(/[A-Za-z]/);
    }
  });

  /**
   * Stronger than the samples: the macOS reader accepts a start time only through a regex that
   * requires four whitespace runs inside it, so *nothing* it can ever produce is free of whitespace
   * — and the Linux format never contains any. Generated over a full year of dates so a month name,
   * a padded single-digit day and a two-digit day are all covered.
   */
  test('nothing the macOS reader accepts is whitespace-free, so nothing it accepts is a Linux identity', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: async (_file, args) => ({ stdout: psLineFor(args) }),
    });
    for (let day = 0; day < 366; day += 1) {
      const moment = new Date(Date.UTC(2026, 0, 1 + day, 13, 4, 5));
      const lstart = formatLstart(moment);
      const inspection = await platform.inspectProcess(dayToPid(day, lstart));
      expect(inspection.status).toBe('present');
      if (inspection.status !== 'present') continue;
      expect(inspection.identity.processStartTime).toBe(lstart);
      expect(inspection.identity.processStartTime).not.toMatch(linuxIdentity);
      expect(inspection.identity.processStartTime).toMatch(/\s/);
    }
  });
});

const generated = new Map<number, string>();
let nextPid = 1;

function dayToPid(day: number, lstart: string): number {
  const pid = nextPid + day;
  generated.set(pid, `${String(pid)} Ss ${lstart} /bin/zsh /bin/zsh -c true\n`);
  return pid;
}

function psLineFor(args: readonly string[]): string {
  return generated.get(Number.parseInt(args[2] as string, 10)) ?? '';
}

/** `ps`'s `lstart` column: `Www Mmm DD HH:MM:SS YYYY`, the day padded to two columns with a space. */
function formatLstart(moment: Date): string {
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][moment.getUTCDay()] as string;
  const month = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ][moment.getUTCMonth()] as string;
  const day = String(moment.getUTCDate()).padStart(2, ' ');
  const clock = [moment.getUTCHours(), moment.getUTCMinutes(), moment.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0')).join(':');
  return `${weekday} ${month} ${day} ${clock} ${String(moment.getUTCFullYear())}`;
}
