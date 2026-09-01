import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./reconcile-fallback.scenario.ts', import.meta.url));

// The production CLI opens the real state store, so the scenario runs under Node, not Bun.
function runScenario(name: string): Record<string, any> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], {
    timeout: scenarioTimeoutMs,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  return JSON.parse(result.stdout) as Record<string, any>;
}

describe('a worktree created after `wtm init`', () => {
  /**
   * Characterization, not a new requirement: the daemon reconciles every registered repository
   * as it starts, so a worktree created while it was down is visible the moment it is back,
   * with no `wtm init` from the user. Recorded here because the acceptance criterion is met by
   * code that already exists, and a criterion closed by evidence needs the evidence kept.
   */
  test('is visible once the daemon returns, with no manual `wtm init`', () => {
    const { status } = runScenario('daemon-returns');
    expect(status).toEqual({
      exitCode: 0,
      ok: true,
      path: expect.stringMatching(/repo-feature$/),
      registered: true,
      branch: 'refs/heads/feature',
      stderr: '',
    });
  });

  test('is reconciled locally by a read command when the daemon is unreachable', () => {
    const { env, status, registrationFinding } = runScenario('daemon-down');
    // `wtm env` is the command the defect was reported against, and it runs first, so it is
    // the one that reconciles. It answers instead of failing `WTM_WORKSPACE_NOT_FOUND`.
    expect(env).toMatchObject({ exitCode: 0, ok: true, error: null });
    // The reader is told what happened, and is not told to run `wtm init`.
    expect(env.stderr).toContain('[WTM_DAEMON_UNAVAILABLE]');
    expect(env.stderr).toContain('reconciled locally');
    expect(env.stderr).not.toContain('wtm init');
    // And the registry keeps it, so the next read command has nothing left to say about it.
    expect(status).toEqual({
      exitCode: 0,
      ok: true,
      path: expect.stringMatching(/repo-feature$/),
      registered: true,
      branch: 'refs/heads/feature',
      stderr: '',
    });
    // `status`'s lookup and `doctor`'s `findRegistration` must agree that it is registered.
    expect(registrationFinding).toEqual({
      status: 'warning',
      registered: true,
      daemonReachable: false,
    });
  });

  test('is left to the daemon while the daemon is answering', () => {
    const { status } = runScenario('daemon-up');
    expect(status).toEqual({
      exitCode: 0,
      ok: true,
      path: expect.stringMatching(/ws$/),
      registered: false,
      branch: null,
      stderr: '',
    });
  });

  test('does not make a read command in an ordinary directory fail or talk about it', () => {
    // The fallback's `git worktree list` fails here, because there is no repository to list.
    // The command answers anyway, which is the whole rule: a diagnostic that dies while
    // diagnosing is worse than one that reports a stale answer.
    const { status } = runScenario('unrelated-directory');
    expect(status).toEqual({
      exitCode: 0,
      ok: true,
      path: expect.stringMatching(/ws$/),
      registered: false,
      branch: null,
      stderr: '',
    });
  });

  test('still ends in one coded envelope when the registry cannot be written at all', () => {
    const { status, error } = runScenario('unwritable-registry');
    expect(error).toBe('WTM_NOT_INITIALIZED');
    expect(status).toMatchObject({ exitCode: 2, ok: false, registered: false, stderr: '' });
  });
});
