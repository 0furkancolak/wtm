import {
  resolveTask,
  type DaemonStateStore,
  type LifecycleEventStore,
  type LifecycleEventSubject,
  type ReconcileResult,
  type RepositoryRecord,
  type WorktreeRecord,
} from '@wtm/core';
import type { ManagedProcessStartInput } from './process-supervisor';
import {
  prepareRuntimeResources,
  resolveWorktreeRuntime,
  taskResolutionInput,
  type WorktreeRuntime,
} from './task-resolution';

/**
 * The lifecycle events `[events."<name>"]` can be attached to.
 *
 * Every one of these was accepted by the configuration schema and dispatched by nothing, so a
 * workspace could write `[events."worktree.created"] tasks = ["deps.install"]`, see it
 * validate, and never find out that no dependency was ever installed.
 */
export const lifecycleEventNames = [
  'workspace.discovered',
  'repo.discovered',
  'worktree.discovered',
  'worktree.created',
  'worktree.ready',
  'worktree.removed',
  'runtime.started',
  'runtime.stopped',
] as const;

export type LifecycleEventName = typeof lifecycleEventNames[number];

/** Events that describe something that happens to a subject exactly once in its life. */
const onceOnlyEvents = new Set<LifecycleEventName>([
  'workspace.discovered',
  'repo.discovered',
  'worktree.discovered',
  'worktree.created',
  'worktree.ready',
]);

export interface LifecycleEventDispatch {
  event: LifecycleEventName;
  /** The worktree the configured tasks are run in. */
  worktree: WorktreeRecord;
  /** What the once-only claim is recorded against, when the event is once-only. */
  subject?: { type: LifecycleEventSubject; id: string };
}

export interface LifecycleEventDispatcherOptions {
  store: DaemonStateStore & LifecycleEventStore;
  globalConfigPath: string;
  /** How a configured task is run. In production this is the supervisor's own `start`. */
  start(input: ManagedProcessStartInput): Promise<unknown>;
  onError?(error: unknown): void;
  /** Test seam: the resolved runtime for a worktree, allocating endpoints only when asked. */
  runtimeFor?(worktreePath: string, allocate: boolean): Promise<WorktreeRuntime>;
}

/** One task an event asked for, and what became of it. */
export interface LifecycleTaskOutcome {
  task: string;
  started: boolean;
  error?: string;
}

export interface LifecycleDispatchResult {
  event: LifecycleEventName;
  worktreeId: string;
  /** False when the event had already been announced for this subject. */
  announced: boolean;
  tasks: LifecycleTaskOutcome[];
}

/**
 * Runs the tasks a workspace attached to a lifecycle event.
 *
 * The rules are deliberately narrow, because an event that runs a command is the one part of
 * WTM that acts without anybody asking at that moment:
 *
 * - a once-only event is announced once per subject and recorded, so a daemon restart does not
 *   install dependencies again;
 * - a task started by an event never dispatches further events, so `runtime.started` bound to
 *   a task cannot start itself;
 * - a failure is reported and never propagated: an event that cannot run must not take the
 *   reconcile, and therefore every other workspace's daemon, down with it.
 */
export class LifecycleEventDispatcher {
  readonly #store: LifecycleEventDispatcherOptions['store'];
  readonly #globalConfigPath: string;
  readonly #start: LifecycleEventDispatcherOptions['start'];
  readonly #onError: (error: unknown) => void;
  readonly #runtimeFor: (worktreePath: string, allocate: boolean) => Promise<WorktreeRuntime>;

