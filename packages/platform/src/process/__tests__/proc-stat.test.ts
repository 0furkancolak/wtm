import { describe, expect, test } from 'bun:test';
import { linuxStartTime, parseBootTime, parseProcStat } from '../proc-stat';
import {
  bootTime, initStat, parenthesisedCommStat, procStat, truncatedCommStat, zombieStat,
} from './proc-fixtures';

describe('parseProcStat', () => {
  test('reads an ordinary line', () => {
    expect(parseProcStat(initStat)).toEqual({
      pid: 1, comm: 'bash', state: 'S', pgrp: 1, startTimeTicks: '2807658',
    });
  });

  test('locates fields after a comm containing spaces and parentheses', () => {
    expect(parseProcStat(parenthesisedCommStat)).toEqual({
      pid: 9, comm: 'weird) app)', state: 'S', pgrp: 1, startTimeTicks: '2778072',
    });
  });

  test('locates fields when the kernel truncated a comm mid-parenthesis', () => {
    expect(parseProcStat(truncatedCommStat)).toEqual({
      pid: 16, comm: '(my (weird) app', state: 'S', pgrp: 1, startTimeTicks: '2778104',
    });
  });

  /**
   * The regression this parser exists for, stated as an assertion rather than as a comment: the
   * obvious implementation reads the wrong numbers off this real line, and reads *plausible* wrong
   * numbers, so nothing downstream would notice.
   */
  test('the whitespace-splitting parser this one replaces reads the wrong fields', () => {
    const naive = parenthesisedCommStat.trim().split(/\s+/);
    expect(naive[2]).toBe('app))');
    expect(naive[21]).not.toBe('2778072');
    expect(parseProcStat(parenthesisedCommStat)?.startTimeTicks).toBe('2778072');
  });

  test('reports a zombie state rather than hiding it', () => {
    expect(parseProcStat(zombieStat)?.state).toBe('Z');
  });

  test.each([
    ['empty', ''],
    ['no parentheses at all', '9 sleep S 1 1 1 0 -1'],
    ['a closing parenthesis before the opening one', '9 ) sleep ( S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'],
    ['a non-numeric pid', 'nine (sleep) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'],
    ['a pid of zero', '0 (sleep) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'],
    ['a line truncated before field 22', '9 (sleep) S 1 1 1 0 -1 0 0 0'],
    ['a multi-character state', '9 (sleep) SS 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'],
    ['a non-numeric pgrp', '9 (sleep) S 1 x 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'],
    ['a non-numeric start time', '9 (sleep) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 x 0 0'],
  ])('returns null for %s, which the caller must treat as failure and never as absence', (_label, line) => {
    expect(parseProcStat(line)).toBeNull();
  });
});

describe('parseBootTime', () => {
  test('reads btime out of a real /proc/stat', () => {
    expect(parseBootTime(procStat)).toBe(bootTime);
  });

  test('returns null when /proc/stat carries no btime line', () => {
    expect(parseBootTime('cpu  1 2 3\nctxt 4\n')).toBeNull();
  });

  test('returns null for a btime that is not a number', () => {
    expect(parseBootTime('btime later\n')).toBeNull();
  });

  test('does not mistake another line for btime', () => {
    expect(parseBootTime('cpu_btime 12\nbtime 34\n')).toBe('34');
  });
});

describe('linuxStartTime', () => {
  test('pairs boot time with start ticks', () => {
    expect(linuxStartTime(bootTime, '2778072')).toBe('1788259322:2778072');
  });
});
