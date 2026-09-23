import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JsonEnvelope, Remediation, WtmError } from '@wtm/protocol';
import {
  classifyMemberRecovery,
  createWorktree,
  listGitWorktrees,
  planFeatureCreation,
  RepositoryOperationConflictError,
  resolveCommit,
  resolveFeatureMembers,
  resolveWorkspaceConfig,
  SQLiteStateStore,
  withRepositoryOperationLeases,
  WtmConfigError,
} from '@wtm/core';
import type {
  FeatureCreationPhase,
  FeatureCreationRecord,
  FeatureMemberMeasurement,
  GitWorktreeRecord,
  ProcessStartTimeReader,
  RepositoryOperationLeasesSession,
  RepositoryRecord,
  WorkspaceRecord,
  WorktreeCreationPlan,
  WorktreeCreationResult,
} from '@wtm/core';
import { workspaceContaining } from '../worktree-selector';
import { gitFailure, message, notInitialized, reconciledByDaemon, type CreateRegistration } from './create';
import type { RuntimeDaemonClient } from './runtime-client';

export interface FeatureCreateCommandInput {
  cwd: string;
  branch: string;
  /** `--repos`, split on commas. Required unless `resume`. */
  repos?: readonly string[] | undefined;
  from?: string | undefined;
  resume: boolean;
  databasePath: string;
  globalConfigPath: string;
  client?: RuntimeDaemonClient | undefined;
  readProcessStartTime: ProcessStartTimeReader;
  hostId: string;
  /** Test seam for the Git write. Defaults to `createWorktree`. */
  applyWorktree?: ((repoPath: string, plan: WorktreeCreationPlan) => Promise<WorktreeCreationResult>) | undefined;
  /**
   * Test seam: runs first once every lease is held, before the open creation is read again and
   * pre-flight is measured again, so a scenario can change the world between planning and leasing.
   */
  afterLeases?: (() => Promise<void>) | undefined;
  /** Test seam for the topology a local registration reconciles. Defaults to `listGitWorktrees`. */
  registrationTopology?: ((repoPath: string) => Promise<GitWorktreeRecord[]>) | undefined;
}

export interface FeatureCreateMemberData {
  repository: { id: string; mainRoot: string };
  worktree: { path: string; branch: string | null; head: string | null } | null;
  branch: { name: string; created: boolean; startPoint: string };
  phase: FeatureCreationPhase;
  recoveredFrom?: FeatureCreationPhase;
}

export interface FeatureCreateCommandData {
  feature: { id: string; branch: string };
  members: FeatureCreateMemberData[];
  registration: CreateRegistration | null;
  resumed: boolean;
}

type Envelope = JsonEnvelope<FeatureCreateCommandData | null>;

interface MemberWork {
  repository: { id: string; mainRoot: string };
  /** The Git write still to do, or null when there is none. */
  plan: WorktreeCreationPlan | null;
  /** A worktree that already exists for this member. */
  worktree: GitWorktreeRecord | null;
  alreadyRegistered: boolean;
}

/**
 * `wtm create <branch> --repos …` and `wtm create <branch> --resume` (spec
 * 2026-09-13-multi-repo-create-design.md).
 */
export async function runFeatureCreateCommand(input: FeatureCreateCommandInput): Promise<Envelope> {
  if (!existsSync(input.databasePath)) return failure([notInitialized()]);
  let store: SQLiteStateStore;
  try {
    store = new SQLiteStateStore(input.databasePath);
  } catch {
    return failure([notInitialized()]);
  }
  const branch = shortBranch(input.branch);
  try {
    const workspace = workspaceContaining(store, input.cwd);
    if (workspace === undefined) return failure([notInitialized()]);
    const repositories = store.listRepositories(workspace.id);
    const open = store.readOpenFeatureCreation(workspace.id, `refs/heads/${branch}`);
    return input.resume
      ? await resume(input, store, workspace, repositories, branch, open)
      : await createFresh(input, store, workspace, repositories, branch, open);
  } catch (error) {
    if (error instanceof RepositoryOperationConflictError) {
      return failure([{
        code: error.code, message: error.message, severity: error.severity,
        context: { ...error.context },
        remediation: error.remediation.map((remediation) => runnableResume(remediation, branch, input.repos)),
      }]);
    }
    // An invalid workspace configuration, including several `[repos]` entries naming one
    // repository, is the user's to fix, not a Git failure.
    if (error instanceof WtmConfigError) {
      return failure([{ code: error.code, message: error.message, severity: error.severity, context: { ...error.context } }]);
    }
    return failure([gitFailure(error)]);
  } finally {
    store.close();
  }
}

