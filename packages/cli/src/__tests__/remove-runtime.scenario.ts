/**
 * The runtime-aware `wtm remove` lifecycle, exercised through the production CLI.
 *
 * These cases would read more naturally as `bun:test` cases, and they cannot be: the production
 * removal path opens a real `SQLiteStateStore`, whose `better-sqlite3` driver aborts the Bun
 * runtime outright (`NAPI FATAL ERROR`). Every existing store-backed CLI test is out of process
 * for the same reason, so these follow that convention rather than inventing a second one.
 *
 * Each case is selected by name so one Node start can be spent on one behaviour and the failure
 * message names it.
 */
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listGitWorktrees, SQLiteStateStore } from '@wtm/core';
// A subpath, not the barrel: `defaultCoreFileTrustPolicy` is deliberately not part of `@wtm/core`'s
// main surface. See its own doc comment for why.
import { defaultCoreFileTrustPolicy } from '@wtm/core/file-trust-policy';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import type { JsonEnvelope } from '@wtm/protocol';
import type { RuntimeDaemonClient } from '../commands/runtime-client';
import type { GitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createProductionRemovalCoordinator } from '../removal-coordinator';
import { runCli } from '../main';

interface Prepared {
  fixture: GitSafetyFixture;
  databasePath: string;
  globalConfigPath: string;
  store: SQLiteStateStore;
  repositoryId: string;
  worktreeId: string;
}

const fixtures: GitSafetyFixture[] = [];
const stores: SQLiteStateStore[] = [];

/** A daemon that is not there: exactly what `DaemonClient.request` does with no socket. */
function unreachableDaemon(asked: string[]): RuntimeDaemonClient {
  return {
    request: async (command: string) => {
      asked.push(command);
      throw new Error('Daemon client is not connected');
    },
  };
}

/**
 * A daemon that answers every command with success and changes nothing. This is the shape of a
 * durable-cleanup-ownership failure: the response looks finished and the record disagrees.
 */
function lyingDaemon(asked: string[]): RuntimeDaemonClient {
  return {
    request: async (command: string) => {
      asked.push(command);
      return {
        schemaVersion: 1,
        ok: true,
        command,
        data: { processes: [{ id: 'p1', taskName: 'dev' }] },
        warnings: [],
        errors: [],
      } satisfies JsonEnvelope<unknown>;
    },
  };
}

async function prepare(options: { workspaceConfig?: string } = {}): Promise<Prepared> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  if (options.workspaceConfig !== undefined) {
    await writeFile(join(fixture.root, 'wtm.toml'), options.workspaceConfig);
  }
  const databasePath = join(fixture.root, 'state.db');
  const store = new SQLiteStateStore(databasePath);
  stores.push(store);
  const workspace = store.upsertWorkspace({
    name: 'removal', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const repository = store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: join(fixture.repoPath, '.git'),
    mainRoot: fixture.repoPath,
    remoteIdentity: null,
  });
  store.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.repoPath));
  const worktree = store.listWorktrees(repository.id)
    .find(({ path }) => path === fixture.linkedWorktreePath);
  if (worktree === undefined) throw new Error('the fixture worktree was not registered');
  return {
    fixture,
    databasePath,
    globalConfigPath: join(fixture.root, 'absent-global.toml'),
    store,
    repositoryId: repository.id,
    worktreeId: worktree.id,
  };
}

function startRunningProcess(prepared: Prepared): string {
  const now = new Date().toISOString();
  return prepared.store.createManagedProcess({
    worktreeId: prepared.worktreeId,
    taskName: 'dev',
    pid: 999_999,
    pgid: 999_999,
    processStartTime: 'Mon Jan  1 00:00:00 2035',
    commandFingerprint: 'dev-server',
    state: 'RUNNING',
    startedAt: now,
    stoppedAt: null,
    stdoutPath: join(prepared.fixture.root, 'dev.out'),
    stderrPath: join(prepared.fixture.root, 'dev.err'),
  }).id;
}

