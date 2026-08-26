import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jsonEnvelopeSchema } from '@wtm/protocol';

const scenarioPath = fileURLToPath(new URL('./init.scenario.ts', import.meta.url));

describe('runInitCommand', () => {
  test('returns the protocol envelope with the same initialized core result', () => {
    const scenario = runScenario('success');
    const envelope = scenario.envelope as Record<string, unknown>;

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'init',
      scope: { mode: 'local' },
      warnings: [],
      errors: [],
    });
    expect(envelope.data).toMatchObject({
      workspace: { scope: 'local' },
      repositories: [{}, {}],
      discovery: { repositories: [{}, {}] },
    });
    expect((envelope.scope as { workspaceId: string }).workspaceId).toBe(
      (envelope.data as { workspace: { id: string } }).workspace.id,
    );
    expect(scenario.stableWorktreeIdsAfterReopen).toBe(true);
    expect(scenario.reopenedDiscoveredWorktrees).toBe(0);
    expect(scenario.reopenedUpdatedWorktrees).toBe(3);
  });

  test('returns a non-empty stable error envelope on failure', () => {
    const envelope = runScenario('failure');

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'init',
      scope: { mode: 'local' },
      data: null,
      warnings: [],
      errors: [{
        code: 'WTM_CONFIG_INVALID',
        message: 'Discovery maxDepth must be a non-negative integer',
        severity: 'error',
        context: { command: 'init' },
      }],
    });
  });

  test('classifies typed Git failures and exposes only sanitized command evidence', () => {
    const envelope = runScenario('git-failure');

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: 'init',
      errors: [{
        code: 'GIT_COMMAND_FAILED',
        severity: 'error',
        context: {
          command: 'init',
          exitCode: 7,
          argv: ['git', '-C', expect.any(String), 'worktree', 'list', '--porcelain', '-z'],
          stderr: 'fatal: https://***@example.invalid/private',
        },
      }],
    });
    expect(JSON.stringify(envelope)).not.toContain('super-secret');
  });

  test('preserves structured core error context in the JSON error item', () => {
    const envelope = runScenario('config-context');

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      ok: false,
      errors: [{
        code: 'WTM_CONFIG_INVALID',
        context: {
          command: 'init',
          source: expect.stringContaining('/wtm.toml'),
          issues: expect.any(Array),
        },
      }],
    });
  });

  test('omits environment secrets and user-authored values from update-required JSON', () => {
    const envelope = runScenario('update-required-secret');

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      ok: false,
      errors: [{
        code: 'WTM_CONFIG_INVALID',
        context: {
          command: 'init',
          conflict: 'update-required',
          requiredChanges: [{ path: 'version', value: 1 }],
          action: 'Apply the listed requiredChanges to the existing file, then rerun wtm init.',
        },
      }],
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('cli-environment-secret');
    expect(serialized).not.toContain('cli-user-authored-name');
    expect(serialized).not.toContain('proposedConfig');
  });

  test('returns secret-safe JSON for malformed secret-bearing TOML', () => {
    const envelope = runScenario('malformed-secret');

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      ok: false,
      errors: [{
        code: 'WTM_CONFIG_INVALID',
        message: 'WTM configuration contains invalid TOML syntax.',
        context: {
          command: 'init',
          source: expect.stringContaining('/wtm.toml'),
          category: 'toml-syntax',
          action: 'Correct the TOML syntax in the source file, then rerun wtm init.',
        },
      }],
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('cli-unterminated-secret-token-value');
    expect(serialized).not.toContain('API_TOKEN');
    expect(serialized).not.toContain('API_TOKEN = ');
    expect(serialized).not.toContain('Invalid TOML document');
    expect(serialized).not.toContain('codeblock');
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('stack');
  });
});

function runScenario(name: string): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], { encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
