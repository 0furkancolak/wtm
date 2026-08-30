import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./full-workflow.scenario.ts', import.meta.url));

test('runs the complete release safety workflow in an isolated local fixture', () => {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { timeout: scenarioTimeoutMs, encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    initialized: true,
    rawWorktreeDiscovered: true,
    statusOk: true,
    resolvedTask: ['node', '-e', 'console.log("dev")'],
    analysisCompleted: true,
    branchSelectorWorks: true,
    relativeSelectorWorks: true,
    absoluteSelectorWorks: true,
    numericSelectorWorks: true,
    allModeWorks: true,
    globalModeWorks: true,
    cleanupCandidatesModeWorks: true,
    conflictingModes: { code: 2, error: 'WTM_CONFIG_INVALID' },
    missingSelector: { code: 2, error: 'WTM_WORKSPACE_NOT_FOUND' },
    unavailableState: { code: 2, error: 'WTM_NOT_INITIALIZED' },
    unavailableRemoveState: { code: 2, error: 'WTM_NOT_INITIALIZED' },
    gitDiscoveryFailure: { code: 1, error: 'GIT_COMMAND_FAILED', command: 'analyze' },
    removeGitDiscoveryFailure: { code: 1, error: 'GIT_COMMAND_FAILED', command: 'remove' },
    nestedBlockedAnalysis: ['GIT_UNTRACKED'],
    dirtyRemovalBlocked: 'GIT_UNTRACKED',
    preservedRemoveSelectors: {
      numeric: 'GIT_UNTRACKED', branch: 'GIT_UNTRACKED', absolute: 'GIT_UNTRACKED',
    },
    pushed: true,
    safelyRemoved: true,
    launchAgentsUntouched: true,
    socketAbsent: true,
    remoteProtocol: 'file',
  });
}, 30_000);
