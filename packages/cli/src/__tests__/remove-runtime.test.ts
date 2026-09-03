import { afterEach, describe, expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { jsonEnvelopeSchema, type JsonEnvelope } from '@wtm/protocol';
import type { GitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runScenario, scenarioTimeoutMs } from '../../../testkit/src/scenario-child';
import { runRemoveCommand } from '../commands/remove';
import { runCli } from '../main';

/**
 * Every scenario-driven case below blocks on `runScenario`, bounded by `scenarioTimeoutMs`, so the
 * test budget has to be the larger of the two. Leaving it at the suite default meant a 30 s test
 * wrapped around a 120 s child: on a loaded machine the runner gave up first and reported a
 * timeout for a scenario that was still working.
 */
const scenarioTestTimeoutMs = scenarioTimeoutMs + 30_000;

const fixtures: GitSafetyFixture[] = [];
const lifecycleScenarioPath = fileURLToPath(new URL('./remove-runtime.scenario.ts', import.meta.url));
const conflictScenarioPath = fileURLToPath(new URL('./remove-lease-conflict.scenario.ts', import.meta.url));
const resumeScenarioPath = fileURLToPath(new URL('./remove-resume.scenario.ts', import.meta.url));

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function runLifecycleCase(name: string): Record<string, any> {
  const result = runScenario('node', ['--import', 'tsx', lifecycleScenarioPath, name]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

describe('runtime-aware wtm remove', () => {
  test('refuses a worktree whose managed processes the unreachable daemon owns, and removes one with none', () => {
    expect(runLifecycleCase('daemon-unavailable')).toEqual({
      refusedExitCode: 4,
      refusedCodes: ['WTM_DAEMON_UNAVAILABLE'],
      refusedWorktreeExists: true,
      refusedDaemonCommands: ['stop'],
      allowedExitCode: 0,
      allowedOk: true,
      allowedWorktreeExists: false,
      // No stop was attempted for a worktree with nothing running; only the post-deletion
      // reconcile reached for the daemon that is not there.
      allowedDaemonCommands: ['reconcile'],
      allowedStoppedProcesses: 0,
    });
  }, scenarioTestTimeoutMs);

  test('deletes the ephemeral resources it materialized instead of refusing over them', () => {
    expect(runLifecycleCase('ephemeral-resource-cleanup')).toEqual({
      exitCode: 0,
      ok: true,
      errorCodes: [],
      // Zero here is the bug this case exists for: it means the cleanup stage never ran.
      collectedResources: 1,
      worktreeExists: false,
    });
  }, scenarioTestTimeoutMs);

  test('reports the cleanup it performed and releases the worktree endpoint leases before Git runs', () => {
    expect(runLifecycleCase('cleanup-envelope')).toEqual({
      exitCode: 0,
      ok: true,
      cleanup: {
        stoppedProcesses: 0,
        releasedEndpoints: 2,
        collectedResources: 0,
        retainedResources: [{ name: 'node_modules', reason: 'shared' }],
      },
      before: ['ACTIVE', 'ACTIVE'],
      after: ['RELEASED', 'RELEASED'],
      worktreeExists: false,
    });
  }, scenarioTestTimeoutMs);

  test('says runtime cleanup was skipped when the worktree is not one WTM knows about', () => {
    expect(runLifecycleCase('unregistered-worktree')).toEqual({
      exitCode: 0,
      ok: true,
      warnings: [['WTM_WORKSPACE_NOT_FOUND', true]],
      worktreeExists: false,
    });
  }, scenarioTestTimeoutMs);

  test('trusts the state database over a daemon that reports a stop it did not perform', () => {
    expect(runLifecycleCase('verify-reads-the-database')).toEqual({
      exitCode: 1,
      ok: false,
      codes: ['RUNTIME_STOP_FAILED'],
      context: { active: 1, cleanupOwed: 0 },
      daemonCommands: ['stop'],
      stillRunning: 'RUNNING',
      worktreeExists: true,
    });
  }, scenarioTestTimeoutMs);

  test('reconciles locally and says the daemon will emit worktree.removed when it next runs', () => {
    const report = runLifecycleCase('local-reconcile');

    expect(report).toMatchObject({ exitCode: 0, ok: true, worktreeExists: false });
    expect(report.warnings).toContainEqual(['WTM_DAEMON_UNAVAILABLE', true]);
    expect(report.registeredPaths).toEqual([expect.any(String)]);
  }, scenarioTestTimeoutMs);

  test('reports the analysis warnings of a removal it refused', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'untracked.txt', 'untracked\n');

    const envelope = await runRemoveCommand({
      repoPath: fixture.repoPath,
      selector: fixture.linkedWorktreePath,
      // A base ref this repository does not have is what the analysis warns about; the blocker
      // is the untracked file. Both come out of one analysis, and only the blockers used to
      // reach the caller.
      baseRef: 'refs/heads/absent-base',
    });

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({ ok: false, data: null });
    expect(envelope.errors.map(({ code }) => code)).toEqual(['GIT_UNTRACKED']);
    expect(envelope.warnings.map(({ code, severity }) => [code, severity]))
      .toEqual([['GIT_REPOSITORY_DEGRADED', 'warning']]);
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  });

  test('exits 3 for an operation conflict, the same class as a Git safety refusal', async () => {
    let stdout = '';
    const exitCode = await runCli(['remove', 'seven', '--json'], {
      cwd: '/workspace/repo',
      removeRunner: async () => conflictEnvelope(),
      stdout: (value) => { stdout += value; },
      stderr: () => {},
    });

    expect(exitCode).toBe(3);
    expect((JSON.parse(stdout) as JsonEnvelope<null>).errors[0]?.code).toBe('WTM_OPERATION_CONFLICT');
  });

  test('lets exactly one of two removing processes hold the repository', () => {
    const result = runScenario('node', ['--import', 'tsx', conflictScenarioPath]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      holderExitCode: 0,
      holderOk: true,
      holderWorktreeGone: true,
      contenderExitCode: 3,
      contenderOk: false,
      contenderCodes: ['WTM_OPERATION_CONFLICT'],
      // A live holder, so there is nothing to adopt and no stage to quote.
      contenderAbandoned: false,
      contenderOperation: 'remove',
      contenderWorktreeIntact: true,
    });
  }, scenarioTestTimeoutMs);

  test('leaves an adoptable lease when it is killed mid-cleanup, and finishes it under --resume', () => {
    const result = runScenario('node', ['--import', 'tsx', resumeScenarioPath]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      abandonedStage: 'stop-processes',
      abandonedWorktreeIntact: true,
      refusedExitCode: 3,
      refusedCodes: ['WTM_OPERATION_CONFLICT'],
      refusedAbandoned: true,
      refusedStage: 'stop-processes',
      refusedRemediation: [['wtm', 'remove', expect.any(String), '--resume']],
      refusedWorktreeIntact: true,
      resumedExitCode: 0,
      resumedOk: true,
      resumedWorktreeGone: true,
      // One stop the killed child never got an answer to, and one the resumed run completed.
      stopRequests: 2,
      resumedProcessStates: ['STOPPED'],
      leaseAfterResume: null,
    });
  }, scenarioTestTimeoutMs);
});

function conflictEnvelope(): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command: 'remove',
    scope: { mode: 'local' },
    data: null,
    warnings: [],
    errors: [{
      code: 'WTM_OPERATION_CONFLICT',
      message: 'Another wtm process is performing "remove" on this repository.',
      severity: 'error',
    }],
  };
}

async function createFixture(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