async function removeLinked(
  prepared: Prepared,
  client: RuntimeDaemonClient,
  flags: readonly string[] = [],
): Promise<{ exitCode: number; envelope: JsonEnvelope<any> }> {
  let stdout = '';
  const exitCode = await runCli(
    ['remove', prepared.fixture.linkedWorktreePath, '--json', ...flags],
    {
      cwd: prepared.fixture.repoPath,
      analysisDatabasePath: prepared.databasePath,
      removalGlobalConfigPath: prepared.globalConfigPath,
      runtimeClient: client,
      stdout: (value) => { stdout += value; },
      stderr: () => {},
    },
  );
  return { exitCode, envelope: JSON.parse(stdout) as JsonEnvelope<any> };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const cases: Record<string, () => Promise<unknown>> = {
  /**
   * The fail-closed rule: WTM never signals a process the daemon supervises from a second
   * process, so an active record plus an unreachable daemon is a refusal. A worktree with no
   * active record is removed with no daemon at all, which is the other half of the same rule.
   */
  'daemon-unavailable': async () => {
    const withProcess = await prepare();
    startRunningProcess(withProcess);
    const refusedCommands: string[] = [];
    const refused = await removeLinked(withProcess, unreachableDaemon(refusedCommands));

    const withoutProcess = await prepare();
    const allowedCommands: string[] = [];
    const allowed = await removeLinked(withoutProcess, unreachableDaemon(allowedCommands));

    return {
      refusedExitCode: refused.exitCode,
      refusedCodes: refused.envelope.errors.map(({ code }) => code),
      refusedWorktreeExists: await pathExists(withProcess.fixture.linkedWorktreePath),
      refusedDaemonCommands: refusedCommands,
      allowedExitCode: allowed.exitCode,
      allowedOk: allowed.envelope.ok,
      allowedWorktreeExists: await pathExists(withoutProcess.fixture.linkedWorktreePath),
      // Nothing was running, so no stop was asked of a daemon that is not there. The reconcile
      // that follows the deletion is a different question and is always asked.
      allowedDaemonCommands: allowedCommands,
      allowedStoppedProcesses: allowed.envelope.data?.cleanup?.stoppedProcesses ?? null,
    };
  },

  /**
   * The success envelope's `cleanup` block, and the endpoint leases that must be verifiably
   * given back *before* Git deletes the directory rather than as a side effect of a later
   * reconcile.
   */
  'cleanup-envelope': async () => {
    const prepared = await prepare({
      workspaceConfig: [
        'version = 1', '', '[workspace]', 'name = "removal"', '',
        '[resources.node_modules]',
        'path = "{worktree.root}/node_modules"',
        'policy = "shared"', '',
      ].join('\n'),
    });
    for (const name of ['api', 'web']) {
      prepared.store.allocateEndpoint({
        worktreeId: prepared.worktreeId,
        name,
        protocol: 'tcp',
        host: '127.0.0.1',
        portRange: { min: 41_000, max: 41_100 },
      }, () => true);
    }
    const before = prepared.store.listEndpointLeases({ worktreeIds: [prepared.worktreeId] })
      .map(({ state }) => state);

    const { exitCode, envelope } = await removeLinked(prepared, unreachableDaemon([]));

    return {
      exitCode,
      ok: envelope.ok,
      cleanup: envelope.data?.cleanup ?? null,
      before,
      after: prepared.store.listEndpointLeases({ worktreeIds: [prepared.worktreeId] })
        .map(({ state }) => state),
      worktreeExists: await pathExists(prepared.fixture.linkedWorktreePath),
    };
  },

  /**
   * A worktree WTM does not know about has no managed processes, no endpoint leases and no
   * resources on record, so Git removal is the whole job — and saying so is the difference
   * between "runtime cleanup found nothing" and "runtime cleanup never ran".
   */
  'unregistered-worktree': async () => {
    const fixture = await createGitSafetyFixture();
    fixtures.push(fixture);
    const databasePath = join(fixture.root, 'state.db');
    // A registered *other* workspace, so the database exists and is opened: the warning must be
    // about this worktree being unknown, not about there being no state at all.
    const store = new SQLiteStateStore(databasePath);
    stores.push(store);
    store.upsertWorkspace({ name: 'elsewhere', root: join(fixture.root, 'elsewhere'), scope: 'local', configPath: null });

    let stdout = '';
    const exitCode = await runCli(['remove', fixture.linkedWorktreePath, '--json'], {
      cwd: fixture.repoPath,
      analysisDatabasePath: databasePath,
      removalGlobalConfigPath: join(fixture.root, 'absent-global.toml'),
      runtimeClient: unreachableDaemon([]),
      stdout: (value) => { stdout += value; },
      stderr: () => {},
    });
    const envelope = JSON.parse(stdout) as JsonEnvelope<any>;

    return {
      exitCode,
      ok: envelope.ok,
      warnings: envelope.warnings.map(({ code, message }) => [code, message.toLowerCase().includes('not registered')]),
      worktreeExists: await pathExists(fixture.linkedWorktreePath),
    };
  },

  /**
   * The gate reads the state database, not the stop response. A supervisor that reports success
   * and leaves the record active does not get past it.
   */
  'verify-reads-the-database': async () => {
    const prepared = await prepare();
    const processId = startRunningProcess(prepared);
    const asked: string[] = [];

    const { exitCode, envelope } = await removeLinked(prepared, lyingDaemon(asked));

    return {
      exitCode,
      ok: envelope.ok,
      codes: envelope.errors.map(({ code }) => code),
      context: {
        active: envelope.errors[0]?.context?.active ?? null,
        cleanupOwed: envelope.errors[0]?.context?.cleanupOwed ?? null,
      },
      daemonCommands: asked,
      stillRunning: prepared.store.getManagedProcess(processId)?.state ?? null,
      worktreeExists: await pathExists(prepared.fixture.linkedWorktreePath),
    };
  },

  /**
   * The stage that only exists for this: a `node_modules` WTM materialized is untracked content
   * to Git, so the analysis that guards the removal raises `GIT_UNTRACKED` over it. The removal
   * has to reach the cleanup stage that deletes it instead of refusing in front of that stage,
   * which is what made the stage unreachable in production and `collectedResources` always zero.
   */
  'ephemeral-resource-cleanup': async () => {
    const prepared = await prepare({
      workspaceConfig: [
        'version = 1', '', '[workspace]', 'name = "removal"', '',
        '[resources.node_modules]',
        'path = "{worktree.root}/node_modules"',
        'policy = "ephemeral"', '',
      ].join('\n'),
    });
    await mkdir(join(prepared.fixture.linkedWorktreePath, 'node_modules'), { recursive: true });
    await writeFile(join(prepared.fixture.linkedWorktreePath, 'node_modules', '.package-lock.json'), '{}\n');

    const { exitCode, envelope } = await removeLinked(prepared, unreachableDaemon([]));

    return {
      exitCode,
      ok: envelope.ok,
      errorCodes: envelope.errors.map(({ code }) => code),
      collectedResources: envelope.data?.cleanup?.collectedResources ?? null,
      worktreeExists: await pathExists(prepared.fixture.linkedWorktreePath),
    };
  },

  /**
   * The post-removal store step (item 54, `removal-coordinator.ts`'s `releaseEndpointLeases`)
   * deletes a removed worktree's CI watches (`wtm ci watch`) alongside its endpoint leases, since
   * worktree rows are never deleted and a stale watch would otherwise outlive the worktree it
   * named.
   */
  'ci-watch-cleanup': async () => {
    const prepared = await prepare();
    const now = new Date().toISOString();
    prepared.store.ci.start({
      repositoryId: prepared.repositoryId,
      worktreeId: prepared.worktreeId,
      worktreePath: prepared.fixture.linkedWorktreePath,
      providerRepo: 'github.com/acme/widgets',
      branch: 'refs/heads/feature/safe',
      headSha: 'a'.repeat(40),
      pr: null,
      now,
      nextPollAt: now,
      pollIntervalMs: 15_000,
      maxPending: 20,
    });
    const before = prepared.store.ci.latestForWorktree(prepared.worktreeId);

    const { exitCode, envelope } = await removeLinked(prepared, unreachableDaemon([]));

    return {
      exitCode,
      ok: envelope.ok,
      hadWatchBeforeRemoval: before !== null,
      watchAfterRemoval: prepared.store.ci.latestForWorktree(prepared.worktreeId),
      worktreeExists: await pathExists(prepared.fixture.linkedWorktreePath),
    };
  },

  /**
   * With no daemon to emit `worktree.removed`, the CLI reconciles the repository itself and says
   * so, rather than leaving the registration pointing at a directory that is gone.
   */
  'local-reconcile': async () => {
    const prepared = await prepare();

    const { exitCode, envelope } = await removeLinked(prepared, unreachableDaemon([]));

    return {
      exitCode,
      ok: envelope.ok,
      warnings: envelope.warnings.map(({ code, message }) => [
        code, message.includes('worktree.removed'),
      ]),
      registeredPaths: prepared.store.listWorktrees(prepared.repositoryId)
        .filter(({ state }) => state !== 'REMOVED' && state !== 'ORPHANED')
        .map(({ path }) => path),
      worktreeExists: await pathExists(prepared.fixture.linkedWorktreePath),
    };
  },

  /**
   * The ephemeral cleanup authorizes its deletions against the *injected* file-trust policy, not
   * against `@wtm/core`'s POSIX-only fallback.
   *
   * This is the win32 defect written so a Linux run can fail on it. On Windows, Node synthesises
   * every directory's `mode` as `0o777`, so core's fallback answers `isWritableOnlyByOwner(...,
   * 0o022)` with `false` for the worktree root and `wtm remove` refused `RESOURCE_PATH_DENIED`
   * over the very `node_modules` it had materialized. `chmod 0o777` on the worktree root
   * reproduces exactly that reading here; the ACL-shaped policy injected below is the one that
   * has the real answer, and reaching it is the whole fix. Both halves are asserted, so a
   * regression that drops the plumbing turns `authorized` red and a regression that stops
   * consulting the policy at all turns `refusedByCoreFallback` red.
   *
   * The refusing arm injects `defaultCoreFileTrustPolicy` itself rather than a restatement of it,
   * so the case demonstrates that the *actual* fallback refuses and cannot drift away from it.
   * It is injected rather than left to the coordinator's own default on purpose: that default is
   * the **host** policy, which on win32 is the ACL one and would accept this directory, so an
   * arm that relied on it would go red on the very platform this case exists for.
   */
  'ephemeral-cleanup-honours-injected-trust': async () => {
    const workspaceConfig = [
      'version = 1', '', '[workspace]', 'name = "removal"', '',
      '[resources.node_modules]',
      'path = "{worktree.root}/node_modules"',
      'policy = "ephemeral"', '',
    ].join('\n');

    /**
     * What a Windows ACL policy answers for a directory this user owns: mode bits are not
     * consulted at all, because on that platform they carry no access information.
     */
    const aclShapedPolicy: FileTrustPolicy = {
      isOwnedByCurrentUser: async () => true,
      isWritableOnlyByOwner: async () => true,
      isNotSharedByHardLink: () => true,
      currentIdentityAvailable: () => true,
    };

    const cleanup = async (fileTrust: FileTrustPolicy) => {
      const prepared = await prepare({ workspaceConfig });
      const worktreeRoot = prepared.fixture.linkedWorktreePath;
      await mkdir(join(worktreeRoot, 'node_modules'), { recursive: true });
      await writeFile(join(worktreeRoot, 'node_modules', '.package-lock.json'), '{}\n');
      // The Windows reading of an ordinary directory, produced on a POSIX filesystem.
      await chmod(worktreeRoot, 0o777);
      const coordinator = createProductionRemovalCoordinator({
        store: prepared.store,
        globalConfigPath: prepared.globalConfigPath,
        warn: () => {},
        fileTrust,
      });
      const subject = {
        repositoryId: prepared.repositoryId,
        worktreeId: prepared.worktreeId,
        worktreePath: worktreeRoot,
      };
      try {
        const report = await coordinator.cleanupEphemeralResources(subject);
        return { collected: report.collected, code: null as string | null };
      } catch (error) {
        return {
          collected: null as number | null,
          code: (error as { code?: string }).code ?? 'UNCODED',
        };
      } finally {
        await chmod(worktreeRoot, 0o700).catch(() => {});
      }
    };

    return {
      authorized: await cleanup(aclShapedPolicy),
      refusedByCoreFallback: await cleanup(defaultCoreFileTrustPolicy),
    };
  },
};

const name = process.argv[2] ?? '';
const selected = cases[name];
if (selected === undefined) {
  process.stderr.write(`unknown scenario case: ${name}\n`);
  process.exit(1);
}

try {
  process.stdout.write(`${JSON.stringify(await selected())}\n`);
} finally {
  for (const store of stores) store.close();
  for (const fixture of fixtures) await fixture.cleanup();
}
