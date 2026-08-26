import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { runAnalyzeCommand } from '../analyze';

const fixtures: GitSafetyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('runAnalyzeCommand', () => {
  test('returns a valid stable JSON envelope while keeping safety blockers in analysis data', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'keep.txt', 'do not delete\n');

    const envelope = await runAnalyzeCommand({
      repoPath: fixture.repoPath,
      worktreePath: fixture.linkedWorktreePath,
      baseRef: 'refs/heads/main',
    });

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'analyze',
      scope: { mode: 'local' },
      warnings: [],
      errors: [],
      data: {
        identity: { path: fixture.linkedWorktreePath },
        safety: {
          readiness: 'BLOCKED',
          blockers: [{ code: 'GIT_UNTRACKED', severity: 'error' }],
        },
      },
    });
  });

  test('maps typed Git failures to sanitized JSON error evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-analyze-failure-'));
    try {
      const envelope = await runAnalyzeCommand({ repoPath: directory, worktreePath: directory });

      expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command: 'analyze',
        data: null,
        errors: [{
          code: 'GIT_COMMAND_FAILED',
          severity: 'error',
          context: {
            command: 'analyze',
            argv: ['git', '-C', directory, 'worktree', 'list', '--porcelain', '-z'],
            exitCode: 128,
          },
        }],
      });
      expect(JSON.stringify(envelope)).not.toContain('stack');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function createFixture(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}
