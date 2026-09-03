import { afterEach, describe, expect, test } from 'bun:test';
import { access, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { listGitWorktrees } from '@wtm/core';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { runRemoveCommand } from '../remove';
import { runScenario } from '../../../../testkit/src/scenario-child';

const fixtures: GitSafetyFixture[] = [];
const malformedScenarioPath = fileURLToPath(new URL('./remove-malformed.scenario.ts', import.meta.url));

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('runRemoveCommand', () => {
  test('removes only an explicit clean linked worktree whose HEAD is pushed', async () => {
    const fixture = await createFixture();

    const envelope = await runRemoveCommand(input(fixture));

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'remove',
      scope: { mode: 'local' },
      warnings: [],
      errors: [],
      data: {
        removed: {
          path: fixture.linkedWorktreePath,
          branchRef: 'refs/heads/feature/safe',
          headOid: fixture.featureHead,
        },
        analysis: { safety: { readiness: 'SAFE' } },
      },
    });
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(false);
    expect((await listGitWorktrees(fixture.repoPath)).map((record) => record.path))
      .not.toContain(fixture.linkedWorktreePath);
  });

  test('blocks staged changes even when a caller supplies an unrecognized force property', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'staged.txt', 'staged\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', 'staged.txt']);

    const envelope = await runRemoveCommand({ ...input(fixture), force: true } as Parameters<typeof runRemoveCommand>[0]);

    expect(errorCodes(envelope)).toEqual(['GIT_DIRTY_STAGED']);
    await expectPreserved(fixture);
  });

  test('blocks unstaged tracked changes and leaves the linked worktree intact', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'feature.txt', 'unstaged\n');

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_DIRTY_UNSTAGED']);
    await expectPreserved(fixture);
  });

  test('blocks untracked files and leaves the linked worktree intact', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'untracked.txt', 'untracked\n');

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_UNTRACKED']);
    await expectPreserved(fixture);
  });

  test('blocks ignored files and preserves their bytes, path, and Git topology', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, '.gitignore', 'ignored.log\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', '.gitignore']);
    await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Ignore local logs']);
    await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
    await fixture.write(fixture.linkedWorktreePath, 'ignored.log', 'must survive removal\n');

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_UNTRACKED']);
    expect(await Bun.file(`${fixture.linkedWorktreePath}/ignored.log`).text()).toBe('must survive removal\n');
    await expectPreserved(fixture);
  });

  test('blocks unresolved paths and leaves the conflicted linked worktree intact', async () => {
    const fixture = await createFixture();
    await createConflict(fixture);

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_UNMERGED']);
    await expectPreserved(fixture);
  });

  test('blocks a dirty submodule and leaves the linked worktree intact', async () => {
    const fixture = await createFixture();
    await createDirtySubmodule(fixture);

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_DIRTY_UNSTAGED']);
    expect(envelope.errors[0]?.context).toMatchObject({ submodulePaths: ['deps/local-submodule'] });
    await expectPreserved(fixture);
  });

  test('blocks a locked worktree and preserves its lock reason', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.repoPath, [
      'worktree', 'lock', '--reason', 'protect fixture', fixture.linkedWorktreePath,
    ]);

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_WORKTREE_LOCKED']);
    expect(envelope.errors[0]?.context).toMatchObject({ reason: 'protect fixture' });
    await expectPreserved(fixture);
  });

  test('blocks the main worktree even when it is selected explicitly', async () => {
    const fixture = await createFixture();

    const envelope = await runRemoveCommand({
      repoPath: fixture.repoPath,
      selector: fixture.repoPath,
      baseRef: 'refs/heads/main',
    });

    expect(errorCodes(envelope)).toEqual(['GIT_MAIN_WORKTREE']);
    expect(await pathExists(fixture.repoPath)).toBe(true);
  });

  test('blocks local-only commits and leaves the linked worktree intact', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.linkedWorktreePath, ['commit', '--allow-empty', '-m', 'Local only']);

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_HEAD_NOT_REMOTE_PERSISTED']);
    await expectPreserved(fixture);
  });

  test('rejects selectors outside discovered topology without touching any worktree', async () => {
    const fixture = await createFixture();

    const envelope = await runRemoveCommand({
      repoPath: fixture.repoPath,
      selector: fixture.root,
      baseRef: 'refs/heads/main',
    });

    expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
      ok: false,
      command: 'remove',
      data: null,
      errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', severity: 'error' }],
    });
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
    expect(await pathExists(fixture.repoPath)).toBe(true);
  });

  test('blocks removal of a discovered prunable worktree whose path is already missing', async () => {
    const fixture = await createFixture();
    await rm(fixture.linkedWorktreePath, { recursive: true, force: true });

    const envelope = await runRemoveCommand(input(fixture));

    expect(errorCodes(envelope)).toEqual(['GIT_REPOSITORY_DEGRADED']);
    expect(envelope.errors[0]?.context).toMatchObject({
      worktreePath: fixture.linkedWorktreePath,
      pathExists: false,
      prunableReason: expect.any(String),
    });
    expect((await listGitWorktrees(fixture.repoPath)).map((record) => record.path))
      .toContain(fixture.linkedWorktreePath);
  });

  test('maps malformed porcelain to degraded JSON and preserves the worktree', () => {
    const result = runScenario('node', ['--import', 'tsx', malformedScenarioPath]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const scenario = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(jsonEnvelopeSchema.parse(scenario.envelope)).toMatchObject({
      ok: false,
      command: 'remove',
      data: null,
      errors: [{
        code: 'GIT_REPOSITORY_DEGRADED',
        context: { reason: 'missing-fields', command: 'remove' },
      }],
    });
    expect(scenario).toMatchObject({ pathExists: true, topologyContains: true });
  });
});

