import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { GitCommandError, WorktreeAnalysisError } from '@wtm/core';
import { wtmErrorCodeSchema } from '@wtm/protocol';
import { runScenario, scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';
import { toGitSafetyError } from '../git-error';

const driftScenarioPath = fileURLToPath(new URL('./git-error-drift.scenario.ts', import.meta.url));

describe('toGitSafetyError', () => {
  test('reports a code the schema gained after this file was written under that code', () => {
    // `process.execPath` is the bun binary that runs this suite; the scenario needs Bun's
    // `mock.module`, and needs its own process so the mocked registry cannot outlive it.
    const result = runScenario(process.execPath, ['run', driftScenarioPath]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const scenario = JSON.parse(result.stdout) as { futureCode: string; reported: { code: string } };

    // Not `GIT_REPOSITORY_DEGRADED`: a code the catalogue knows must keep its own exit code.
    expect(scenario.reported.code).toBe(scenario.futureCode);
  }, scenarioTimeoutMs);

  test('passes through every code the catalogue declares, with its context and remediation', () => {
    for (const code of wtmErrorCodeSchema.options) {
      const failure = Object.assign(new Error(`refused: ${code}`), {
        code,
        context: { worktreePath: '/tmp/example' },
        remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'remove', '--resume'] }],
      });

      expect(toGitSafetyError(failure, 'remove')).toEqual({
        code,
        message: `refused: ${code}`,
        severity: 'error',
        context: { worktreePath: '/tmp/example', command: 'remove' },
        remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'remove', '--resume'] }],
      });
    }
  });

  test('degrades a code the catalogue does not declare', () => {
    const failure = Object.assign(new Error('invented'), { code: 'NOT_A_WTM_ERROR_CODE' });

    expect(toGitSafetyError(failure, 'analyze')).toEqual({
      code: 'GIT_REPOSITORY_DEGRADED',
      message: 'invented',
      severity: 'error',
      context: { command: 'analyze' },
    });
  });

  test('drops a malformed remediation rather than emitting an invalid envelope', () => {
    const failure = Object.assign(new Error('refused'), {
      code: 'GIT_DIRTY_STAGED',
      remediation: [{ kind: 'not-a-suggestion' }, { kind: 'command-suggestion', argv: [] }],
    });

    expect(toGitSafetyError(failure, 'remove')).not.toHaveProperty('remediation');
  });

  test('keeps the dedicated shapes for GitCommandError and WorktreeAnalysisError', () => {
    const gitFailure = new GitCommandError({
      argv: ['status', '--porcelain=v2'],
      exitCode: 128,
      signal: null,
      stderr: 'fatal: not a git repository',
      timedOut: false,
    });

    expect(toGitSafetyError(gitFailure, 'analyze')).toMatchObject({
      code: 'GIT_COMMAND_FAILED',
      severity: 'error',
      context: { command: 'analyze', argv: ['status', '--porcelain=v2'], exitCode: 128 },
    });
    expect(toGitSafetyError(new WorktreeAnalysisError('degraded', { repoPath: '/tmp/repo' }), 'analyze'))
      .toMatchObject({
        code: 'GIT_REPOSITORY_DEGRADED',
        message: 'degraded',
        context: { repoPath: '/tmp/repo', command: 'analyze' },
      });
  });
});
