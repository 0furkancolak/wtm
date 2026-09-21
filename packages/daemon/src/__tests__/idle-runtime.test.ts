import { describe, expect, test } from 'bun:test';
import type { IdlePolicy, ManagedProcessRecord } from '@wtm/core';
import { IdleRuntimeSuspender, type IdleSuspensionSupervisor } from '../idle-runtime';

/**
 * Every test here drives `sweep()` from an injected clock rather than waiting a window out: an
 * idle window is measured in minutes, and a suite that slept through one would be measuring the
 * test runner instead of the policy. No process is started — the supervisor below is a fake,
 * which is the point: this file is about the decision, and `process-supervisor.test.ts` is about
 * the stop it delegates to.
 */
function record(overrides: Partial<ManagedProcessRecord> = {}): ManagedProcessRecord {
  return {
    id: 'process-1',
    worktreeId: 'worktree-1',
    taskName: 'dev',
    pid: 4001,
    pgid: 4001,
    processStartTime: 'start',
    commandFingerprint: 'fingerprint',
    state: 'RUNNING',
    startedAt: '2026-09-21T09:00:00.000Z',
    stoppedAt: null,
    stdoutPath: '/logs/worktree-1/dev/stdout.log',
    stderrPath: '/logs/worktree-1/dev/stderr.log',
    cleanupRequired: false,
    ...overrides,
  };
}

const thirtyMinutes: IdlePolicy = { timeoutMs: 1_800_000, timeout: '30m' };
const startedAtMs = Date.parse('2026-09-21T09:00:00.000Z');

interface Harness {
  suspender: IdleRuntimeSuspender;
  stopped: string[];
  notes: Array<[string, string]>;
  events: string[];
  errors: unknown[];
  setNow(at: number): void;
  setRecords(records: ManagedProcessRecord[]): void;
}

function harness(options: {
  records?: ManagedProcessRecord[];
  policies?: Record<string, ReadonlyMap<string, IdlePolicy>>;
  stopRecord?: IdleSuspensionSupervisor['stopRecord'];
  readIdlePolicies?: (worktreeId: string) => Promise<ReadonlyMap<string, IdlePolicy>>;
} = {}): Harness {
  let now = startedAtMs;
  let records = options.records ?? [record()];
  const stopped: string[] = [];
  const notes: Array<[string, string]> = [];
  const events: string[] = [];
  const errors: unknown[] = [];
  const policies = options.policies ?? { 'worktree-1': new Map([['dev', thirtyMinutes]]) };
  const suspender = new IdleRuntimeSuspender({
    supervisor: {
      list: (worktreeId) => records.filter((entry) => worktreeId === undefined || entry.worktreeId === worktreeId),
      stopRecord: options.stopRecord ?? (async (entry) => {
        stopped.push(entry.id);
        records = records.map((candidate) => (candidate.id === entry.id
          ? { ...candidate, state: 'STOPPED' as const, stoppedAt: new Date(now).toISOString() }
          : candidate));
        return { ...entry, state: 'STOPPED', stoppedAt: new Date(now).toISOString() };
      }),
    },
    readIdlePolicies: options.readIdlePolicies
      ?? (async (worktreeId) => policies[worktreeId] ?? new Map()),
    note: async (entry, line) => { notes.push([entry.taskName, line]); },
    onSuspended: (entry) => { events.push(entry.id); },
    onError: (error) => { errors.push(error); },
    now: () => now,
  });
  return {
    suspender, stopped, notes, events, errors,
    setNow: (at) => { now = at; },
    setRecords: (next) => { records = next; },
  };
}

