import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DaemonStateStore } from '@wtm/core';
import { UnsupportedPlatformError } from '@wtm/platform';
import { protocolVersion } from '@wtm/protocol';
import { WtmDaemon, assertSupportedRuntime, watchRetryDelayMs } from '../main';
import type { IpcRequestHandler } from '../server';
import type { ReconcileSignal, ReconcilerClock } from '../reconciler-queue';

const scenarioPath = fileURLToPath(new URL('./main.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('WtmDaemon startup', () => {
  test('recovers state, then answers, and only then reads every repository', () => {
    // Reading the repositories is the slow part, and it happens behind an open socket: a
    // machine with dozens of them used to have no reachable daemon for as long as that took.
    expect(runScenario('startup-order')).toEqual({
      events: [
        'load-workspaces', 'load-repositories',
        'verify-processes', 'verify-endpoints', 'schedule-cleanup',
        'socket-start', 'git-snapshot', 'reconcile-state', 'watcher-start',
      ],
      persistedMainWorktree: true,
    });
  });

  test('serves the workspace when one repository cannot be read', () => {
    expect(runScenario('unreadable-repository')).toEqual({
      socketOpened: true,
      healthyRegistered: true,
      reported: ['Timed out after 200ms'],
    });
  });

  test('a deleted repository directory does not stop the daemon serving the rest', () => {
    expect(runScenario('deleted-repository')).toEqual({
      socketOpened: true,
      healthyRegistered: true,
      reported: [
        'Registered repository root is unavailable: <root>/gone'
        + ' (the registration is kept in case it returns; retire it with `wtm forget`)',
      ],
    });
  });

  test('says once that it cannot read the repositories at all, and what to do about it', () => {
    // Twenty-two identical timeouts in a log file, while `daemon status` reports the daemon as
    // running and reachable, is the shape this failure had: entirely accurate, and useless.
    const result = runScenario('unreadable-workspace') as {
      named: string[]; timeouts: number; attempts: number; retriedWithAWiderBound: number;
    };

    expect(result.named).toHaveLength(1);
    expect(result.named[0]).toContain('None of 2 registered repositories could be read');
    expect(result.timeouts).toBe(2);
    expect({ attempts: result.attempts, retried: result.retriedWithAWiderBound })
      .toEqual({ attempts: 4, retried: 2 });
    // Directories that open normally are evidence against a permission problem, so the report
    // must not send anyone to grant a background agent every file on the disk.
    expect(result.named[0]).toContain('answering too slowly');
    expect(result.named[0]).not.toContain('Full Disk Access');
  });

  test('a repository that only overran a cold read is reconciled, not written off', () => {
    const result = runScenario('cold-volume-read') as {
      attempts: number; reported: string[]; worktrees: [string, string][];
    };

    expect(result.attempts).toBe(2);
    expect(result.reported).toEqual([]);
    expect(result.worktrees.map(([, state]) => state)).toEqual(['DISCOVERED']);
  });

  test('names the privacy grant only for a directory that exists and refuses to open', () => {
    const result = runScenario('refused-directory') as { named: string[] };

    expect(result.named).toHaveLength(1);
    expect(result.named[0]).toContain('could not be opened either (EACCES)');
    expect(result.named[0]).toContain('Full Disk Access');
  });

  test('a socket that cannot bind stops startup before anything is watched', () => {
    expect(runScenario('startup-failure')).toEqual({
      error: 'bind failed',
      events: ['socket-start', 'socket-close'],
    });
  });

  test('closes every resource in reverse order when close races with watcher startup', () => {
    expect(runScenario('shutdown-during-start')).toEqual({
      events: ['socket-start', 'watcher-start', 'watcher-close', 'socket-close'],
      startError: 'WTM daemon closed during startup',
    });
  });

  test('continues closing the watcher when server cleanup fails', () => {
    expect(runScenario('close-failure-cleanup')).toEqual({
      closeError: 'server close failed',
      events: ['socket-close', 'watcher-close'],
    });
  });

  test('flushes to a fixed point when watcher idle work schedules after the first queue flush', () => {
    expect(runScenario('flush-fixed-point')).toEqual({ reconciliationsAfterFlush: 2 });
  });

  test('returns a stable failure envelope when explicit reconciliation fails', () => {
    expect(runScenario('explicit-reconcile-failure')).toEqual({
      ok: false,
      code: 'WTM_DAEMON_REQUEST_FAILED',
      message: 'The daemon could not complete the request.',
    });
  });

  test('refreshes watcher roots after a contained watcher error without adapter discovery', () => {
    expect(runScenario('watch-error-refresh')).toEqual({
      startsAfterFlush: 2,
      closesAfterFlush: 1,
      adapterDiscoveries: 0,
    });
  });

  test('reports a workspace root that disappeared and watches it again when it returns', () => {
    // The reconcile that finds the root back must also put it back under a watcher. Scheduling
    // work for it while leaving it out of the watch set meant the recovered workspace was read
    // once and then went unobserved again.
    expect(runScenario('watch-error-missing-root')).toEqual({
      reportedWhileMissing: ['Registered workspace root is unavailable'],
      reconcileOk: true,
      startsAfterRecovery: 3,
      closesAfterRecovery: 2,
      adapterDiscoveries: 0,
    });
  });
});

