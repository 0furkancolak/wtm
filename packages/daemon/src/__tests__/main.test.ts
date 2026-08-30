import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  test('recovers state in order and opens the socket last', () => {
    expect(runScenario('startup-order')).toEqual({
      events: [
        'load-workspaces', 'load-repositories', 'git-snapshot', 'reconcile-state',
        'verify-processes', 'verify-endpoints', 'schedule-cleanup', 'watcher-start', 'socket-start',
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

  test('closes already-opened resources in reverse order when socket startup fails', () => {
    expect(runScenario('startup-failure')).toEqual({
      error: 'bind failed',
      events: ['watcher-start', 'socket-start', 'socket-close', 'watcher-close'],
    });
  });

  test('does not open the socket when close races with watcher startup', () => {
    expect(runScenario('shutdown-during-start')).toEqual({
      events: ['watcher-start', 'watcher-close'],
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

  test('retains watcher refresh intent across a missing-root failure until explicit reconcile succeeds', () => {
    expect(runScenario('watch-error-missing-root')).toEqual({
      firstError: 'Registered workspace root is unavailable',
      reconcileOk: true,
      startsAfterRecovery: 2,
      closesAfterRecovery: 1,
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