describe('IdleRuntimeSuspender', () => {
  test('stops an opted-in task once its window has passed with no WTM interaction', async () => {
    const it = harness();

    // The sweep that runs while the task is starting is where its window begins.
    expect(await it.suspender.sweep()).toEqual([]);

    it.setNow(startedAtMs + 1_799_999);
    expect(await it.suspender.sweep()).toEqual([]);
    expect(it.stopped).toEqual([]);

    it.setNow(startedAtMs + 1_800_000);
    const suspended = await it.suspender.sweep();
    expect(suspended.map(({ id, state }) => [id, state])).toEqual([['process-1', 'STOPPED']]);
    expect(it.stopped).toEqual(['process-1']);
    // The reason is in the task's own log stream, citing the configured window, because that is
    // the whole of the v1 surface: no new state, no new field, no new command.
    expect(it.notes).toEqual([['dev', expect.stringContaining('30m')]]);
    expect(it.notes[0]?.[1]).toContain('wtm start dev');
    // An idle suspension is a stop, so what a workspace attached to `runtime.stopped` runs.
    expect(it.events).toEqual(['process-1']);
    expect(it.errors).toEqual([]);
  });

  test('any WTM interaction with the task restarts its window', async () => {
    const it = harness();

    it.setNow(startedAtMs + 1_700_000);
    it.suspender.touch('worktree-1', 'dev');
    it.setNow(startedAtMs + 1_800_000);
    expect(await it.suspender.sweep()).toEqual([]);

    it.setNow(startedAtMs + 1_700_000 + 1_800_000);
    expect((await it.suspender.sweep()).map(({ id }) => id)).toEqual(['process-1']);
  });

  test('a worktree-scoped interaction such as ps counts for every running task in it', async () => {
    const it = harness({
      records: [record(), record({ id: 'process-2', taskName: 'api' })],
      policies: { 'worktree-1': new Map([['dev', thirtyMinutes], ['api', thirtyMinutes]]) },
    });

    it.setNow(startedAtMs + 1_000_000);
    it.suspender.touch('worktree-1');
    it.setNow(startedAtMs + 1_800_000);
    expect(await it.suspender.sweep()).toEqual([]);

    it.setNow(startedAtMs + 1_000_000 + 1_800_000);
    expect((await it.suspender.sweep()).map(({ id }) => id)).toEqual(['process-1', 'process-2']);
  });

  test('leaves alone every task that did not opt in, and every process that is not running', async () => {
    const it = harness({
      records: [
        record({ id: 'opted-out', taskName: 'debug' }),
        record({ id: 'starting', state: 'STARTING' }),
        record({ id: 'stopped', state: 'STOPPED' }),
        record({ id: 'repairing', cleanupRequired: true }),
        record({ id: 'other-worktree', worktreeId: 'worktree-2' }),
      ],
      policies: {
        'worktree-1': new Map([['dev', thirtyMinutes]]),
        'worktree-2': new Map(),
      },
    });

    it.setNow(startedAtMs + 86_400_000);
    expect(await it.suspender.sweep()).toEqual([]);
    expect(it.stopped).toEqual([]);
    expect(it.errors).toEqual([]);
  });

  test('a configuration that cannot be read costs that worktree its sweep and nothing else', async () => {
    const failure = new Error('config unreadable');
    const it = harness({
      records: [record({ worktreeId: 'broken' }), record({ id: 'process-2' })],
      readIdlePolicies: async (worktreeId) => {
        if (worktreeId === 'broken') throw failure;
        return new Map([['dev', thirtyMinutes]]);
      },
    });

    expect(await it.suspender.sweep()).toEqual([]);
    it.setNow(startedAtMs + 1_800_000);
    expect((await it.suspender.sweep()).map(({ id }) => id)).toEqual(['process-2']);
    expect(it.errors).toEqual([failure, failure]);
  });

  test('a stop that fails is reported, not retried on every following sweep', async () => {
    const failure = new Error('RUNTIME_STOP_FAILED');
    let attempts = 0;
    const it = harness({
      stopRecord: async () => { attempts += 1; throw failure; },
    });

    expect(await it.suspender.sweep()).toEqual([]);
    it.setNow(startedAtMs + 1_800_000);
    expect(await it.suspender.sweep()).toEqual([]);
    expect(attempts).toBe(1);
    expect(it.errors).toEqual([failure]);

    // The window restarts from the failed attempt, so the sweep does not hammer a process it
    // cannot stop; it tries again one window later.
    it.setNow(startedAtMs + 1_800_000 + 1);
    expect(await it.suspender.sweep()).toEqual([]);
    expect(attempts).toBe(1);
    it.setNow(startedAtMs + 1_800_000 + 1_800_000);
    expect(await it.suspender.sweep()).toEqual([]);
    expect(attempts).toBe(2);
  });

  test('clocks live only in memory, and only for processes that are still running', async () => {
    const it = harness();
    it.setNow(startedAtMs + 60_000);
    it.suspender.touch('worktree-1', 'dev');

    // The task stops and starts again: the old clock is pruned rather than counted against the
    // new run, which is what a daemon restart also produces — an empty map and a fresh window.
    it.setRecords([record({ id: 'process-9', startedAt: new Date(startedAtMs + 120_000).toISOString() })]);
    it.setNow(startedAtMs + 120_000 + 1_799_999);
    expect(await it.suspender.sweep()).toEqual([]);
    it.setNow(startedAtMs + 120_000 + 1_800_000);
    expect((await it.suspender.sweep()).map(({ id }) => id)).toEqual(['process-9']);
  });

  test('a request that arrives while the note is being written calls the suspension off', async () => {
    let suspender: IdleRuntimeSuspender;
    const stopped: string[] = [];
    let now = startedAtMs;
    suspender = new IdleRuntimeSuspender({
      supervisor: {
        list: () => [record()],
        stopRecord: async (entry) => { stopped.push(entry.id); return { ...entry, state: 'STOPPED' }; },
      },
      readIdlePolicies: async () => new Map([['dev', thirtyMinutes]]),
      // Somebody runs `wtm logs dev` in the time it takes to write the line explaining the stop.
      note: async () => { suspender.touch('worktree-1', 'dev'); },
      now: () => now,
    });

    expect(await suspender.sweep()).toEqual([]);
    now = startedAtMs + 1_800_000;
    expect(await suspender.sweep()).toEqual([]);
    expect(stopped).toEqual([]);
  });

  /**
   * The clocks are memory only, so a daemon that restarts inherits processes it was not there to
   * watch. It dates their windows from the moment it first sees them rather than from `startedAt`:
   * WTM observed no interaction while it was not running, which is not the same as observing none.
   */
  test('a process recovered after a daemon restart starts a fresh window, not an expired one', async () => {
    const it = harness({ records: [record({ startedAt: new Date(startedAtMs - 86_400_000).toISOString() })] });

    expect(await it.suspender.sweep()).toEqual([]);
    it.setNow(startedAtMs + 1_799_999);
    expect(await it.suspender.sweep()).toEqual([]);
    it.setNow(startedAtMs + 1_800_000);
    expect((await it.suspender.sweep()).map(({ id }) => id)).toEqual(['process-1']);
  });

  test('closing stops sweeping and forgets every clock', async () => {
    const it = harness();
    it.suspender.start();
    await it.suspender.close();
    it.setNow(startedAtMs + 86_400_000);
    expect(await it.suspender.sweep()).toEqual([]);
    expect(it.stopped).toEqual([]);
  });
});
