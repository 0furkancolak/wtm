import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitSafetyFixture, type GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { runScenario } from '../../../../testkit/src/scenario-child';
import type { RuntimeDaemonClient } from '../runtime-client';
import { readCiStatus, runCiUnwatchCommand, runCiWatchCommand } from '../ci';
import { runCli } from '../../main';

const statusScenarioPath = fileURLToPath(new URL('./ci-status.scenario.ts', import.meta.url));

const fixtures: GitSafetyFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function repository() {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return { fixture, head: fixture.mainHead, databasePath: join(fixture.root, 'state.db') };
}

describe('ci commands', () => {
  test('watch sends the current commit and validates the acceptance', async () => {
    const { fixture, head } = await repository();
    const calls: Array<{ command: string; args: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, args });
        return {
          schemaVersion: 1, ok: true, command, warnings: [], errors: [],
          data: {
            reused: false,
            watch: {
              watchId: 'w', repo: 'github.com/acme/widgets', branch: 'main', headSha: head, state: 'pending',
              startedAt: '2026-09-14T12:00:00.000Z', updatedAt: '2026-09-14T12:00:00.000Z', runs: [],
            },
          },
        };
      },
    };
    const envelope = await runCiWatchCommand({ cwd: fixture.repoPath, pr: 12 }, client);
    expect(envelope).toMatchObject({ ok: true, command: 'ci watch', data: { watch: { headSha: head } } });
    expect(calls).toEqual([{ command: 'ci.watch', args: { cwd: fixture.repoPath, branch: 'main', headSha: head, pr: 12 } }]);
  });

  test('watch refuses a daemon answer for another commit', async () => {
    const { fixture } = await repository();
    const client: RuntimeDaemonClient = {
      request: async (command) => ({
        schemaVersion: 1, ok: true, command, warnings: [], errors: [],
        data: {
          reused: false,
          watch: {
            watchId: 'w', repo: 'github.com/acme/widgets', branch: 'main', headSha: 'f'.repeat(40), state: 'pending',
            startedAt: '2026-09-14T12:00:00.000Z', updatedAt: '2026-09-14T12:00:00.000Z', runs: [],
          },
        },
      }),
    };
    expect(await runCiWatchCommand({ cwd: fixture.repoPath }, client)).toMatchObject({
      ok: false, command: 'ci watch', errors: [{ code: 'WTM_DAEMON_REQUEST_FAILED' }],
    });
  });

  test('watch without a daemon is WTM_DAEMON_UNAVAILABLE', async () => {
    const { fixture } = await repository();
    expect(await runCiWatchCommand({ cwd: fixture.repoPath })).toMatchObject({
      ok: false, command: 'ci watch', errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }],
    });
  });

  test('unwatch forwards cwd and validates the result', async () => {
    const { fixture } = await repository();
    const calls: Array<{ command: string; args: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, args });
        return { schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { stopped: false, watch: null } };
      },
    };
    expect(await runCiUnwatchCommand({ cwd: fixture.repoPath }, client)).toMatchObject({
      ok: true, command: 'ci unwatch', data: { stopped: false, watch: null },
    });
    expect(calls).toEqual([{ command: 'ci.unwatch', args: { cwd: fixture.repoPath } }]);
  });

  test('unwatch rejects an invalid daemon result', async () => {
    const { fixture } = await repository();
    const client: RuntimeDaemonClient = {
      request: async (command) => ({ schemaVersion: 1, ok: true, command, warnings: [], errors: [], data: { stopped: 'nope' } }),
    };
    expect(await runCiUnwatchCommand({ cwd: fixture.repoPath }, client)).toMatchObject({
      ok: false, command: 'ci unwatch', errors: [{ code: 'WTM_DAEMON_REQUEST_FAILED' }],
    });
  });

  test('status with no state database returns no watch, locally and with no daemon', () => {
    const nonexistentDatabasePath = join('/nonexistent-wtm-ci-status', 'state.db');
    expect(readCiStatus({ cwd: '/nonexistent-wtm-ci-status', all: false, databasePath: nonexistentDatabasePath }))
      .toMatchObject({ ok: true, command: 'ci status', data: { watch: null } });
    expect(readCiStatus({ cwd: '/nonexistent-wtm-ci-status', all: true, databasePath: nonexistentDatabasePath }))
      .toMatchObject({ ok: true, command: 'ci status', data: { watches: [] } });
  });

  test('the ci commands are registered with --worktree, --repo and --json', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['ci', 'status', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, command: 'ci status', data: { watch: null } });
  });

  test('ci watch and ci unwatch are also registered top-level subcommands', async () => {
    const { fixture, databasePath } = await repository();
    let out = '';
    const code = await runCli(['ci', 'watch', '--json'], {
      cwd: fixture.repoPath,
      taskTargetDatabasePath: databasePath,
      taskTargetGlobalConfigPath: join(fixture.root, 'config.toml'),
      stdout: (value) => { out += value; },
      stderr: () => {},
    });
    expect(code).toBeGreaterThan(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, command: 'ci watch', errors: [{ code: 'WTM_DAEMON_UNAVAILABLE' }] });
  });

  // A real `SQLiteStateStore` must run out of process — constructing one here would panic this
  // Bun build's better-sqlite3 binding, exactly as it does for every other store-backed CLI test.
  describe('ci-status scenario (a real SQLiteStateStore, out of process)', () => {
    test('reads a started watch back through both the single-worktree and --all shapes', () => {
      const result = runScenario('node', ['--import', 'tsx', statusScenarioPath, 'watch-then-status']);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        beforeOk: true, beforeCommand: 'ci status', beforeWatch: null,
        singleOk: true, singleCommand: 'ci status',
        allOk: true, allCommand: 'ci status',
      });
      expect(report['singleHeadSha']).toBe((report['allWatches'] as Array<{ headSha: string }>)[0]?.headSha);
      expect(report['allWatches']).toHaveLength(1);
    });

    test('refuses a directory inside no registered worktree, suggesting --all', () => {
      const result = runScenario('node', ['--import', 'tsx', statusScenarioPath, 'status-outside-registered-worktree']);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        code: 'WTM_WORKSPACE_NOT_FOUND',
        remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'ci', 'status', '--all'] }],
      });
    });

    test('stops reporting a watch once its worktree is reconciled away by a removal', () => {
      const result = runScenario('node', ['--import', 'tsx', statusScenarioPath, 'status-excludes-removed-worktree']);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        beforeRemovalCount: 1,
        singleOk: false, singleCode: 'WTM_WORKSPACE_NOT_FOUND',
        allOk: true, allWorktreePaths: [],
      });
    });
  });
});
