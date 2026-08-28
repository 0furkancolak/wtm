import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarioPath = fileURLToPath(new URL('./database-contract.scenario.ts', import.meta.url));

function runScenario(command: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
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
      resourceFinalization: [true, true, null, 'REMOVED', null],
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
