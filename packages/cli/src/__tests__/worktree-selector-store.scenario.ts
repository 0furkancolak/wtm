import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { listGitWorktrees, readGitRepositoryIdentity, SQLiteStateStore } from '@wtm/core';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { collectSelectorCandidates, matchWorktreeSelector, resolveTaskTarget } from '../worktree-selector';

/**
 * Two `worktree-selector.ts` cases that need a real `SQLiteStateStore`, run out of process
 * (`worktree-selector.test.ts`'s own comment explains why: constructing one in-process there
 * panics this Bun build's better-sqlite3 binding).
 */

/**
 * Item 47 review finding 5: `withNumbers` used to key registered worktrees by their exact stored
 * `path`, so a number registered under a symlinked spelling of a worktree never matched Git
 * topology's canonical spelling of the same path. It must now compare both after `realpath`.
 */
async function symlinkedRegisteredNumber() {
  const fixture = await createGitSafetyFixture();
  try {
    const symlinkedSpelling = join(fixture.root, 'symlinked-spelling');
    await symlink(fixture.linkedWorktreePath, symlinkedSpelling);
    const databasePath = join(fixture.root, 'state.db');
    const identity = await readGitRepositoryIdentity(fixture.repoPath);
    const writableStore = new SQLiteStateStore(databasePath);
    const workspace = writableStore.upsertWorkspace({
      name: 'fixture', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
    });
    const repository = writableStore.upsertRepository({
      workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: fixture.repoPath, remoteIdentity: null,
    });
    const topology = await listGitWorktrees(fixture.repoPath);
    // Register the linked worktree under the symlinked spelling, as if that were the path a
    // caller had originally registered it under — `listGitWorktrees` itself always reports the
    // canonical one.
    const registeredAsSymlink = topology.map((record) =>
      record.path === fixture.linkedWorktreePath ? { ...record, path: symlinkedSpelling } : record);
    writableStore.reconcileWorktrees(repository.id, registeredAsSymlink);
    writableStore.close();

    const store = new SQLiteStateStore(databasePath, { readonly: true });
    try {
      const collected = await collectSelectorCandidates({
        cwd: fixture.repoPath, store, globalConfigPath: join(fixture.root, 'absent-global.toml'),
      });
      if (collected.outcome !== 'collected') return { matched: false, reason: `collectSelectorCandidates refused: ${JSON.stringify(collected)}` };
      const feature = collected.candidates.find(({ record }) => record.path === fixture.linkedWorktreePath);
      if (feature?.numericId == null) return { matched: false, reason: `no numericId for ${fixture.linkedWorktreePath}: ${JSON.stringify(collected.candidates)}` };
      const matched = await matchWorktreeSelector({
        selector: String(feature.numericId), cwd: fixture.repoPath, candidates: collected.candidates, repositories: collected.repositories,
      });
      return {
        matched: matched.outcome === 'selected' && matched.candidate.record.path === fixture.linkedWorktreePath,
        outcome: matched.outcome,
      };
    } finally {
      store.close();
    }
  } finally {
    await fixture.cleanup();
  }
}

/**
 * Item 47 review finding 3: without `--worktree`, `resolveTaskTarget`'s workspace-root probe must
 * fall back to sending `cwd` unchanged on any failure — including a query against the state
 * database, not only the store failing to open. A real, valid, but never-migrated SQLite file
 * opens fine readonly (no schema check happens for a readonly open); the failure the probe must
 * survive comes from the first query against it, the same shape as a stale schema or a transient
 * `SQLITE_BUSY`.
 */
async function unmigratedProbe() {
  const fixture = await createGitSafetyFixture();
  try {
    const databasePath = join(fixture.root, 'unmigrated.db');
    const database = new Database(databasePath);
    database.close();

    return await resolveTaskTarget({
      cwd: fixture.repoPath, argv: ['wtm', 'start', 'dev'],
      databasePath, globalConfigPath: join(fixture.root, 'c.toml'),
    });
  } finally {
    await fixture.cleanup();
  }
}

process.stdout.write(`${JSON.stringify({
  symlinkedRegisteredNumber: await symlinkedRegisteredNumber(),
  unmigratedProbe: await unmigratedProbe(),
})}\n`);
