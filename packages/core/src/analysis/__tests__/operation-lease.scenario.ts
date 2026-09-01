import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStateStore } from '../../state/sqlite-store';
import type { RepositoryOperationLeaseKey } from '../../state/store';
import {
  RepositoryOperationConflictError,
  withRepositoryOperationLease,
  type ProcessStartTimeReader,
} from '../operation-lease';

const selfStartTime = 'Mon Aug 31 09:59:00 2026';

/**
 * The start-time reader this scenario hands the lease.
 *
 * It is scripted rather than real because `@wtm/core` has no reader of its own any more and must
 * not acquire one: asking the operating system is `@wtm/platform`'s job, and a core test that
 * imported it would be the very dependency the package boundary exists to forbid. What is under
 * test here is the *store* — a real SQLite database, a real transaction, a real journal — and the
 * lease policy sitting on it, both of which are indifferent to how a start time was obtained.
 *
 * That a genuinely reaped process really does read as absent is proven against a live `ps` in
 * `packages/platform/src/process/__tests__/darwin-process.test.ts`, which is where the reader now
 * lives. The PID below is still a real, really-dead one so the row holds something that is
 * provably not this process rather than a number picked out of the air.
 */
const scriptedReader: ProcessStartTimeReader = async (pid) =>
  pid === process.pid ? selfStartTime : null;

/** A PID that has certainly been released: the child is run to completion before it is used. */
function deadProcessId(): number {
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number.parseInt(output, 10);
}

async function conflictOf(promise: Promise<unknown>): Promise<RepositoryOperationConflictError> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  if (!(error instanceof RepositoryOperationConflictError)) {
    throw new Error(`Expected a repository operation conflict, received ${String(error)}`);
  }
  return error;
}

async function sqliteOperationLease(): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'wtm-operation-lease-'));
  const store = new SQLiteStateStore(join(directory, 'state.db'));
  try {
    const workspace = store.upsertWorkspace({
      name: 'demo',
      root: '/projects/demo',
      scope: 'local',
      configPath: null,
    });
    const repository = store.upsertRepository({
      workspaceId: workspace.id,
      commonGitDir: '/projects/demo/repo/.git',
      mainRoot: '/projects/demo/repo',
      remoteIdentity: null,
    });
    const key: RepositoryOperationLeaseKey = { repositoryId: repository.id, operation: 'remove' };
    const input = {
      store,
      readProcessStartTime: scriptedReader,
      repositoryId: repository.id,
      operation: 'remove' as const,
    };

    let bodySawOwnLease = false;
    let stageDuringBody: string | null = null;
    const bodyResult = await withRepositoryOperationLease(input, async (session) => {
      bodySawOwnLease = store.readRepositoryOperationLease(key)?.pid === process.pid;
      session.advance('release-endpoints');
      stageDuringBody = store.readRepositoryOperationLease(key)?.stage ?? null;
      return 'removed';
    });
    const leaseAfterSuccess = store.readRepositoryOperationLease(key);

    // A holder that is genuinely this live process, still inside its TTL.
    store.acquireRepositoryOperationLease({
      ...key,
      token: 'live-holder-token',
      pid: process.pid,
      processStartTime: selfStartTime,
      ttlMs: 120_000,
    }, new Date().toISOString());
    const liveHolder = await conflictOf(withRepositoryOperationLease(input, async () => 'unreachable'));
    store.releaseRepositoryOperationLease(key, 'live-holder-token');

    // A holder that died mid-cleanup: expired, journalled, and provably gone.
    const acquiredAt = new Date(Date.now() - 600_000).toISOString();
    store.acquireRepositoryOperationLease({
      ...key,
      token: 'dead-holder-token',
      pid: deadProcessId(),
      processStartTime: 'Mon Aug 31 10:00:00 2026',
      ttlMs: 1_000,
    }, acquiredAt);
    store.advanceRepositoryOperationLease(key, 'dead-holder-token', 'stop-processes', acquiredAt);

    const abandoned = await conflictOf(withRepositoryOperationLease(input, async () => 'unreachable'));
    const resumedFrom = await withRepositoryOperationLease(
      { ...input, adopt: true },
      async (session) => session.adoptedStage,
    );

    return {
      bodySawOwnLease,
      bodyResult,
      stageDuringBody,
      leaseAfterSuccess,
      liveHolderCode: liveHolder.code,
      liveHolderAbandoned: liveHolder.abandoned,
      liveHolderStage: liveHolder.context.stage ?? null,
      abandonedCode: abandoned.code,
      abandonedAbandoned: abandoned.abandoned,
      abandonedStage: abandoned.context.stage ?? null,
      abandonedRemediation: abandoned.remediation,
      resumedFrom,
      leaseAfterResume: store.readRepositoryOperationLease(key),
    };
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const scenarios: Record<string, () => Promise<unknown>> = {
  'sqlite-operation-lease': sqliteOperationLease,
};

const scenarioName = process.argv[2];
const scenario = scenarioName === undefined ? undefined : scenarios[scenarioName];
if (scenario === undefined) throw new Error(`Unknown scenario: ${scenarioName ?? '<missing>'}`);
process.stdout.write(`${JSON.stringify(await scenario())}\n`);
