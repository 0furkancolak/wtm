import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

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

  test('writes what the repositories declare into the configuration it creates', () => {
    const result = runScenario('detection') as {
      services: Array<[string, string]>;
      pendingConfig: string;
      config: string;
    };

    expect(result.services).toEqual([
      ['first-repo', 'services/first repo'],
      ['second-repo', 'tools/second-repo'],
    ]);
    // A band that contains both preferred ports: the built-in 20000-50000 would offer neither.
    expect(result.config).toContain('range = "4000-5373"');
    expect(result.config).toContain('[ports.first-repo]\npreferred = 4000');
    // Two repositories both read PORT, and each one has to mean its own endpoint.
    expect(result.config).toContain('[repos.first-repo.environment]');
    expect(result.config).toContain('PORT = "{port.first-repo}"');
    expect(result.config).toContain('PORT = "{port.second-repo}"');
    expect(result.config).toContain('CORS_ORIGINS = "{cors.origins}"');
    // The second repository's address named the first repository's port, so it is written as it.
    expect(result.config).toContain('API_URL = "http://localhost:{port.first-repo}/v1"');
    expect(result.pendingConfig).toBe('');
  });

  test('writes nothing but a name and a version when detection is turned off', () => {
    expect(runScenario('detection-disabled')).toEqual({
      detection: null,
      config: 'version = 1\n\n[workspace]\nname = "workspace with spaces"\n',
    });
  });

  test('reports what it found rather than editing a configuration it did not write', () => {
    expect(runScenario('detection-existing')).toEqual({
      configUnchanged: true,
      pendingMentionsPort: true,
      pendingBlocks: [
        ['ports', false],
        ['ports.first-repo', false],
        ['repos.first-repo', false],
      ],
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
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], { timeout: scenarioTimeoutMs, encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