describe('WtmDaemon structural reconciliation', () => {
  test('does not discover adapters for ordinary source edits', () => {
    expect(runScenario('source-filter')).toEqual({ afterSourceEdit: 0, afterManifestEdit: 1 });
  });

  test('detects a raw Git worktree added outside the workspace through the common Git dir', () => {
    expect(runScenario('raw-worktree')).toEqual({ detectedOutside: true, worktreeCount: 2 });
  });
});

/**
 * Which machines the daemon agrees to start on.
 *
 * The refusal used to be `platform !== 'darwin'` with the message "WTM V1 daemon requires macOS",
 * which is now false in both directions: Linux has a backend, and a Windows user was told a fact
 * about the product rather than what is missing and where it is being decided. The list of
 * supported platforms is `@wtm/platform`'s rather than a second copy here, so adding a platform to
 * the seam does not also require finding this line.
 */
describe('assertSupportedRuntime', () => {
  const supportedNode = '24.4.1';

  test('accepts both platforms the seam has a backend for', () => {
    expect(() => assertSupportedRuntime('darwin', supportedNode)).not.toThrow();
    expect(() => assertSupportedRuntime('linux', supportedNode)).not.toThrow();
  });

  test('refuses Windows with a coded error naming the increment that will decide it', () => {
    const failure = ((): unknown => {
      try { return assertSupportedRuntime('win32', supportedNode); }
      catch (error) { return error; }
    })();

    // Coded, not a bare `Error`: Increment B established this after a startup failure reached a
    // user as an unstructured string with no code, no severity and nothing to act on.
    expect(failure).toBeInstanceOf(UnsupportedPlatformError);
    const error = failure as UnsupportedPlatformError;
    expect(error.code).toBe('WTM_PLATFORM_UNSUPPORTED');
    expect(error.severity).toBe('error');
    expect(error.context).toMatchObject({ platform: 'win32' });
    expect(error.message).toContain('Windows');
    expect(error.message).not.toContain('requires macOS');
  });

  test('still refuses a Node older than the one the daemon is built against', () => {
    expect(() => assertSupportedRuntime('darwin', '22.11.0')).toThrow('Node.js 24 or newer');
  });
});


/**
 * A watch the host will not give back is a permanent condition, and the daemon used to answer it
 * by rebuilding every watcher five times a second forever. Measured before this was written: with
 * a replacement that fails as soon as it is armed, the rebuild interval was a flat 201 ms -- the
 * queue's debounce -- for as long as the failure lasted. (The 1 s coalesce ceiling does not slow
 * this down; it only ever shortens a wait.) Nothing is gained by any of those attempts: the only
 * thing that ends the condition is a person raising a limit.
 */
class TestClock implements ReconcilerClock {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { due: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.#next;
    this.#next += 1;
    this.#timers.set(handle, { due: this.#now + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Moves to `now + ms`, firing whatever falls due on the way in due order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].due;
      due[1].callback();
    }
    this.#now = target;
  }
}

/** A store with nothing registered: this suite is about the retry, not about what is watched. */
const emptyStore = {
  listWorkspaces: () => [],
  listRepositories: () => [],
  listWorktrees: () => [],
} as unknown as DaemonStateStore;

interface FailingWatchHarness {
  clock: TestClock;
  daemon: WtmDaemon;
  request: IpcRequestHandler;
  fail: () => void;
  starts: () => number;
}

async function harnessWithFailingWatch(): Promise<FailingWatchHarness> {
  const clock = new TestClock();
  let schedule!: (signal: ReconcileSignal) => void;
  let request!: IpcRequestHandler;
  let starts = 0;
  const daemon = new WtmDaemon({
    stateStore: emptyStore,
    socketPath: '/unused/wtmd.sock',
    clock,
    serverFactory: ({ handler }) => {
      request = handler;
      return { start: async () => {}, close: async () => {} };
    },
    watcherFactory: (_registrations, capturedSchedule) => {
      schedule = capturedSchedule;
      return {
        start: async () => { starts += 1; },
        close: async () => {},
        whenIdle: async () => {},
      };
    },
  });
  await daemon.start();
  return {
    clock,
    daemon,
    request,
    fail: () => { schedule({ root: '/failing', kind: 'watch-error' }); },
    starts: () => starts,
  };
}

