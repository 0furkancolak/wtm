import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessStartIdentity } from '../../runtime/process-identity';
import { SQLiteStateStore } from '../../state/sqlite-store';
import type { RepositoryOperationLeaseKey } from '../../state/store';
import { RepositoryOperationConflictError, withRepositoryOperationLease } from '../operation-lease';

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
    const input = { store, repositoryId: repository.id, operation: 'remove' as const };

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
    const self = await readProcessStartIdentity(process.pid);
    if (self === null) throw new Error('This process has no readable start identity');
    store.acquireRepositoryOperationLease({
      ...key,
      token: 'live-holder-token',
      pid: self.pid,
      processStartTime: self.processStartTime,
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