function input(fixture: GitSafetyFixture) {
  return {
    repoPath: fixture.repoPath,
    selector: fixture.linkedWorktreePath,
    baseRef: 'refs/heads/main',
  };
}

async function createFixture(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}

async function createConflict(fixture: GitSafetyFixture): Promise<void> {
  await fixture.write(fixture.repoPath, 'README.md', 'main side\n');
  await fixture.git(fixture.repoPath, ['add', 'README.md']);
  await fixture.git(fixture.repoPath, ['commit', '-m', 'Change main side']);
  await fixture.git(fixture.repoPath, ['push', 'origin', 'main']);
  await fixture.write(fixture.linkedWorktreePath, 'README.md', 'feature side\n');
  await fixture.git(fixture.linkedWorktreePath, ['add', 'README.md']);
  await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Change feature side']);
  await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
  await fixture.git(fixture.linkedWorktreePath, ['merge', 'main'], [1]);
}

async function createDirtySubmodule(fixture: GitSafetyFixture): Promise<void> {
  const sourcePath = `${fixture.root}/submodule-source`;
  await fixture.write(sourcePath, 'README.md', 'submodule source\n');
  await fixture.git(sourcePath, ['init', '--initial-branch=main']);
  await fixture.git(sourcePath, ['config', 'user.name', 'WTM Test']);
  await fixture.git(sourcePath, ['config', 'user.email', 'wtm-test@example.invalid']);
  await fixture.git(sourcePath, ['add', 'README.md']);
  await fixture.git(sourcePath, ['commit', '-m', 'Initialize local submodule']);
  await fixture.git(fixture.linkedWorktreePath, [
    '-c', 'protocol.file.allow=always', 'submodule', 'add', sourcePath, 'deps/local-submodule',
  ]);
  await fixture.git(fixture.linkedWorktreePath, ['commit', '-am', 'Add local submodule']);
  await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
  await fixture.write(
    fixture.linkedWorktreePath,
    'deps/local-submodule/README.md',
    'dirty submodule checkout\n',
  );
}

async function expectPreserved(fixture: GitSafetyFixture): Promise<void> {
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  expect((await listGitWorktrees(fixture.repoPath)).map((record) => record.path))
    .toContain(fixture.linkedWorktreePath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errorCodes(envelope: Awaited<ReturnType<typeof runRemoveCommand>>): string[] {
  expect(jsonEnvelopeSchema.parse(envelope)).toMatchObject({
    schemaVersion: 1,
    ok: false,
    command: 'remove',
    scope: { mode: 'local' },
    data: null,
  });
  return envelope.errors.map((error) => error.code);
}