/**
 * Core cannot know the branch or the names the caller gave, so the `--resume` it suggests for an
 * abandoned lease is the bare `wtm create --resume`, which the CLI cannot run. Handing the
 * caller's own branch and `--repos` back makes it runnable, as `remove` does with its selector.
 */
function runnableResume(remediation: Remediation, branch: string, repos: readonly string[] | undefined): Remediation {
  const [program, command] = remediation.argv;
  if (program !== 'wtm' || command !== 'create' || !remediation.argv.includes('--resume')) return remediation;
  return { ...remediation, argv: resumeArgv(branch, repos) };
}

function resumeArgv(branch: string, repos: readonly string[] | undefined): string[] {
  return repos === undefined
    ? ['wtm', 'create', branch, '--resume']
    : ['wtm', 'create', branch, '--repos', repos.join(','), '--resume'];
}

async function createFresh(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  workspace: WorkspaceRecord,
  repositories: readonly RepositoryRecord[],
  branch: string,
  open: FeatureCreationRecord | null,
): Promise<Envelope> {
  // Defensive only: the CLI routes a create here without `--resume` only when `--repos` was given.
  if (input.repos === undefined) throw new TypeError('A multi-repository create without --resume needs --repos');
  const config = await resolveWorkspaceConfig({ workspaceRoot: workspace.root, globalConfigPath: input.globalConfigPath });
  const resolution = resolveFeatureMembers({ config: config.value, workspaceRoot: workspace.root, repositories, names: input.repos });
  if (resolution.outcome === 'refused') return failure([resolution.error]);

  // An open creation that wrote nothing may be replaced; one that wrote anything must be resumed.
  let supersedeCreationId: string | undefined;
  if (open !== null) {
    if (!open.members.every((member) => member.phase === 'PLANNED')) return failure([openCreationConflict(branch, open)]);
    supersedeCreationId = open.id;
  }

  const planInput = { workspaceRoot: workspace.root, branch, from: input.from, pathExists: existsSync };
  const first = planFeatureCreation({ ...planInput, members: await measure(resolution.repositories, branch, input.from) });
  if (first.outcome === 'refused') return failure(first.errors);

  return await withRepositoryOperationLeases({
    store,
    readProcessStartTime: input.readProcessStartTime,
    hostId: input.hostId,
    repositoryIds: resolution.repositories.map(({ id }) => id),
    operation: 'create',
  }, async (leases) => {
    await input.afterLeases?.();
    // A creation over a different member set takes different leases, so the open creation this
    // run planned against can still change before its leases are held.
    if (!sameOpenCreation(open, readOpen(store, workspace, branch))) return failure([openCreationChanged(branch)]);
    // Measured again under the leases: a branch checked out or a path filled since planning is
    // refused here, before the journal exists and before Git writes.
    const second = planFeatureCreation({ ...planInput, members: await measure(resolution.repositories, branch, input.from) });
    if (second.outcome === 'refused') return failure(second.errors);
    let creation: FeatureCreationRecord;
    try {
      creation = store.beginFeatureCreation({
        workspaceId: workspace.id,
        branch: `refs/heads/${branch}`,
        fromRef: input.from ?? null,
        members: second.members.map((member) => ({
          repositoryId: member.repository.id,
          repositoryMainRoot: member.repository.mainRoot,
          position: member.position,
          worktreePath: member.plan.path,
          branchExisted: member.branchExisted,
          startOid: member.startOid,
        })),
        ...(supersedeCreationId === undefined ? {} : { supersedeCreationId }),
      });
    } catch (error) {
      // The one-open-creation index, or the supersede guard, refusing a creation another process
      // opened or advanced in the moment since the re-read above. Nothing was journalled.
      if (isConstraintViolation(error) || !sameOpenCreation(open, readOpen(store, workspace, branch))) {
        return failure([openCreationChanged(branch)]);
      }
      throw error;
    }
    const work = second.members.map((member): MemberWork => ({
      repository: member.repository, plan: member.plan, worktree: null, alreadyRegistered: false,
    }));
    return await applyAndRegister(input, store, leases, creation, branch, work, false, new Map());
  });
}

