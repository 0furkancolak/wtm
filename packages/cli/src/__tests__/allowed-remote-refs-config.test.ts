import { afterEach, describe, expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonEnvelopeSchema, type JsonEnvelope } from '@wtm/protocol';
import type { GitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runCli } from '../main';

/**
 * `wtm.toml`'s `[git] allowed_remote_refs` wired into the production `analyze` and `remove`
 * paths.
 *
 * Every case here names a selector by path, so — as `refresh-remotes.test.ts` notes — no state
 * store is ever opened and these can run in-process under `bun:test` rather than needing the
 * out-of-process `better-sqlite3` scenario harness.
 */
const fixtures: GitSafetyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('[git] allowed_remote_refs', () => {
  test('with no config, a branch pushed to origin is remote-persisted by default', async () => {
    const fixture = await createFixture();

    const envelope = await analyze(fixture, []);

    expect(blockerCodes(envelope)).not.toContain('GIT_HEAD_NOT_REMOTE_PERSISTED');
    expect(envelope.data?.remotePersistence?.allowedRemoteRefs).toEqual(['refs/remotes/origin/*']);
  });

  test('a workspace wtm.toml can restrict analyze to a remote the branch was never pushed to', async () => {
    const fixture = await createFixture();
    await writeWorkspaceConfig(fixture, '[git]\nallowed_remote_refs = ["refs/remotes/upstream/*"]\n');

    const envelope = await analyze(fixture, []);

    expect(blockerCodes(envelope)).toContain('GIT_HEAD_NOT_REMOTE_PERSISTED');
    expect(envelope.data?.remotePersistence?.allowedRemoteRefs).toEqual(['refs/remotes/upstream/*']);
  });

  test('the same restriction makes remove refuse a worktree that would otherwise be removed', async () => {
    const fixture = await createFixture();
    await writeWorkspaceConfig(fixture, '[git]\nallowed_remote_refs = ["refs/remotes/upstream/*"]\n');

    const envelope = await remove(fixture, []);

    expect(envelope.ok).toBe(false);
    expect(envelope.errors.map(({ code }) => code)).toEqual(['GIT_HEAD_NOT_REMOTE_PERSISTED']);
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  });

  test('an explicit origin allowlist keeps removal working, matching the unconfigured default', async () => {
    const fixture = await createFixture();
    await writeWorkspaceConfig(fixture, '[git]\nallowed_remote_refs = ["refs/remotes/origin/*"]\n');

    const envelope = await remove(fixture, []);

    expect(envelope.ok).toBe(true);
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(false);
  });

  test('an invalid allowed_remote_refs pattern fails analyze with a coded config error, not a crash', async () => {
    const fixture = await createFixture();
    await writeWorkspaceConfig(fixture, '[git]\nallowed_remote_refs = ["refs/heads/main"]\n');

    const envelope = await analyze(fixture, []);

    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.errors[0]?.code).toBe('WTM_CONFIG_INVALID');
  });

  test('an invalid allowed_remote_refs pattern fails remove the same way, leaving the worktree intact', async () => {
    const fixture = await createFixture();
    await writeWorkspaceConfig(fixture, '[git]\nallowed_remote_refs = ["refs/remotes/*/oops"]\n');

    const envelope = await remove(fixture, []);

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('WTM_CONFIG_INVALID');
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  });
});

async function writeWorkspaceConfig(fixture: GitSafetyFixture, contents: string): Promise<void> {
  await fixture.write(fixture.root, 'wtm.toml', contents);
}

async function analyze(fixture: GitSafetyFixture, flags: readonly string[]): Promise<JsonEnvelope<any>> {
  return jsonFrom(await runProductionCli(
    ['analyze', fixture.linkedWorktreePath, '--json', ...flags],
    fixture,
  ));
}

async function remove(fixture: GitSafetyFixture, flags: readonly string[]): Promise<JsonEnvelope<any>> {
  return jsonFrom(await runProductionCli(
    ['remove', fixture.linkedWorktreePath, '--json', ...flags],
    fixture,
  ));
}

async function runProductionCli(argv: readonly string[], fixture: GitSafetyFixture) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(argv, {
    cwd: fixture.repoPath,
    // Never created: every selector these tests use is a path, so no state store is opened.
    analysisDatabasePath: join(fixture.root, 'unused-state.db'),
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  return { exitCode, stdout, stderr };
}

function jsonFrom(result: { stdout: string; stderr: string }): JsonEnvelope<any> {
  const envelope = JSON.parse(result.stdout) as unknown;
  jsonEnvelopeSchema.parse(envelope);
  return envelope as JsonEnvelope<any>;
}

function blockerCodes(envelope: JsonEnvelope<any>): string[] {
  return (envelope.data?.safety?.blockers ?? []).map((blocker: { code: string }) => blocker.code);
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