describe('watch retry backoff', () => {
  test('doubles from a second to a ceiling of a minute, and stays there', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 40].map(watchRetryDelayMs))
      .toEqual([0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test('re-arms a watch immediately the first time and waits before the second attempt', async () => {
    const harness = await harnessWithFailingWatch();
    try {
      expect(harness.starts()).toBe(1);

      // A watch error is usually transient -- a root replaced under a `git worktree` command,
      // an editor's atomic rename -- so the first recovery is not delayed at all.
      harness.fail();
      await harness.daemon.flush();
      expect(harness.starts()).toBe(2);

      // The replacement failed too, so this is not a transient condition. Nothing may be
      // rebuilt until the delay has actually elapsed.
      harness.fail();
      await harness.daemon.flush();
      expect(harness.starts()).toBe(2);

      harness.clock.advance(999);
      await harness.daemon.flush();
      expect(harness.starts()).toBe(2);

      harness.clock.advance(1);
      await harness.daemon.flush();
      expect(harness.starts()).toBe(3);
    } finally {
      await harness.daemon.close();
    }
  });

  test('reaches one attempt a minute after about a minute of failing, and no faster', async () => {
    const harness = await harnessWithFailingWatch();
    try {
      // Every wait the backoff produces, walked in order: 0, 1, 2, 4, 8, 16, 32, then the
      // ceiling. Seven attempts in the first minute rather than three hundred.
      for (const delayMs of [0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
        const before = harness.starts();
        harness.fail();
        await harness.daemon.flush();
        if (delayMs > 0) {
          expect({ delayMs, starts: harness.starts() }).toEqual({ delayMs, starts: before });
          harness.clock.advance(delayMs);
          await harness.daemon.flush();
        }
        expect({ delayMs, starts: harness.starts() }).toEqual({ delayMs, starts: before + 1 });
      }
    } finally {
      await harness.daemon.close();
    }
  });

  test('a failure long after the last one is a new failure, not the tail of an old streak', async () => {
    const harness = await harnessWithFailingWatch();
    try {
      harness.fail();
      await harness.daemon.flush();
      harness.fail();
      harness.clock.advance(1_000);
      await harness.daemon.flush();
      const settled = harness.starts();

      // A machine that watched happily for two minutes and then lost one watch must recover as
      // quickly as one that had never failed. Carrying the streak forever would make a single
      // transient failure on a long-lived daemon wait out a minute for no reason.
      harness.clock.advance(120_000);
      harness.fail();
      await harness.daemon.flush();

      expect(harness.starts()).toBe(settled + 1);
    } finally {
      await harness.daemon.close();
    }
  });

  test('an explicit reconcile does not wait out the backoff', async () => {
    const harness = await harnessWithFailingWatch();
    try {
      // Climb to the ceiling first: this is the state the remedy has to be usable from.
      for (const delayMs of [0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
        harness.fail();
        await harness.daemon.flush();
        harness.clock.advance(delayMs);
        await harness.daemon.flush();
      }
      harness.fail();
      await harness.daemon.flush();
      const waiting = harness.starts();

      // Anything that asks the daemon to reconcile -- `wtm init` is the client that does today
      // -- is about to be answered from a topology the daemon cannot observe, so the retry it is
      // sitting on is brought forward rather than left to finish waiting.
      const response = await harness.request({
        protocol: protocolVersion,
        id: 'reconcile-1',
        command: 'reconcile',
      });

      expect(response.ok).toBe(true);
      expect(harness.starts()).toBe(waiting + 1);

      // And the streak restarts with it. The rebuild the user asked for failed again, so the
      // daemon still backs off -- but from a second, not from the minute it had climbed to,
      // because the user has changed something and the evidence for the old streak is stale.
      harness.fail();
      await harness.daemon.flush();
      expect(harness.starts()).toBe(waiting + 1);
      harness.clock.advance(1_000);
      await harness.daemon.flush();
      expect(harness.starts()).toBe(waiting + 2);
    } finally {
      await harness.daemon.close();
    }
  });

  test('a retry armed when the daemon closes does not rebuild anything afterwards', async () => {
    const harness = await harnessWithFailingWatch();
    harness.fail();
    await harness.daemon.flush();
    harness.fail();
    await harness.daemon.flush();
    const closed = harness.starts();

    await harness.daemon.close();
    harness.clock.advance(600_000);

    expect(harness.starts()).toBe(closed);
  });
});
