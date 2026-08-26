import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarioPath = fileURLToPath(new URL('./init.scenario.ts', import.meta.url));

describe('initializeWorkspace', () => {
  test('creates an absent local config and registers discovered topology', () => {
    expect(runScenario('local')).toEqual({
      workspace: {
        name: 'workspace with spaces',
        scope: 'local',
        configIsLocal: true,
      },
      repositoryNames: ['first repo', 'second-repo'],
      discoveredWorktrees: 3,
      stableWorktreeIdsAfterReopen: true,
      reopenedDiscoveredWorktrees: 0,
      reopenedUpdatedWorktrees: 3,
      foundWorkspaceMakefile: true,
      config: 'version = 1\n\n[workspace]\nname = "workspace with spaces"\n',
    });
  });

  test('global-only initialization writes only beneath user data and scans the selected root', () => {
    expect(runScenario('global-only')).toEqual({
      scope: 'global-only',
      configIsInUserData: true,
      config: 'version = 1\n\n[workspace]\nname = "workspace with spaces"\n',
      localConfigExists: false,
      discoveryStayedAtSelectedRoot: true,
      repositoryCount: 2,
    });
  });

  test('preserves an existing workspace name and all existing config bytes on repeat init', () => {
    expect(runScenario('repeat')).toEqual({
      workspaceName: 'chosen-by-user',
      configUnchanged: true,
      configChanged: false,
    });
  });

  test('rejects an invalid proposed name before writing configuration', () => {
    expect(runScenario('invalid-name')).toEqual({
      errorCode: 'WTM_CONFIG_INVALID',
      localConfigExists: false,
    });
  });

  test('rolls back workspace, repositories, and reconciled worktrees when the second reconciliation fails', () => {
    expect(runScenario('reconciliation-rollback')).toEqual({
      errorMessage: 'injected second reconciliation failure',
      maximumOuterTransactionDepth: 1,
      reconciliationDepths: [1, 1],
      persistedCounts: { workspaces: 0, repositories: 0, worktrees: 0 },
    });
  });

  test('returns safe required changes instead of modifying an existing incomplete config', () => {
    expect(runScenario('existing-incomplete')).toEqual({
      errorCode: 'WTM_CONFIG_INVALID',
      conflict: 'update-required',
      action: 'Apply the listed requiredChanges to the existing file, then rerun wtm init.',
      requiredChanges: [
        { path: 'version', value: 1 },
        { path: 'workspace.name', value: 'workspace with spaces' },
      ],
      finalConfig: '# user setting\n[ports.web]\npreferred = 4111\n',
    });
  });

  test('never reaches config publication or changes bytes for an existing file', () => {
    expect(runScenario('existing-publication-guard')).toEqual({
      errorCode: 'WTM_CONFIG_INVALID',
      conflict: 'update-required',
      publicationHookCalled: false,
      finalConfig: '# keep exactly\n[ports.web]\npreferred = 4222\n',
    });
  });

  test('never serializes environment secrets or user-authored workspace names in update errors', () => {
    expect(runScenario('secret-context')).toEqual({
      errorCode: 'WTM_CONFIG_INVALID',
      requiredChanges: [{ path: 'version', value: 1 }],
      serializedErrorContainsEnvironmentSecret: false,
      serializedErrorContainsUserWorkspaceName: false,
      configUnchanged: true,
    });
  });

  test('sanitizes malformed secret-bearing TOML at the initialization boundary', () => {
    expect(runScenario('malformed-secret')).toEqual({
      errorCode: 'WTM_CONFIG_INVALID',
      message: 'WTM configuration contains invalid TOML syntax.',
      sourceIsConfigPath: true,
      category: 'toml-syntax',
      action: 'Correct the TOML syntax in the source file, then rerun wtm init.',
      serializedErrorContainsSecret: false,
      serializedErrorContainsTokenName: false,
      serializedErrorContainsSourceExcerpt: false,
      serializedErrorContainsParserMessage: false,
      serializedErrorContainsParserMetadata: false,
      messageContainsSecret: false,
      messageContainsSourceExcerpt: false,
      stackContainsParserDetails: false,
      configUnchanged: true,
    });
  });

  test('uses no-replace publication when another actor creates the initially absent config', () => {
    expect(runScenario('concurrent-create')).toEqual({
      errorCode: 'WTM_CONFIG_INVALID',
      conflict: 'concurrent-creation',
      finalConfig: 'version = 1\n\n[workspace]\nname = "created-concurrently"\n',
    });
  });
});

function runScenario(name: string): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], { encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
