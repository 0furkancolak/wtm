/**
 * One attempt to take a repository operation lease, composed the way the daemon would.
 *
 * There is no daemon subcommand that performs a destructive repository operation today, so this
 * is not `wtm daemon` invoked with flags the way `remove-child.ts` invokes `wtm remove` — it is
 * the daemon's own composition, run standalone: `withRepositoryOperationLease` and
 * `SQLiteStateStore` straight from `@wtm/core`, and `selectPlatformRuntime` from `@wtm/platform`
 * for the process-start-time reader, exactly as `packages/daemon/src/runtime-factory.ts` and
 * `packages/daemon/src/process-supervisor.ts` obtain it. What makes this a genuine second identity
 * rather than a second call in the same process is that it runs as its own OS process against the
 * same `state.db`, so the lease sees a real, distinct PID.
 *
 * Argv: `<databasePath> <repositoryId> <operation>`.
 */
import { RepositoryOperationConflictError, SQLiteStateStore, withRepositoryOperationLease, type RepositoryOperation } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';

const [databasePath, repositoryId, operation] = process.argv.slice(2);
if (databasePath === undefined || repositoryId === undefined || operation === undefined) {
  process.stderr.write('daemon-lease-conflict-child: databasePath repositoryId operation\n');
  process.exit(2);
}

const store = new SQLiteStateStore(databasePath);
try {
  const outcome = await withRepositoryOperationLease(
    {
      store,
      readProcessStartTime: (pid) => selectPlatformRuntime().process.readStartTime(pid),
      repositoryId,
      operation: operation as RepositoryOperation,
    },
    async () => 'daemon-would-proceed',
  ).then(
    (value) => ({ outcome: 'acquired' as const, value }),
    (error: unknown) => {
      if (!(error instanceof RepositoryOperationConflictError)) throw error;
      return { outcome: 'conflict' as const, code: error.code, abandoned: error.abandoned, context: error.context };
    },
  );
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
} finally {
  store.close();
}
