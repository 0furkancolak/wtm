import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { createWorkspaceFixture } from '../../../../testkit/src/workspace-fixture';
import { SQLiteStateStore } from '../../state/sqlite-store';
import type {
  EndpointLease,
  EndpointRequest,
  ReconcileResult,
  RepositoryInput,
  RepositoryRecord,
  StateStore,
  WorkspaceInput,
  WorkspaceRecord,
} from '../../state/store';
import type { GitWorktreeRecord } from '../../git/worktree-parser';
import { initializeWorkspace } from '../init';

class FailingReconciliationStore implements StateStore {
  transactionDepth = 0;
  maximumTransactionDepth = 0;
  reconciliationCalls = 0;
  readonly reconciliationDepths: number[] = [];

  constructor(private readonly inner: SQLiteStateStore) {}

  upsertWorkspace(input: WorkspaceInput): WorkspaceRecord {
    return this.inner.upsertWorkspace(input);
  }

  upsertRepository(input: RepositoryInput): RepositoryRecord {
    return this.inner.upsertRepository(input);
  }

  reconcileWorktrees(repositoryId: string, snapshot: GitWorktreeRecord[]): ReconcileResult {
    this.reconciliationCalls += 1;
    this.reconciliationDepths.push(this.transactionDepth);
    if (this.reconciliationCalls === 2) throw new Error('injected second reconciliation failure');
    return this.inner.reconcileWorktrees(repositoryId, snapshot);
  }

  allocateEndpoint(input: EndpointRequest): EndpointLease {
    return this.inner.allocateEndpoint(input);
  }

