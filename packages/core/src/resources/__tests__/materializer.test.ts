import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createResourceGuard, type ResourceGuard } from '../guard';
import {
  ResourceMaterializationError,
  applyMaterializationPlan,
  buildMaterializationPlan,
  planResourceMaterialization,
  type CloneFileCapability,
  type MaterializationHooks,
} from '../materializer';
import { createFakeFileTrust } from './file-trust-fixture';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-materializer-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const sandboxRoot = join(workspaceRoot, '.resources');
  const sourceRoot = join(root, 'sources');
  await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
  await mkdir(sourceRoot, { mode: 0o700 });
  await chmod(workspaceRoot, 0o700);
  const fileTrust = createFakeFileTrust();
  const guard = await createResourceGuard({
    sandboxRoot,
    workspaceRoot,
    repositoryRoots: [workspaceRoot],
    git: { async isTracked() { return false; } },
    fileTrust,
  });
  return { root, workspaceRoot, sandboxRoot, sourceRoot, guard, fileTrust };
}

describe('resource materializer', () => {
  test('builds a pure deterministic plan and rejects mutable symlinks', () => {
    const request = {
      policy: 'copy' as const,
      sourcePath: '/safe/source',
      targetPath: '/safe/target',
      mutable: true,
    };
    expect(buildMaterializationPlan(request)).toEqual(buildMaterializationPlan(request));
    expect(() => buildMaterializationPlan({
      policy: 'symlink',
      sourcePath: '/safe/source',
      targetPath: '/safe/target',
      immutable: false,
      allowedSourceRoots: ['/safe'],
    })).toThrow(ResourceMaterializationError);
  });

  test('classifies shared/native/external/ignore as non-owned and ephemeral as isolated', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    for (const policy of ['shared', 'native-cache', 'external', 'ignore'] as const) {
      const plan = await planResourceMaterialization({ policy, targetPath: join(sandboxRoot, policy) }, guard);
      expect(plan.ownership).toBe('external');
      expect((await applyMaterializationPlan(plan, { guard, fileTrust })).method).toBe('not-owned');
      expect(await lstat(join(sandboxRoot, policy)).catch(() => null)).toBeNull();
    }
    const ephemeral = await planResourceMaterialization({ policy: 'ephemeral', targetPath: join(sandboxRoot, 'ephemeral') }, guard);
    expect(ephemeral.ownership).toBe('wtm');
    expect((await applyMaterializationPlan(ephemeral, { guard, fileTrust })).method).toBe('directory');
  });

  test('materializes generated, isolated, copied, and explicitly allowed immutable symlink policies', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourceFile = join(sourceRoot, 'seed.txt');
    const sourceTree = join(sourceRoot, 'tree');
    await writeFile(sourceFile, 'seed', { mode: 0o666 });
    await mkdir(sourceTree, { mode: 0o777 });
    await writeFile(join(sourceTree, 'nested.txt'), 'nested', { mode: 0o666 });

    const plans = await Promise.all([
      planResourceMaterialization({
        policy: 'generated', targetPath: join(sandboxRoot, 'generated'), contents: 'value', mode: 0o666,
      }, guard),
      planResourceMaterialization({ policy: 'isolated', targetPath: join(sandboxRoot, 'isolated') }, guard),
      planResourceMaterialization({ policy: 'copy', targetPath: join(sandboxRoot, 'copied'), sourcePath: sourceTree }, guard),
      planResourceMaterialization({
        policy: 'symlink', targetPath: join(sandboxRoot, 'linked'), sourcePath: sourceFile,
        immutable: true, allowedSourceRoots: [sourceRoot],
      }, guard),
    ]);
    for (const plan of plans) await applyMaterializationPlan(plan, { guard, fileTrust });

    expect(await readFile(join(sandboxRoot, 'generated'), 'utf8')).toBe('value');
    expect((await lstat(join(sandboxRoot, 'isolated'))).isDirectory()).toBe(true);
    expect(await readFile(join(sandboxRoot, 'copied', 'nested.txt'), 'utf8')).toBe('nested');
    expect((await lstat(join(sandboxRoot, 'copied', 'nested.txt'))).mode & 0o077).toBe(0);
    expect((await lstat(join(sandboxRoot, 'copied'))).mode & 0o077).toBe(0);
    expect((await lstat(join(sandboxRoot, 'generated'))).mode & 0o077).toBe(0);
    expect((await lstat(join(sandboxRoot, 'linked'))).isSymbolicLink()).toBe(true);
  });

  test('re-resolves an immutable symlink source inside its allowlist at the final boundary', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot, root } = await fixture();
    const sourcePath = join(sourceRoot, 'source');
    await writeFile(sourcePath, 'safe');
    const plan = await planResourceMaterialization({
      policy: 'symlink', targetPath: join(sandboxRoot, 'link'), sourcePath,
      immutable: true, allowedSourceRoots: [sourceRoot],
    }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: {
        async beforePublish() {
          await rm(sourcePath);
          await symlink(join(root, 'outside'), sourcePath);
        },
      },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
  });

  test('never overwrites a concurrent publication winner', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const targetPath = join(sandboxRoot, 'winner.txt');
    const plan = await planResourceMaterialization({
      policy: 'generated', targetPath, contents: 'ours',
    }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: { async beforePublish() { await writeFile(targetPath, 'winner', { flag: 'wx' }); } },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(targetPath, 'utf8')).toBe('winner');
  });

  test('revalidates the parent and source identity immediately before publication', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourcePath = join(sourceRoot, 'source');
    const targetParent = join(sandboxRoot, 'parent');
    await writeFile(sourcePath, 'original');
    await mkdir(targetParent, { mode: 0o700 });
    const plan = await planResourceMaterialization({ policy: 'copy', sourcePath, targetPath: join(targetParent, 'copy') }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: {
        async beforePublish() {
          await rm(sourcePath);
          await writeFile(sourcePath, 'replacement');
        },
      },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
  });

  test('rejects nested source content changed immediately before publication', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourceTree = join(sourceRoot, 'mutable-tree');
    const nested = join(sourceTree, 'nested.txt');
    const target = join(sandboxRoot, 'copy-manifest');
    await mkdir(sourceTree);
    await writeFile(nested, 'original');
    const plan = await planResourceMaterialization({ policy: 'copy', sourcePath: sourceTree, targetPath: target }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: { async beforePublish() { await writeFile(nested, 'mutated!'); } },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await lstat(target).catch(() => null)).toBeNull();
  });

  test('rejects nested source content changed during bounded copy traversal', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourceTree = join(sourceRoot, 'copy-race');
    const first = join(sourceTree, 'a.txt');
    const second = join(sourceTree, 'b.txt');
    const target = join(sandboxRoot, 'copy-race-target');
    await mkdir(sourceTree);
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    const plan = await planResourceMaterialization({ policy: 'copy', sourcePath: sourceTree, targetPath: target }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: {
        async duringCopy(path: string) {
          if (basename(path) === basename(first)) await writeFile(second, 'raced!');
        },
      } as MaterializationHooks & { duringCopy(path: string): Promise<void> },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await lstat(target).catch(() => null)).toBeNull();
  });

  test('rejects a same-size source mutation introduced by the final guard await after earlier validation', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourceTree = join(sourceRoot, 'source-last');
    const sourceFile = join(sourceTree, 'first.txt');
    const target = join(sandboxRoot, 'source-last-target');
    await mkdir(sourceTree);
    await writeFile(sourceFile, 'AAAA');
    const plan = await planResourceMaterialization({ policy: 'copy', sourcePath: sourceTree, targetPath: target }, guard);
    let targetRevalidations = 0;
    const mutatingGuard: ResourceGuard = {
      ...guard,
      async revalidate(authorization) {
        if (authorization.path === plan.targetPath && ++targetRevalidations === 2) await writeFile(sourceFile, 'BBBB');
        return guard.revalidate(authorization);
      },
    };
    await expect(applyMaterializationPlan(plan, { guard: mutatingGuard, fileTrust }))
      .rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await lstat(target).catch(() => null)).toBeNull();
  });

  test('fails closed before staging when a retained source snapshot would exceed its descriptor bound', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourceTree = join(sourceRoot, 'descriptor-bound');
    await mkdir(sourceTree);
    for (let index = 0; index < 257; index += 1) {
      await writeFile(join(sourceTree, `${String(index).padStart(3, '0')}.txt`), 'x');
    }
    const plan = await planResourceMaterialization({
      policy: 'copy', sourcePath: sourceTree, targetPath: join(sandboxRoot, 'descriptor-target'),
    }, guard);
    await expect(applyMaterializationPlan(plan, { guard, fileTrust })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect((await readdir(sandboxRoot)).some((name) => name.startsWith(`.wtm-stage-${plan.recoveryKey}-`))).toBe(false);
  });

  test('detects a timer mutation of an already-copied file while traversing later siblings', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourceTree = join(sourceRoot, 'timer-race');
    const first = join(sourceTree, '000.txt');
    await mkdir(sourceTree);
    await writeFile(first, 'AAAA');
    for (let index = 1; index < 64; index += 1) {
      await writeFile(join(sourceTree, `${String(index).padStart(3, '0')}.txt`), 'unchanged');
    }
    const target = join(sandboxRoot, 'timer-race-target');
    const plan = await planResourceMaterialization({ policy: 'copy', sourcePath: sourceTree, targetPath: target }, guard);
    let scheduled = false;
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: {
        async duringCopy(path) {
          if (basename(path) !== '000.txt' || scheduled) return;
          scheduled = true;
          await new Promise<void>((resolveTimer) => setTimeout(resolveTimer, 0));
          await writeFile(first, 'BBBB');
        },
      },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await lstat(target).catch(() => null)).toBeNull();
  });

  test('falls back from documented unsupported clone errors but fails closed on real clone errors', async () => {
    const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
    const sourcePath = join(sourceRoot, 'database');
    await writeFile(sourcePath, 'database');
    const unsupported: CloneFileCapability = {
      async cloneFile() { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); },
    };
    const fallback = await planResourceMaterialization({
      policy: 'clone', sourcePath, targetPath: join(sandboxRoot, 'fallback'),
    }, guard);
    expect((await applyMaterializationPlan(fallback, { guard, fileTrust, clone: unsupported })).method).toBe('copy-fallback');
    expect(await readFile(join(sandboxRoot, 'fallback'), 'utf8')).toBe('database');

    const denied: CloneFileCapability = {
      async cloneFile() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    };
    const failed = await planResourceMaterialization({
      policy: 'clone', sourcePath, targetPath: join(sandboxRoot, 'failed'),
    }, guard);
    await expect(applyMaterializationPlan(failed, { guard, fileTrust, clone: denied })).rejects.toMatchObject({
      code: 'RESOURCE_CLONE_UNAVAILABLE',
    });
  });

  test('reconciles only an exact intent-owned failed stage before retry and preserves unrelated artifacts', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'retry-generated');
    const foreign = join(sandboxRoot, '.wtm-stage-foreign');
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, 'keep'), 'foreign');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'value' }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust, hooks: { async beforePublish() { throw new Error('crash before publish'); } },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect((await readdir(sandboxRoot)).filter((entry) => entry.startsWith('.wtm-stage-')).length).toBe(2);
    await applyMaterializationPlan(plan, { guard, fileTrust });
    expect(await readFile(target, 'utf8')).toBe('value');
    expect(await readFile(join(foreign, 'keep'), 'utf8')).toBe('foreign');
    expect((await readdir(sandboxRoot)).filter((entry) => entry.startsWith('.wtm-stage-'))).toEqual(['.wtm-stage-foreign']);
  });

  test('recovers an exact published stage after a finalize crash without overwriting the target', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'published-crash');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'owned' }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: { async afterPublish() { throw new Error('crash after publish'); } } as MaterializationHooks & {
        afterPublish(): Promise<void>;
      },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(target, 'utf8')).toBe('owned');
    const recovered = await applyMaterializationPlan(plan, { guard, fileTrust });
    expect(recovered.method).toBe('generated');
    expect(await readFile(target, 'utf8')).toBe('owned');
    expect((await readdir(sandboxRoot)).some((entry) => entry.startsWith('.wtm-stage-'))).toBe(false);
  });

  test('completes exact publishing evidence after a crash before published evidence and retries recovery crashes', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'publishing-crash');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'owned' }, guard);
    const crashBeforeEvidence = {
      async afterPublishBeforeEvidence() { throw new Error('crash before published evidence'); },
    } as MaterializationHooks & { afterPublishBeforeEvidence(): Promise<void> };
    await expect(applyMaterializationPlan(plan, { guard, fileTrust, hooks: crashBeforeEvidence }))
      .rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(target, 'utf8')).toBe('owned');
    const recoveryCrash = {
      async afterRecoveryEvidence() { throw new Error('crash during recovery finalization'); },
    } as MaterializationHooks & { afterRecoveryEvidence(): Promise<void> };
    await expect(applyMaterializationPlan(plan, { guard, fileTrust, hooks: recoveryCrash })).rejects.toThrow('recovery finalization');
    const recovered = await applyMaterializationPlan(plan, { guard, fileTrust });
    expect(recovered.method).toBe('generated');
    expect((await readdir(sandboxRoot)).some((entry) => entry.startsWith('.wtm-stage-'))).toBe(false);
  });

  test('preserves a same-content foreign target when recovering publishing-only evidence', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'publishing-foreign');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'same' }, guard);
    const hooks = {
      async afterPublishBeforeEvidence() { throw new Error('crash before published evidence'); },
    } as MaterializationHooks & { afterPublishBeforeEvidence(): Promise<void> };
    await expect(applyMaterializationPlan(plan, { guard, fileTrust, hooks })).rejects.toBeInstanceOf(ResourceMaterializationError);
    await rm(target);
    await writeFile(target, 'same');
    await expect(applyMaterializationPlan(plan, { guard, fileTrust })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(target, 'utf8')).toBe('same');
  });

  test('never adopts bytes written to the published inode before final evidence', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'published-inode-mutation');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'owned' }, guard);
    await expect(applyMaterializationPlan(plan, {
      guard, fileTrust,
      hooks: { async afterPublishBeforeEvidence() { await writeFile(target, 'other'); } },
    })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(target, 'utf8')).toBe('other');
    await expect(applyMaterializationPlan(plan, { guard, fileTrust })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(target, 'utf8')).toBe('other');
  });

  test.each(['symlink', 'oversized'] as const)(
    'fails closed on an exact %s intent artifact while ignoring unrelated stages',
    async (artifact) => {
      const { guard, fileTrust, sandboxRoot, root } = await fixture();
      const target = join(sandboxRoot, `intent-${artifact}`);
      for (let index = 0; index < 80; index += 1) {
        await mkdir(join(sandboxRoot, `.wtm-stage-unrelated-${index}`), { mode: 0o700 });
      }
      const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'owned' }, guard);
      await expect(applyMaterializationPlan(plan, {
        guard, fileTrust, hooks: { async beforePublish() { throw new Error('leave exact stage'); } },
      })).rejects.toBeInstanceOf(ResourceMaterializationError);
      const exactStage = (await readdir(sandboxRoot)).find((name) => name.startsWith('.wtm-stage-')
        && !name.startsWith('.wtm-stage-unrelated-')) as string;
      const intent = join(sandboxRoot, exactStage, 'intent.json');
      await rm(intent);
      if (artifact === 'symlink') await symlink(join(root, 'foreign-intent'), intent);
      else await writeFile(intent, 'x'.repeat(70_000));
      await expect(applyMaterializationPlan(plan, { guard, fileTrust })).rejects.toBeInstanceOf(ResourceMaterializationError);
      expect(await lstat(target).catch(() => null)).toBeNull();
      expect((await readdir(sandboxRoot)).filter((name) => name.startsWith('.wtm-stage-unrelated-')).length).toBe(80);
    },
  );

  test('bounds recovery inventory work while preserving unrelated stage-like artifacts', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'bounded-inventory-target');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'owned' }, guard);
    for (let index = 0; index < 129; index += 1) {
      await writeFile(join(sandboxRoot, `.wtm-stage-unrelated-${String(index).padStart(3, '0')}`), 'keep');
    }
    await expect(applyMaterializationPlan(plan, { guard, fileTrust })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(join(sandboxRoot, '.wtm-stage-unrelated-128'), 'utf8')).toBe('keep');
    expect(await lstat(target).catch(() => null)).toBeNull();
  });

  test('retains durable cleanup evidence through every recursive failed-stage cleanup prefix', async () => {
    for (const crashAt of [1, 2, 3, 4, 5, 6]) {
      const { guard, fileTrust, sandboxRoot, sourceRoot } = await fixture();
      const source = join(sourceRoot, `cleanup-source-${crashAt}`);
      await mkdir(join(source, 'nested'), { recursive: true });
      await writeFile(join(source, 'a.txt'), 'a');
      await writeFile(join(source, 'nested', 'b.txt'), 'b');
      const target = join(sandboxRoot, `cleanup-target-${crashAt}`);
      const plan = await planResourceMaterialization({ policy: 'copy', sourcePath: source, targetPath: target }, guard);
      await expect(applyMaterializationPlan(plan, {
        guard, fileTrust, hooks: { async beforePublish() { throw new Error('leave failed stage'); } },
      })).rejects.toBeInstanceOf(ResourceMaterializationError);
      let mutations = 0;
      const cleanupCrash = {
        async duringStageCleanup() {
          if (++mutations === crashAt) throw new Error(`cleanup crash ${crashAt}`);
        },
      } as MaterializationHooks & { duringStageCleanup(): Promise<void> };
      await expect(applyMaterializationPlan(plan, { guard, fileTrust, hooks: cleanupCrash }))
        .rejects.toThrow(`cleanup crash ${crashAt}`);
      expect((await readdir(sandboxRoot)).some((name) => name.startsWith(`.wtm-cleanup-${plan.recoveryKey}-`))).toBe(true);
      const recovered = await applyMaterializationPlan(plan, { guard, fileTrust });
      expect(recovered.method).toBe('copy');
      expect(await readFile(join(target, 'nested', 'b.txt'), 'utf8')).toBe('b');
      expect((await readdir(sandboxRoot)).some((name) => name.startsWith('.wtm-cleanup-'))).toBe(false);
    }
  });

  test('recovers after exact stage removal but before cleanup evidence removal', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'post-stage-cleanup-crash');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'owned' }, guard);
    const hooks = {
      async afterStageRemovedBeforeCleanupEvidence() { throw new Error('crash after exact stage rmdir'); },
    } as MaterializationHooks & { afterStageRemovedBeforeCleanupEvidence(): Promise<void> };
    await expect(applyMaterializationPlan(plan, { guard, fileTrust, hooks })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect((await readdir(sandboxRoot)).some((name) => name.startsWith('.wtm-stage-'))).toBe(false);
    expect((await readdir(sandboxRoot)).some((name) => name.startsWith(`.wtm-cleanup-${plan.recoveryKey}-`))).toBe(true);
    expect((await applyMaterializationPlan(plan, { guard, fileTrust })).method).toBe('generated');
    expect(await readFile(target, 'utf8')).toBe('owned');
  });

  test('preserves a foreign stage swapped at the final cleanup rmdir boundary', async () => {
    const { guard, fileTrust, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'cleanup-stage-swap');
    const plan = await planResourceMaterialization({ policy: 'generated', targetPath: target, contents: 'owned' }, guard);
    let foreignStage = '';
    const hooks = {
      async beforeStageCleanupRmdir(stagePath: string) {
        const owned = `${stagePath}-owned`;
        await rename(stagePath, owned);
        await mkdir(stagePath, { mode: 0o700 });
        await writeFile(join(stagePath, 'keep'), 'foreign');
        foreignStage = stagePath;
      },
    } as MaterializationHooks & { beforeStageCleanupRmdir(stagePath: string): Promise<void> };
    await expect(applyMaterializationPlan(plan, { guard, fileTrust, hooks })).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect(await readFile(join(foreignStage, 'keep'), 'utf8')).toBe('foreign');
  });

  test('rejects recursive symlink traversal before creating staging evidence', async () => {
    const { guard, sandboxRoot, sourceRoot } = await fixture();
    const tree = join(sourceRoot, 'cycle');
    await mkdir(tree);
    await symlink(tree, join(tree, 'again'));
    await expect(planResourceMaterialization({
      policy: 'copy', sourcePath: tree, targetPath: join(sandboxRoot, 'copy'),
    }, guard)).rejects.toBeInstanceOf(ResourceMaterializationError);
    expect((await readdir(sandboxRoot)).some((entry) => entry.startsWith('.wtm-stage-'))).toBe(false);
    expect(await lstat(tree)).toBeDefined();
  });
});
