import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteStateStore } from '../sqlite-store';

const root = mkdtempSync(join(tmpdir(), 'wtm-feature-creations-'));
const path = join(root, 'state.db');
const outcome = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch { return 'refused'; } };

try {
  const store = new SQLiteStateStore(path);
  const workspace = store.upsertWorkspace({ name: 'ws', root: '/ws', scope: 'local', configPath: '/ws/wtm.toml' });
  const web = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/ws/web/.git', mainRoot: '/ws/web', remoteIdentity: null });
  const api = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/ws/api/.git', mainRoot: '/ws/api', remoteIdentity: null });
  const branch = 'refs/heads/feat/auth';
  const members = [
    { repositoryId: web.id, repositoryMainRoot: '/ws/web', position: 0, worktreePath: '/ws/web-feat-auth', branchExisted: false, startOid: 'a'.repeat(40) },
    { repositoryId: api.id, repositoryMainRoot: '/ws/api', position: 1, worktreePath: '/ws/api-feat-auth', branchExisted: true, startOid: 'b'.repeat(40) },
  ];

  const sameFeature = store.upsertFeature(workspace.id, branch).id === store.upsertFeature(workspace.id, branch).id;
  const first = store.beginFeatureCreation({ workspaceId: workspace.id, branch, fromRef: null, members });
  const secondOpenWhileFirstOpen = outcome(() => store.beginFeatureCreation({ workspaceId: workspace.id, branch, fromRef: null, members }));
  const openAfterBegin = store.readOpenFeatureCreation(workspace.id, branch);

  // Every member still PLANNED: superseding is allowed and replaces the open creation.
  const superseding = store.beginFeatureCreation({ workspaceId: workspace.id, branch, fromRef: 'main', members, supersedeCreationId: first.id });
  const firstAfterSupersede = store.readFeatureCreation(first.id)?.state;

  store.advanceCreationMember(superseding.id, web.id, 'APPLYING', null);
  store.advanceCreationMember(superseding.id, web.id, 'PLANNED', 'GIT_COMMAND_FAILED');
  const afterFailure = store.readFeatureCreation(superseding.id)?.members.map((m) => [m.phase, m.lastErrorCode]);
  store.advanceCreationMember(superseding.id, web.id, 'APPLIED', null);
  const supersedeOnceApplied = outcome(() => store.supersedeFeatureCreation(superseding.id));
  const completeBeforeRegistered = outcome(() => store.completeFeatureCreation(superseding.id));
  store.advanceCreationMember(superseding.id, web.id, 'REGISTERED', null);
  store.advanceCreationMember(superseding.id, api.id, 'REGISTERED', null);
  store.completeFeatureCreation(superseding.id);
  const completed = store.readFeatureCreation(superseding.id);
  const openAfterComplete = store.readOpenFeatureCreation(workspace.id, branch);

  // Forgetting a repository leaves its member rows, so resume can name it.
  const third = store.beginFeatureCreation({ workspaceId: workspace.id, branch: 'refs/heads/feat/other', fromRef: null, members });
  store.forgetRepository(api.id);
  const membersAfterForgetRepository = store.readFeatureCreation(third.id)?.members.length;
  store.close();

  // Forgetting a workspace cascades features, creations and members.
  const raw = new Database(path);
  raw.pragma('foreign_keys = ON');
  raw.prepare('DELETE FROM worktrees').run();
  raw.prepare('DELETE FROM repositories').run();
  raw.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
  const rowsAfterForgetWorkspace = ['features', 'feature_creations', 'feature_creation_members']
    .map((table) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  raw.close();

  console.log(JSON.stringify({
    sameFeature,
    firstState: first.state,
    firstMembers: first.members.map((m) => [m.position, m.phase, m.branchExisted]),
    secondOpenWhileFirstOpen,
    openAfterBegin: openAfterBegin?.id === first.id,
    supersedingState: superseding.state,
    supersedingFromRef: superseding.fromRef,
    firstAfterSupersede,
    afterFailure,
    supersedeOnceApplied,
    completeBeforeRegistered,
    completedState: completed?.state,
    completedAtSet: completed?.completedAt !== null,
    openAfterComplete,
    membersAfterForgetRepository,
    rowsAfterForgetWorkspace,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