async function resume(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  workspace: WorkspaceRecord,
  repositories: readonly RepositoryRecord[],
  branch: string,
  open: FeatureCreationRecord | null,
): Promise<Envelope> {
  if (open === null) {
    const nothing = `There is no unfinished creation of ${branch} in this workspace to resume.`;
    if (input.repos === undefined) return failure([configInvalid(nothing, { branch })]);
    return await clearAbandonedCreateLeases(input, store, workspace, repositories, branch, nothing);
  }
  if (input.from !== undefined) {
    return failure([configInvalid('--from cannot be combined with --resume: the start commits were pinned when the creation began.', { branch, from: input.from })]);
  }
  const byId = new Map(repositories.map((repository) => [repository.id, repository]));
  if (input.repos !== undefined) {
    const config = await resolveWorkspaceConfig({ workspaceRoot: workspace.root, globalConfigPath: input.globalConfigPath });
    const resolution = resolveFeatureMembers({ config: config.value, workspaceRoot: workspace.root, repositories, names: input.repos });
    if (resolution.outcome === 'refused') return failure([resolution.error]);
    const given = resolution.repositories.map(({ id }) => id).sort();
    const journalled = open.members.map(({ repositoryId }) => repositoryId).sort();
    if (given.join('\n') !== journalled.join('\n')) {
      return failure([configInvalid('--repos does not match the creation being resumed.', {
        branch,
        given: resolution.repositories.map(({ mainRoot }) => mainRoot),
        journalled: open.members.map(({ repositoryMainRoot }) => repositoryMainRoot),
      })]);
    }
  }
  // Before any lease, and only for members with work left: a REGISTERED member needs nothing from
  // its repository, so a repository forgotten after it registered does not block the rest.
  const forgotten = open.members.filter((member) => member.phase !== 'REGISTERED' && !byId.has(member.repositoryId));
  if (forgotten.length > 0) {
    return failure(forgotten.map((member) => {
      const action = classifyMemberRecovery({ member, branch, repositoryRegistered: false, topology: [], branchOid: null, pathExists: false });
      return action.action === 'refuse' ? action.error : configInvalid('A member repository is no longer registered.', { branch });
    }));
  }
  // The lease table's foreign key rejects a lease on a forgotten repository, so only members whose
  // repository is still registered are leased.
  const leased = open.members.filter((member) => byId.has(member.repositoryId)).map(({ repositoryId }) => repositoryId);
  // Every member REGISTERED and every repository forgotten leaves nothing to lease or do.
  if (leased.length === 0) {
    return await finishWithoutLeases(input, store, open, branch);
  }

  return await withRepositoryOperationLeases({
    store,
    readProcessStartTime: input.readProcessStartTime,
    hostId: input.hostId,
    repositoryIds: leased,
    operation: 'create',
    adopt: true,
  }, async (leases) => {
    await input.afterLeases?.();
    // Classified against the journal as it stands under the leases, not as it stood before them.
    if (!sameOpenCreation(open, readOpen(store, workspace, branch))) return failure([openCreationChanged(branch)]);
    const recovered = new Map<string, FeatureCreationPhase>();
    const existing = new Map<string, GitWorktreeRecord>();
    const work: MemberWork[] = [];
    for (const member of open.members) {
      const repository = byId.get(member.repositoryId);
      if (repository === undefined) {
        // Only a REGISTERED member reaches here (the pre-check refused the rest): nothing to do,
        // and no repository to ask about its worktree.
        recovered.set(member.repositoryId, member.phase);
        work.push({
          repository: { id: member.repositoryId, mainRoot: member.repositoryMainRoot },
          plan: null, worktree: null, alreadyRegistered: true,
        });
        continue;
      }
      const topology = await listGitWorktrees(repository.mainRoot);
      const action = classifyMemberRecovery({
        member, branch, repositoryRegistered: true, topology,
        branchOid: await resolveCommit(repository.mainRoot, `refs/heads/${branch}`),
        pathExists: existsSync(member.worktreePath),
      });
      if (action.action === 'refuse') {
        return failure([action.error], envelopeData(store, open.id, existing, null, true, recovered));
      }
      recovered.set(member.repositoryId, member.phase);
      if (action.action === 'skip') {
        const at = topology.find((record) => resolve(record.path) === resolve(member.worktreePath));
        if (at !== undefined) existing.set(member.repositoryId, at);
        work.push({ repository, plan: null, worktree: at ?? null, alreadyRegistered: true });
      } else if (action.action === 'mark-applied') {
        store.advanceCreationMember(open.id, member.repositoryId, 'APPLIED', null);
        existing.set(member.repositoryId, action.worktree);
        work.push({ repository, plan: null, worktree: action.worktree, alreadyRegistered: false });
      } else {
        work.push({ repository, plan: action.plan, worktree: null, alreadyRegistered: false });
      }
    }
    return await applyAndRegister(input, store, leases, open, branch, work, true, recovered);
  });
}

