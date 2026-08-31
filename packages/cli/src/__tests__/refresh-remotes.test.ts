import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import type { JsonEnvelope } from '@wtm/protocol';
import type { GitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { scenarioTimeoutMs } from '../../../testkit/src/scenario-child';
import { runCli } from '../main';

const fixtures: GitSafetyFixture[] = [];
const fetchCountScenarioPath = fileURLToPath(new URL('./refresh-remotes.scenario.ts', import.meta.url));

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('--refresh-remotes', () => {
  test('documents that the flag reaches the network on both analyze and remove help', async () => {
    for (const argv of [['analyze', '--help'], ['remove', '--help']]) {
      let output = '';
      await runCli(argv, { stdout: (value) => { output += value; }, stderr: () => {} });
      const line = /--refresh-remotes\s{2,}(.+)/.exec(output)?.[1]?.trim();

      expect(line, output).toBeDefined();
      expect(line).toContain('network');
    }
  });

  test('analyze only sees a branch deleted on the remote once the flag refreshes the refs', async () => {
    const fixture = await createFixture();
    // Deleting on the bare remote rather than pushing a deletion is what leaves the local
    // remote-tracking ref behind: this is exactly the stale evidence the flag exists to correct.
    await fixture.git(fixture.remotePath, ['branch', '-D', 'feature/safe']);

    const stale = await analyze(fixture, []);
    const fresh = await analyze(fixture, ['--refresh-remotes']);

    expect(blockerCodes(stale)).not.toContain('GIT_HEAD_NOT_REMOTE_PERSISTED');
    expect(remoteKnowledge(stale)).toMatchObject({ source: 'local-refs', confidence: 'LOCAL_ONLY' });
    expect(blockerCodes(fresh)).toContain('GIT_HEAD_NOT_REMOTE_PERSISTED');
    expect(remoteKnowledge(fresh)).toMatchObject({
      source: 'fetched-refs',
      refreshed: true,
      refreshedAt: expect.any(String),
      confidence: 'REFRESHED',
    });
  });

  test('names the refreshed remotes in human output and keeps the JSON envelope unchanged', async () => {
    const fixture = await createFixture();

    const human = await runProductionCli(['analyze', fixture.linkedWorktreePath, '--refresh-remotes'], fixture);

    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('origin');
    expect(human.stdout.toLowerCase()).toContain('refreshed remote-tracking refs');
    // The envelope is a compatibility contract: the prose lives beside it, never inside it.
    expect(Object.keys(await analyze(fixture, ['--refresh-remotes']))).toEqual(
      Object.keys(await analyze(fixture, [])),
    );
  });

  test('fails the command when the refresh cannot reach the remote, reporting nothing', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.repoPath, ['remote', 'set-url', 'origin', join(fixture.root, 'absent.git')]);

    const envelope = await analyze(fixture, ['--refresh-remotes']);

    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.errors[0]?.code).toBe('GIT_COMMAND_FAILED');
  });

  test('remove blocks a removal that the stale local remote-tracking ref would have allowed', async () => {
    const blocked = await createFixture();
    await blocked.git(blocked.remotePath, ['branch', '-D', 'feature/safe']);
    const allowed = await createFixture();
    await allowed.git(allowed.remotePath, ['branch', '-D', 'feature/safe']);

    const refreshed = await remove(blocked, ['--refresh-remotes']);
    const stale = await remove(allowed, []);

    expect(refreshed.ok).toBe(false);
    expect(refreshed.errors.map(({ code }) => code)).toEqual(['GIT_HEAD_NOT_REMOTE_PERSISTED']);
    expect(await pathExists(blocked.linkedWorktreePath)).toBe(true);
    // The contrast is the assertion: without the flag the same repository loses the worktree.
    expect(stale.ok).toBe(true);
    expect(await pathExists(allowed.linkedWorktreePath)).toBe(false);
  });

  test('fetches once per repository rather than once per worktree', () => {
    const result = spawnSync('node', ['--import', 'tsx', fetchCountScenarioPath], {
      timeout: scenarioTimeoutMs,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({
      repositories: 3,
      worktreesPerRepository: 3,
      globalOk: true,
      globalAnalyses: 9,
      globalFetches: 3,
      allOk: true,
      allAnalyses: 3,
      allFetches: 1,
    });
  });
});

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

function remoteKnowledge(envelope: JsonEnvelope<any>): unknown {
  return envelope.data?.remoteKnowledge;
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
