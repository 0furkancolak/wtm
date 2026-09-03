import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { buildGcPlan, createResourceGuard, type GcEvidence, type ResourceSandboxIdentity } from '@wtm/core';
import { runDiskCommand } from '../disk';
import { runGcCommand } from '../gc';
import { runCli } from '../../main';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const roots: string[] = [];
const productionScenario = fileURLToPath(new URL('./resource-cli.scenario.ts', import.meta.url));
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-cli-gc-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const sandboxRoot = join(workspaceRoot, '.resources');
  await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
  await chmod(workspaceRoot, 0o700);
  const stat = await lstat(sandboxRoot);
  const sandbox: ResourceSandboxIdentity = {
    id: 'sandbox', root: sandboxRoot, generation: 'generation', dev: stat.dev, ino: stat.ino, uid: stat.uid,
  };
  const guard = await createResourceGuard({
    sandboxRoot, workspaceRoot, repositoryRoots: [workspaceRoot],
    git: { async isTracked() { return false; } },
  });
  const target = join(sandboxRoot, 'stale');
  await writeFile(target, '1234');
  const targetStat = await lstat(target);
  const record: GcEvidence = {
    storageObjectId: 'object', path: target, sandboxId: sandbox.id, sandboxRoot: sandbox.root,
    sandboxGeneration: sandbox.generation, dev: targetStat.dev, ino: targetStat.ino, uid: targetStat.uid,
    kind: 'file', state: 'STALE', retention: 'ephemeral', referenceCount: 0, owned: true,
    lastUsedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 4, allocatedBytes: targetStat.blocks * 512,
  };
  return { target, sandbox, guard, record };
}

describe('disk and gc commands', () => {
  test('reports logical and allocated totals split into owned and unknown records', async () => {
    const { sandbox, record } = await fixture();
    const envelope = await runDiskCommand({
      sandbox,
      records: [
        record,
        { ...record, storageObjectId: 'unknown', path: `${sandbox.root}/unknown`, owned: false, logicalBytes: 9, allocatedBytes: 4096 },
        { ...record, storageObjectId: 'removed', path: `${sandbox.root}/removed`, state: 'REMOVED', logicalBytes: 99 },
      ],
    });
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).toMatchObject({
      ok: true,
      command: 'disk',
      data: {
        totals: { logicalBytes: 13, allocatedBytes: record.allocatedBytes + 4096 },
        owned: { objects: 1, logicalBytes: 4 },
        unknown: { objects: 1, logicalBytes: 9 },
      },
    });
  });

  test('counts worktree-local resources, which no sandbox record ever describes', async () => {
    const { sandbox, record } = await fixture();

    const envelope = await runDiskCommand({
      sandbox,
      records: [record],
      worktree: { objects: 2, logicalBytes: 40, allocatedBytes: 8192 },
    });

    expect(envelope.data).toMatchObject({
      totals: { logicalBytes: 44, allocatedBytes: record.allocatedBytes + 8192 },
      owned: { objects: 1, logicalBytes: 4 },
      worktree: { objects: 2, logicalBytes: 40, allocatedBytes: 8192 },
    });
  });

  test('reports no worktree-local usage as zero rather than leaving it out', async () => {
    const { sandbox, record } = await fixture();

    const envelope = await runDiskCommand({ sandbox, records: [record] });

    expect(envelope.data?.worktree).toEqual({ objects: 0, logicalBytes: 0, allocatedBytes: 0 });
  });

  test('gc command is dry-run by default and returns structured apply failures', async () => {
    const { sandbox, guard, record, target } = await fixture();
    const plan = buildGcPlan({ sandbox, records: [record], now: '2026-08-28T00:00:00.000Z' });
    const dry = await runGcCommand({ plan, guard });
    expect(jsonEnvelopeSchema.parse(dry)).toEqual(dry);
    expect(dry).toMatchObject({ ok: true, command: 'gc', data: { mode: 'dry-run' } });
    expect(await readFile(target, 'utf8')).toBe('1234');

    const applied = await runGcCommand({ plan, guard, apply: true });
    expect(applied).toMatchObject({ ok: false, data: { mode: 'apply' } });
    expect(applied.errors[0]?.code).toBe('RESOURCE_CLEANUP_FAILED');
    expect(await readFile(target, 'utf8')).toBe('1234');
  });

  test('registers strict disk/gc CLI commands and requires explicit --apply', async () => {
    const invocations: Array<{ command: string; apply?: boolean }> = [];
    const run = async (argv: string[]) => {
      let stdout = '';
      const code = await runCli(argv, {
        stdout(value) { stdout += value; }, stderr() {},
        diskRunner: async () => {
          invocations.push({ command: 'disk' });
          return { schemaVersion: 1, ok: true, command: 'disk', data: {}, warnings: [], errors: [] };
        },
        gcRunner: async ({ apply }) => {
          invocations.push({ command: 'gc', apply });
          return { schemaVersion: 1, ok: true, command: 'gc', data: {}, warnings: [], errors: [] };
        },
      });
      return { code, stdout };
    };
    expect((await run(['disk', '--json'])).code).toBe(0);
    expect((await run(['gc', '--json'])).code).toBe(0);
    expect((await run(['gc', '--apply', '--json'])).code).toBe(0);
    expect(invocations).toEqual([
      { command: 'disk' }, { command: 'gc', apply: false }, { command: 'gc', apply: true },
    ]);
    expect((await run(['gc', 'unexpected', '--json'])).code).toBe(2);
  });

  test('wires production disk and gc to SQLite state with dry-run default and explicit apply', () => {
    const result = runScenario('node', ['--import', 'tsx', productionScenario]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      diskOk: true,
      diskOwned: 4,
      parentDiskOwned: 0,
      parentGcPlanned: 0,
      siblingsSurvivedParentApply: true,
      nestedDiskOwned: 1,
      dryOk: true,
      dryMode: 'dry-run',
      survivedDryRun: true,
      readOnlyStateUnchanged: true,
      recoveredCrashQuarantine: true,
      recoveredPreparedTargets: true,
      recoveredPreparedContainers: true,
      preparedPhases: ['finalized', 'finalized'],
      unrelatedSurvivedApply: true,
      nestedSurvivedOuterApply: true,
      applyOk: true,
      applyMode: 'apply',
      survivedApply: false,
    });
  });
});