/**
 * `--resume --repos …` with no open creation. A process killed after taking its `create` leases
 * but before journalling leaves lease rows and no creation, so a fresh `create` is refused as
 * abandoned and `--resume` has nothing to resume. Taking the leases with adoption and releasing
 * them at once clears those rows, exactly as `remove --resume` clears an abandoned `remove`; the
 * command still refuses, because there was nothing to resume.
 */
async function clearAbandonedCreateLeases(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  workspace: WorkspaceRecord,
  repositories: readonly RepositoryRecord[],
  branch: string,
  nothing: string,
): Promise<Envelope> {
  const config = await resolveWorkspaceConfig({ workspaceRoot: workspace.root, globalConfigPath: input.globalConfigPath });
  const resolution = resolveFeatureMembers({ config: config.value, workspaceRoot: workspace.root, repositories, names: input.repos ?? [] });
  if (resolution.outcome === 'refused') return failure([resolution.error]);
  const held = resolution.repositories.filter(({ id }) => store.listRepositoryOperationLeases(id).some(({ operation }) => operation === 'create'));
  await withRepositoryOperationLeases({
    store,
    readProcessStartTime: input.readProcessStartTime,
    hostId: input.hostId,
    repositoryIds: resolution.repositories.map(({ id }) => id),
    operation: 'create',
    adopt: true,
  }, async () => {});
  // The acquisition succeeded, so every `create` row seen before it is gone: a live holder would
  // have refused it.
  const cleared = held.map(({ mainRoot }) => mainRoot);
  return failure([configInvalid(
    cleared.length === 0 ? nothing : `${nothing} The abandoned create lease on ${cleared.join(', ')} was cleared, so a new create can start.`,
    { branch, ...(cleared.length === 0 ? {} : { clearedLeases: cleared }) },
  )]);
}

/**
 * A resume whose every member is REGISTERED and whose every repository is forgotten: a creation
 * that finished registering but was never marked COMPLETED. Nothing is leased or written to Git.
 */
async function finishWithoutLeases(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  open: FeatureCreationRecord,
  branch: string,
): Promise<Envelope> {
  const recovered = new Map(open.members.map((member) => [member.repositoryId, member.phase] as const));
  const work = open.members.map((member): MemberWork => ({
    repository: { id: member.repositoryId, mainRoot: member.repositoryMainRoot },
    plan: null, worktree: null, alreadyRegistered: true,
  }));
  return await applyAndRegister(input, store, null, open, branch, work, true, recovered);
}