  constructor(options: LifecycleEventDispatcherOptions) {
    this.#store = options.store;
    this.#globalConfigPath = options.globalConfigPath;
    this.#start = options.start;
    this.#onError = options.onError ?? (() => {});
    this.#runtimeFor = options.runtimeFor ?? (async (worktreePath, allocate) => await resolveWorktreeRuntime({
      store: options.store,
      cwd: worktreePath,
      globalConfigPath: options.globalConfigPath,
      ...(allocate ? {} : { allocate: false }),
    }));
  }

  async dispatch(input: LifecycleEventDispatch): Promise<LifecycleDispatchResult> {
    const empty = { event: input.event, worktreeId: input.worktree.id, tasks: [] };
    // Claimed before the work rather than after it, so two passes cannot run one event twice.
    // A dispatch that then turns out to be impossible withdraws the claim on its way out.
    const subject = onceOnlyEvents.has(input.event)
      ? input.subject ?? { type: 'worktree' as const, id: input.worktree.id }
      : undefined;
    if (subject !== undefined
      && !this.#store.claimLifecycleEvent(subject.type, subject.id, input.event)) {
      return { ...empty, announced: false };
    }
    const withdraw = () => {
      if (subject !== undefined) this.#store.releaseLifecycleEvent(subject.type, subject.id, input.event);
    };

    // Read-only first. Finding out whether an event has anything attached must not lease a
    // port for a worktree nobody has run anything in: that is exactly what `lazy` promises not
    // to do, and every newly discovered worktree passes through here.
    let runtime: WorktreeRuntime;
    try {
      runtime = await this.#runtimeFor(input.worktree.path, false);
    } catch (error) {
      // Nothing was decided, so nothing has been announced. A configuration that does not
      // resolve today usually resolves once it is fixed, and the event should still fire then.
      withdraw();
      this.#onError(error);
      return { ...empty, announced: false };
    }
    const tasks = runtime.config.events?.[input.event]?.tasks ?? [];
    if (tasks.length === 0) return { ...empty, announced: true };

    // There is something to run, so it gets the ports and resources a task is owed.
    try {
      runtime = await this.#runtimeFor(input.worktree.path, true);
      await prepareRuntimeResources(runtime);
    } catch (error) {
      withdraw();
      this.#onError(error);
      return { ...empty, announced: false };
    }

    const outcomes: LifecycleTaskOutcome[] = [];
    for (const task of tasks) {
      try {
        const resolved = resolveTask(taskResolutionInput(runtime, task));
        await this.#start({
          worktreeId: input.worktree.id,
          taskName: task,
          argv: resolved.argv,
          cwd: resolved.cwd,
          env: { ...process.env, ...resolved.envDelta },
          shell: resolved.shell,
        });
        outcomes.push({ task, started: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#onError(new Error(`[events."${input.event}"] task ${task} did not start: ${message}`));
        outcomes.push({ task, started: false, error: message });
      }
    }
    return { event: input.event, worktreeId: input.worktree.id, announced: true, tasks: outcomes };
  }

  /**
   * `runtime.started` and `runtime.stopped`, for a task a person started through the daemon.
   * Tasks the dispatcher itself starts do not come through here, so an event bound to
   * `runtime.started` cannot set itself off.
   */
  async dispatchForWorktree(event: LifecycleEventName, worktreeId: string): Promise<void> {
    const worktree = this.#store.listWorktrees().find(({ id }) => id === worktreeId);
    if (worktree === undefined) return;
    try {
      await this.dispatch({ event, worktree });
    } catch (error) {
      this.#onError(error);
    }
  }

  /** The events one repository's reconcile produced, in the order they happened. */
  async onReconciled(repository: RepositoryRecord, result: ReconcileResult): Promise<void> {
    const firstReconcile = repository.lastReconciledAt === null;
    await this.#announceRegistration(repository, result);
    for (const worktree of result.discovered) {
      await this.dispatch({
        event: firstReconcile ? 'worktree.discovered' : 'worktree.created',
        worktree,
      });
      await this.prepareDiscovered(worktree);
    }
    for (const worktree of result.orphaned) {
      // A worktree that is gone cannot run anything; the event fires in the main worktree of
      // its repository, which is the only directory still there to run in.
      const host = this.#mainWorktree(repository.id);
      if (host === undefined) continue;
      await this.dispatch({ event: 'worktree.removed', worktree: host });
    }
  }

  /**
   * `[prepare] mode`. `lazy`, the default, leaves resource creation to the first task that
   * runs in the worktree, so twenty speculative branches cost nothing. `eager` does it as soon
   * as the worktree is known, which is what a workspace whose `.env` must exist before anybody
   * opens an editor asks for. Both were accepted; only `lazy` ever happened.
   */
  async prepareDiscovered(worktree: WorktreeRecord): Promise<void> {
    try {
      // Reading which mode is in force is a read, so it allocates nothing. Only `eager` then
      // resolves for real, because preparing is what needs the ports the templates may name.
      if ((await this.#runtimeFor(worktree.path, false)).config.prepare?.mode !== 'eager') return;
      await prepareRuntimeResources(await this.#runtimeFor(worktree.path, true));
    } catch (error) {
      this.#onError(error);
      return;
    }
    await this.dispatch({ event: 'worktree.ready', worktree });
  }

  /** `workspace.discovered` and `repo.discovered`, each announced once per subject. */
  async #announceRegistration(repository: RepositoryRecord, result: ReconcileResult): Promise<void> {
    const host = this.#mainWorktree(repository.id)
      ?? result.discovered[0]
      ?? result.updated[0];
    if (host === undefined) return;
    await this.dispatch({
      event: 'workspace.discovered',
      worktree: host,
      subject: { type: 'workspace', id: repository.workspaceId },
    });
    await this.dispatch({
      event: 'repo.discovered',
      worktree: host,
      subject: { type: 'repository', id: repository.id },
    });
  }

  #mainWorktree(repositoryId: string): WorktreeRecord | undefined {
    const worktrees = this.#store.listWorktrees(repositoryId)
      .filter(({ state }) => state !== 'ORPHANED' && state !== 'REMOVED');
    return worktrees.find(({ isMain }) => isMain) ?? worktrees[0];
  }
}
