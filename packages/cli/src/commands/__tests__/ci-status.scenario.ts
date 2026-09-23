/**
 * `readCiStatus` reads a real `SQLiteStateStore`, which — like every other store-backed CLI test —
 * must run out of process: constructing one inside a bun test reliably panics this Bun build's
 * better-sqlite3 binding (a native crash, not a catchable exception). See
 * `worktree-selector.test.ts` for the same convention.
 *
 * Each case is selected by name so one Node start covers one behaviour.
 */
import { join } from 'node:path';
import { listGitWorktrees, SQLiteStateStore, type WorktreeRecord } from '@wtm/core';
import { createGitSafetyFixture, type GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { readCiStatus } from '../ci';

interface Prepared {
  fixture: GitSafetyFixture;
  databasePath: string;
  store: SQLiteStateStore;
  repositoryId: string;
  main: WorktreeRecord;
  linked: WorktreeRecord;
}

const fixtures: GitSafetyFixture[] = [];
const stores: SQLiteStateStore[] = [];

async function prepare(): Promise<Prepared> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  const databasePath = join(fixture.root, 'state.db');
  const store = new SQLiteStateStore(databasePath);
  stores.push(store);
  const workspace = store.upsertWorkspace({ name: 'ci-status', root: fixture.root, scope: 'local', configPath: null });
  const repository = store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: join(fixture.repoPath, '.git'),
    mainRoot: fixture.repoPath,
    remoteIdentity: null,
  });
  store.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.repoPath));
  const worktrees = store.listWorktrees(repository.id);
  const main = worktrees.find(({ path }) => path === fixture.repoPath);
  const linked = worktrees.find(({ path }) => path === fixture.linkedWorktreePath);
  if (main === undefined || linked === undefined) throw new Error('the fixture worktrees were not registered');
  return { fixture, databasePath, store, repositoryId: repository.id, main, linked };
}

const cases: Record<string, () => Promise<unknown>> = {
  /**
   * `store.ci.start` records a watch for the registered main worktree; `readCiStatus` (default
   * and `--all`) must read it back locally, with no daemon and no network involved.
   */
  'watch-then-status': async () => {
    const { fixture, databasePath, store, repositoryId, main } = await prepare();
    const before = readCiStatus({ cwd: fixture.repoPath, all: false, databasePath });
    const now = new Date().toISOString();
    store.ci.start({
      repositoryId,
      worktreeId: main.id,
      worktreePath: main.path,
      providerRepo: 'github.com/acme/widgets',
      branch: 'refs/heads/main',
      headSha: fixture.mainHead,
      pr: null,
      now,
      nextPollAt: now,
      pollIntervalMs: 15_000,
      maxPending: 20,
    });
    store.close();

    const single = readCiStatus({ cwd: fixture.repoPath, all: false, databasePath });
    const all = readCiStatus({ cwd: fixture.repoPath, all: true, databasePath });
    const allData = all.data as { watches: Array<{ worktreePath: string; watch: { headSha: string } }> };
    const singleData = single.data as { watch: { headSha: string } | null };
    return {
      beforeOk: before.ok,
      beforeCommand: before.command,
      beforeWatch: (before.data as { watch: unknown }).watch,
      singleOk: single.ok,
      singleCommand: single.command,
      singleHeadSha: singleData.watch?.headSha ?? null,
      allOk: all.ok,
      allCommand: all.command,
      allWatches: allData.watches.map((entry) => ({ worktreePath: entry.worktreePath, headSha: entry.watch.headSha })),
    };
  },

  /** A directory inside no registered worktree is refused, with a `--all` remediation. */
  'status-outside-registered-worktree': async () => {
    const { fixture, databasePath, store } = await prepare();
    store.close();
    const result = readCiStatus({ cwd: fixture.root, all: false, databasePath });
    return {
      ok: result.ok,
      code: result.errors[0]?.code ?? null,
      remediation: result.errors[0]?.remediation ?? null,
    };
  },

  /**
   * `wtm remove` reconciles a removed worktree's row to `ORPHANED` rather than deleting it, and a
   * single removal never prunes its `ci_watches` row. `readCiStatus` must not keep reporting that
   * stale, now-meaningless watch as current once the worktree it belonged to is dead -- neither
   * for a `cwd` still pointed at the dead path, nor in the `--all` listing.
   */
  'status-excludes-removed-worktree': async () => {
    const { fixture, databasePath, store, repositoryId, main, linked } = await prepare();
    const now = new Date().toISOString();
    store.ci.start({
      repositoryId,
      worktreeId: linked.id,
      worktreePath: linked.path,
      providerRepo: 'github.com/acme/widgets',
      branch: 'refs/heads/feature',
      headSha: fixture.mainHead,
      pr: null,
      now,
      nextPollAt: now,
      pollIntervalMs: 15_000,
      maxPending: 20,
    });
    const beforeRemoval = readCiStatus({ cwd: linked.path, all: true, databasePath });

    // Simulate `wtm remove <linked>` completing: git no longer lists it, so reconciling drops it
    // out of the snapshot -- exactly what the real removal lifecycle's own `reconcile` stage does.
    store.reconcileWorktrees(repositoryId, await listGitWorktrees(fixture.repoPath).then(
      (worktrees) => worktrees.filter(({ path }) => path !== linked.path),
    ));
    store.close();

    const single = readCiStatus({ cwd: linked.path, all: false, databasePath });
    const all = readCiStatus({ cwd: fixture.repoPath, all: true, databasePath });
    const allData = all.data as { watches: Array<{ worktreePath: string }> };
    return {
      beforeRemovalCount: (beforeRemoval.data as { watches: unknown[] }).watches.length,
      singleOk: single.ok,
      singleCode: single.errors[0]?.code ?? null,
      allOk: all.ok,
      allWorktreePaths: allData.watches.map((entry) => entry.worktreePath),
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