async function applyAndRegister(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  leases: RepositoryOperationLeasesSession | null,
  creation: FeatureCreationRecord,
  branch: string,
  work: readonly MemberWork[],
  resumed: boolean,
  recovered: ReadonlyMap<string, FeatureCreationPhase>,
): Promise<Envelope> {
  const apply = input.applyWorktree ?? createWorktree;
  const worktrees = new Map<string, GitWorktreeRecord>();
  const postCheckoutFailures: WtmError[] = [];
  for (const item of work) {
    if (item.worktree !== null) worktrees.set(item.repository.id, item.worktree);
    if (item.plan === null) continue;
    const plan = item.plan;
    try {
      leases?.renewAll();
    } catch (error) {
      // The journal exists, so what is done so far is reported and the caller can resume.
      return failure(
        [withResume({
          code: 'WTM_OPERATION_CONFLICT',
          message: `${message(error)} Another wtm process took over this creation's repositories; nothing more was written.`,
          severity: 'error',
          context: { branch, creationId: creation.id },
        }, branch)],
        envelopeData(store, creation.id, worktrees, null, resumed, recovered),
      );
    }
    store.advanceCreationMember(creation.id, item.repository.id, 'APPLYING', null);
    try {
      const { worktree: record, postCheckoutFailure } = await apply(item.repository.mainRoot, plan);
      if (record.branch !== plan.branchRef) {
        throw new Error(`git worktree add left ${plan.path} on ${String(record.branch)}, not on ${plan.branchRef}.`);
      }
      if (plan.createsBranch && record.head !== plan.startPoint) {
        throw new Error(`git worktree add started ${plan.branch} at ${String(record.head)}, not at the pinned ${String(plan.startPoint)}.`);
      }
      store.advanceCreationMember(creation.id, item.repository.id, 'APPLIED', null);
      worktrees.set(item.repository.id, record);
      if (postCheckoutFailure !== null) {
        // The branch and worktree are real and usable -- `apply` only returns instead of throwing
        // once it has confirmed that from the topology itself -- but git still reported
        // `worktree add` as failed, most often a failing `post-checkout` hook.
        postCheckoutFailures.push({
          code: 'GIT_COMMAND_FAILED',
          message: `The worktree in ${item.repository.mainRoot} was created at ${record.path}, but `
            + `git worktree add reported a failure while finishing it: ${message(postCheckoutFailure)}`,
          severity: 'warning',
          context: { path: record.path, repository: item.repository.mainRoot, command: postCheckoutFailure.argv.join(' ') },
        });
      }
    } catch (error) {
      const cause = gitFailure(error);
      const after = await listGitWorktrees(item.repository.mainRoot).catch(() => null);
      // Only a topology that provably lacks the worktree returns the member to PLANNED. Anything
      // less leaves it APPLYING, and --resume inspects it instead of trusting either answer.
      if (after !== null && !after.some((record) => resolve(record.path) === resolve(plan.path))) {
        store.advanceCreationMember(creation.id, item.repository.id, 'PLANNED', cause.code);
      }
      return failure(
        [withResume({ ...cause, context: { ...(cause.context ?? {}), repository: item.repository.mainRoot, path: plan.path } }, branch)],
        envelopeData(store, creation.id, worktrees, null, resumed, recovered),
      );
    }
  }

  const registration: CreateRegistration = await reconciledByDaemon(input.client) ? 'daemon' : 'local';
  const topologyOf = input.registrationTopology ?? listGitWorktrees;
  const failures: WtmError[] = [];
  const registeredLocally: string[] = [];
  for (const item of work) {
    if (item.alreadyRegistered) continue;
    if (registration === 'local') {
      try {
        store.reconcileWorktrees(item.repository.id, await topologyOf(item.repository.mainRoot));
      } catch (error) {
        failures.push(withResume({
          code: 'GIT_REPOSITORY_DEGRADED',
          message: `The worktree in ${item.repository.mainRoot} was created but could not be registered: ${message(error)}`,
          severity: 'error',
          context: { repository: item.repository.mainRoot },
        }, branch));
        continue;
      }
      const path = worktrees.get(item.repository.id)?.path;
      if (path !== undefined) registeredLocally.push(path);
    }
    store.advanceCreationMember(creation.id, item.repository.id, 'REGISTERED', null);
  }
  // Only about the worktrees this run registered itself: one registered by an earlier run, or
  // one whose registration just failed, did not skip its hooks here.
  const warnings: WtmError[] = [
    ...postCheckoutFailures,
    ...(registeredLocally.length > 0 ? [{
      code: 'WTM_DAEMON_UNAVAILABLE' as const,
      message: 'The daemon is unreachable, so these worktrees were registered locally. Their '
        + '`worktree.created` tasks did not run and `[prepare] mode = "eager"` did not prepare their '
        + 'resources; the first task you run in each prepares them.',
      severity: 'warning' as const,
      context: { paths: registeredLocally },
    }] : []),
  ];
  if (failures.length > 0) {
    return { ...failure(failures, envelopeData(store, creation.id, worktrees, registration, resumed, recovered)), warnings };
  }
  store.completeFeatureCreation(creation.id);
  return {
    schemaVersion: 1,
    ok: true,
    command: 'create',
    scope: { mode: 'local' },
    data: envelopeData(store, creation.id, worktrees, registration, resumed, recovered),
    warnings,
    errors: [],
  };
}

