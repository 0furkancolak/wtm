import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario as runScenarioChild } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./database-contract.scenario.ts', import.meta.url));

function runScenario(command: string, args: readonly string[]): Record<string, unknown> {
  const result = runScenarioChild(command, [...args]);

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('SQLite database drivers', () => {
  test('persist equivalent SQLiteStateStore behavior with better-sqlite3 and node:sqlite', () => {
    const betterSqlite = runScenario('node', ['--import', 'tsx', scenarioPath, 'better-sqlite']);
    const nodeSqlite = runScenario('node', ['--import', 'tsx', scenarioPath, 'node-sqlite']);
    const expected = {
      workspace: ['contract', '/projects/contract', 'local'],
      repository: ['/projects/contract/repository', 'ssh://example.invalid/contract.git'],
      worktree: ['/projects/contract/repository', 1, 'DISCOVERED'],
      endpoint: ['web', 'tcp', '127.0.0.1', 45123, 'ACTIVE'],
      reservation: [true, true],
      process: ['dev', 4242, 'RUNNING', false],
      adapterTrust: ['contract-adapter', '/adapters/contract', 'a'.repeat(64)],
      resource: ['/resources/contract/cache', 'directory', 'READY', 1, 100, 128],
      operationLease: [
        'acquired', 'operation-token', 'conflict', 7331, true, true,
        'release-endpoints', '2026-08-28T08:00:43.000Z', false, false, true, null,
      ],
      endpointRelease: [2, 0, [
        ['api', 'RELEASED', '2026-08-28T08:00:14.000Z'],
        ['web', 'RELEASED', '2026-08-28T08:00:14.000Z'],
      ]],
      resourceFinalization: [true, true, null, 'REMOVED', null],
      nested: ['nested rollback', true, true, false],
      rollback: ['contract rollback', true],
      relationships: {
        repositoryWorkspace: true,
        worktreeRepository: true,
        processWorktree: true,
      },
      readonlyWriteRejected: true,
    };

    expect(betterSqlite).toEqual(expected);
    expect(nodeSqlite).toEqual(betterSqlite);
  });
});