  transaction<T>(fn: () => T): T {
    this.transactionDepth += 1;
    this.maximumTransactionDepth = Math.max(this.maximumTransactionDepth, this.transactionDepth);
    try {
      return this.inner.transaction(fn);
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

const scenario = process.argv[2];
if (scenario === undefined) throw new Error('Scenario name is required');

const fixture = await createWorkspaceFixture();
const databasePath = join(fixture.userDataDir, 'state.db');
let store = new SQLiteStateStore(databasePath);

try {
  if (scenario === 'local') {
    const configPath = join(fixture.root, 'wtm.toml');
    const result = await initializeWorkspace({
      root: fixture.root,
      maxDepth: 5,
      globalOnly: false,
      userDataDir: fixture.userDataDir,
      stateStore: store,
    });
    const initialWorktrees = result.repositories
      .flatMap((entry) => entry.reconciliation.discovered)
      .map((worktree) => [worktree.path, worktree.id, worktree.numericId])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    store.close();
    store = new SQLiteStateStore(databasePath);
    const reopened = await initializeWorkspace({
      root: fixture.root,
      maxDepth: 5,
      globalOnly: false,
      userDataDir: fixture.userDataDir,
      stateStore: store,
    });
    const reopenedWorktrees = reopened.repositories
      .flatMap((entry) => entry.reconciliation.updated)
      .map((worktree) => [worktree.path, worktree.id, worktree.numericId])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    print({
      workspace: {
        name: result.workspace.name,
        scope: result.workspace.scope,
        configIsLocal: result.workspace.configPath === configPath,
      },
      repositoryNames: result.repositories.map((entry) => basename(entry.repository.mainRoot)),
      discoveredWorktrees: result.repositories.flatMap((entry) => entry.reconciliation.discovered).length,
      stableWorktreeIdsAfterReopen: JSON.stringify(reopenedWorktrees) === JSON.stringify(initialWorktrees),
      reopenedDiscoveredWorktrees: reopened.repositories
        .flatMap((entry) => entry.reconciliation.discovered).length,
      reopenedUpdatedWorktrees: reopened.repositories
        .flatMap((entry) => entry.reconciliation.updated).length,
      foundWorkspaceMakefile: result.discovery.taskMarkers.some(
        (marker) => marker.path === join(fixture.root, 'Makefile') && marker.workspaceLevel,
      ),
      config: await readFile(configPath, 'utf8'),
    });
  } else if (scenario === 'global-only') {
    const result = await initializeWorkspace({
      root: fixture.root,
      maxDepth: 5,
      globalOnly: true,
      userDataDir: fixture.userDataDir,
      stateStore: store,
    });
    print({
      scope: result.workspace.scope,
      configIsInUserData: result.configPath.startsWith(`${fixture.userDataDir}/workspaces/`),
      config: await readFile(result.configPath, 'utf8'),
      localConfigExists: await exists(join(fixture.root, 'wtm.toml')),
      discoveryStayedAtSelectedRoot: result.discovery.root === fixture.root,
      repositoryCount: result.discovery.repositories.length,
    });
  } else if (scenario === 'repeat') {
    const configPath = join(fixture.root, 'wtm.toml');
    const original = 'version = 1\n\n[workspace]\nname = "chosen-by-user"\n\n[tasks.test]\nrun = ["bun", "test"]\n';
    await writeFile(configPath, original);
    const result = await initializeWorkspace({
      root: fixture.root,
      globalOnly: false,
      userDataDir: fixture.userDataDir,
      stateStore: store,
    });
    print({
      workspaceName: result.workspace.name,
      configUnchanged: await readFile(configPath, 'utf8') === original,
      configChanged: result.configChanged,
    });
  } else if (scenario === 'invalid-name') {
    let errorCode: string | null = null;
    try {
      await initializeWorkspace({
        root: fixture.root,
        workspaceName: '',
        userDataDir: fixture.userDataDir,
        stateStore: store,
      });
    } catch (error) {
      errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null;
    }
    print({
      errorCode,
      localConfigExists: await exists(join(fixture.root, 'wtm.toml')),
    });
  } else if (scenario === 'reconciliation-rollback') {
    const failingStore = new FailingReconciliationStore(store);
    let errorMessage: string | null = null;
    try {
      await initializeWorkspace({
        root: fixture.root,
        userDataDir: fixture.userDataDir,
        stateStore: failingStore,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    store.close();
    const database = new Database(databasePath, { readonly: true });
    try {
      print({
        errorMessage,
        maximumOuterTransactionDepth: failingStore.maximumTransactionDepth,
        reconciliationDepths: failingStore.reconciliationDepths,
        persistedCounts: {
          workspaces: countRows(database, 'workspaces'),
          repositories: countRows(database, 'repositories'),
          worktrees: countRows(database, 'worktrees'),
        },
      });
    } finally {
      database.close();
    }
  } else if (scenario === 'existing-incomplete') {
    const configPath = join(fixture.root, 'wtm.toml');
    const original = '# user setting\n[ports.web]\npreferred = 4111\n';
    await writeFile(configPath, original);
    const error = await captureInitError(() => initializeWorkspace({
      root: fixture.root,
      userDataDir: fixture.userDataDir,
      stateStore: store,
    }));
    print({
      errorCode: error.code,
      conflict: error.context?.conflict,
      action: error.context?.action,
      requiredChanges: error.context?.requiredChanges,
      finalConfig: await readFile(configPath, 'utf8'),
    });
  } else if (scenario === 'secret-context') {
    const configPath = join(fixture.root, 'wtm.toml');
    const environmentSecret = 'environment-secret-do-not-serialize';
    const userWorkspaceName = 'user-authored-private-name';
    const original = `[workspace]\nname = "${userWorkspaceName}"\n\n[environment]\nAPI_TOKEN = "${environmentSecret}"\n`;
    await writeFile(configPath, original);
    let serializedError = '';
    let errorCode: string | null = null;
    let requiredChanges: unknown = null;
    try {
      await initializeWorkspace({
        root: fixture.root,
        userDataDir: fixture.userDataDir,
        stateStore: store,
      });
    } catch (error) {
      serializedError = JSON.stringify(error);
      if (typeof error === 'object' && error !== null) {
        errorCode = 'code' in error && typeof error.code === 'string' ? error.code : null;
        if ('context' in error && typeof error.context === 'object' && error.context !== null) {
          requiredChanges = (error.context as Record<string, unknown>).requiredChanges ?? null;
        }
      }
    }
    print({
      errorCode,
      requiredChanges,
      serializedErrorContainsEnvironmentSecret: serializedError.includes(environmentSecret),
      serializedErrorContainsUserWorkspaceName: serializedError.includes(userWorkspaceName),
      configUnchanged: await readFile(configPath, 'utf8') === original,
    });
  } else if (scenario === 'malformed-secret') {
    const configPath = join(fixture.root, 'wtm.toml');
    const secret = 'core-unterminated-secret-token-value';
    const offendingSourceLine = `API_TOKEN = "${secret}`;
    const original = `version = 1\n\n[workspace]\nname = "valid-name"\n\n[environment]\n${offendingSourceLine}\n`;
    await writeFile(configPath, original);
    let captured: unknown;
    try {
      await initializeWorkspace({
        root: fixture.root,
        userDataDir: fixture.userDataDir,
        stateStore: store,
      });
    } catch (error) {
      captured = error;
    }
    const serializedError = JSON.stringify(captured);
    const message = captured instanceof Error ? captured.message : String(captured);
    const stack = captured instanceof Error ? captured.stack ?? '' : '';
    const context = typeof captured === 'object' && captured !== null
      && 'context' in captured && typeof captured.context === 'object' && captured.context !== null
      ? captured.context as Record<string, unknown>
      : {};
    print({
      errorCode: typeof captured === 'object' && captured !== null
        && 'code' in captured && typeof captured.code === 'string' ? captured.code : null,
      message,
      sourceIsConfigPath: context.source === configPath,
      category: context.category ?? null,
      action: context.action ?? null,
      serializedErrorContainsSecret: serializedError.includes(secret),
      serializedErrorContainsTokenName: serializedError.includes('API_TOKEN'),
      serializedErrorContainsSourceExcerpt: serializedError.includes('API_TOKEN = '),
      serializedErrorContainsParserMessage: serializedError.includes('Invalid TOML document'),
      serializedErrorContainsParserMetadata: serializedError.includes('codeblock')
        || serializedError.includes('cause')
        || serializedError.includes('stack'),
      messageContainsSecret: message.includes(secret),
      messageContainsSourceExcerpt: message.includes('API_TOKEN = '),
      stackContainsParserDetails: stack.includes(secret)
        || stack.includes('API_TOKEN = ')
        || stack.includes('smol-toml'),
      configUnchanged: await readFile(configPath, 'utf8') === original,
    });
  } else if (scenario === 'existing-publication-guard') {
    const configPath = join(fixture.root, 'wtm.toml');
    const original = '# keep exactly\n[ports.web]\npreferred = 4222\n';
    let publicationHookCalled = false;
    await writeFile(configPath, original);
    const error = await captureInitError(() => initializeWorkspace({
      root: fixture.root,
      userDataDir: fixture.userDataDir,
      stateStore: store,
      beforeConfigCommit: async () => {
        publicationHookCalled = true;
        await writeFile(configPath, 'version = 1\n\n[workspace]\nname = "overwritten"\n');
      },
    }));
    print({
      errorCode: error.code,
      conflict: error.context?.conflict,
      publicationHookCalled,
      finalConfig: await readFile(configPath, 'utf8'),
    });
  } else if (scenario === 'concurrent-create') {
    const configPath = join(fixture.root, 'wtm.toml');
    const concurrent = 'version = 1\n\n[workspace]\nname = "created-concurrently"\n';
    const error = await captureInitError(() => initializeWorkspace({
      root: fixture.root,
      userDataDir: fixture.userDataDir,
      stateStore: store,
      beforeConfigCommit: () => writeFile(configPath, concurrent, { flag: 'wx' }),
    }));
    print({
      errorCode: error.code,
      conflict: error.context?.conflict,
      finalConfig: await readFile(configPath, 'utf8'),
    });
  } else {
    throw new Error(`Unknown scenario: ${scenario}`);
  }
} finally {
  store.close();
  await fixture.cleanup();
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function countRows(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

async function captureInitError(run: () => Promise<unknown>): Promise<{
  code: string | null;
  context?: Record<string, unknown>;
}> {
  try {
    await run();
    return { code: null };
  } catch (error) {
    if (typeof error !== 'object' || error === null) return { code: null };
    return {
      code: 'code' in error && typeof error.code === 'string' ? error.code : null,
      ...('context' in error && typeof error.context === 'object' && error.context !== null
        ? { context: error.context as Record<string, unknown> }
        : {}),
    };
  }
}