async function measure(repositories: readonly RepositoryRecord[], branch: string, from: string | undefined): Promise<FeatureMemberMeasurement[]> {
  return await Promise.all(repositories.map(async (repository) => ({
    repository,
    topology: await listGitWorktrees(repository.mainRoot),
    branchOid: await resolveCommit(repository.mainRoot, `refs/heads/${branch}`),
    fromOid: from === undefined ? null : await resolveCommit(repository.mainRoot, from),
  })));
}

function readOpen(store: SQLiteStateStore, workspace: WorkspaceRecord, branch: string): FeatureCreationRecord | null {
  return store.readOpenFeatureCreation(workspace.id, `refs/heads/${branch}`);
}

/** The same open creation, with every member at the same phase: nothing another process did shows. */
function sameOpenCreation(before: FeatureCreationRecord | null, now: FeatureCreationRecord | null): boolean {
  if (before === null || now === null) return before === now;
  if (before.id !== now.id || before.members.length !== now.members.length) return false;
  const phases = new Map(now.members.map((member) => [member.repositoryId, member.phase]));
  return before.members.every((member) => phases.get(member.repositoryId) === member.phase);
}

function isConstraintViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

function envelopeData(
  store: SQLiteStateStore,
  creationId: string,
  worktrees: ReadonlyMap<string, GitWorktreeRecord>,
  registration: CreateRegistration | null,
  resumed: boolean,
  recovered: ReadonlyMap<string, FeatureCreationPhase>,
): FeatureCreateCommandData {
  const record = store.readFeatureCreation(creationId)!;
  return {
    feature: { id: record.feature.id, branch: record.feature.branch },
    members: record.members.map((member) => {
      const worktree = worktrees.get(member.repositoryId) ?? null;
      const from = recovered.get(member.repositoryId);
      return {
        repository: { id: member.repositoryId, mainRoot: member.repositoryMainRoot },
        worktree: worktree === null ? null : { path: worktree.path, branch: worktree.branch, head: worktree.head },
        branch: { name: shortBranch(record.feature.branch), created: !member.branchExisted, startPoint: member.startOid },
        phase: member.phase,
        ...(from === undefined ? {} : { recoveredFrom: from }),
      };
    }),
    registration,
    resumed,
  };
}

function openCreationConflict(branch: string, open: FeatureCreationRecord): WtmError {
  return {
    code: 'WTM_OPERATION_CONFLICT',
    message: `A creation of ${branch} that started at ${open.createdAt} has not finished. Resume it instead of starting another.`,
    severity: 'error',
    context: {
      branch,
      creationId: open.id,
      members: open.members.map(({ repositoryMainRoot, phase }) => ({ repository: repositoryMainRoot, phase })),
    },
    remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'create', branch, '--resume'] }],
  };
}

function openCreationChanged(branch: string): WtmError {
  return {
    code: 'WTM_OPERATION_CONFLICT',
    message: `Another wtm process changed the unfinished creation of ${branch} while this one was taking its leases. `
      + 'Nothing was written; run the command again.',
    severity: 'error',
    context: { branch },
  };
}

function withResume(error: WtmError, branch: string): WtmError {
  return { ...error, remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'create', branch, '--resume'] }] };
}

function configInvalid(text: string, context: Record<string, unknown>): WtmError {
  return { code: 'WTM_CONFIG_INVALID', message: text, severity: 'error', context };
}

function shortBranch(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

function failure(errors: readonly WtmError[], data: FeatureCreateCommandData | null = null): Envelope {
  const [first, ...rest] = errors;
  if (first === undefined) throw new TypeError('A failed create must report at least one error');
  return {
    schemaVersion: 1,
    ok: false,
    command: 'create',
    scope: { mode: 'local' },
    data,
    warnings: [],
    errors: [first, ...rest],
  };
}
