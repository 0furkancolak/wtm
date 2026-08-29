import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import type {
  ManagedProcessRecord, ManagedProcessState, ManagedProcessInput, ManagedProcessQuery,
  ManagedProcessUpdate, ManagedProcessCreateOptions, ManagedProcessReservationOptions,
} from '@wtm/core';
import { ManagedLogStore, type PreparedManagedLogs } from './logs';

const execFileAsync = promisify(execFile);
const activeStates = ['STARTING', 'RUNNING', 'STOPPING'] as const;
const anchorProtocolTimeoutMs = 10_000;

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  processStartTime: string;
  commandFingerprint: string;
}

export type ProcessInspection =
  | { status: 'present'; identity: ProcessIdentity }
  | { status: 'absent' }
  | { status: 'failed'; reason: string };

export type ProcessGroupInspection =
  | { status: 'present'; pids: readonly number[] }
  | { status: 'absent' }
  | { status: 'failed'; reason: string };

export interface ManagedProcessStartInput {
  worktreeId: string;
  taskName: string;
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

export interface ManagedProcessStartResult { record: ManagedProcessRecord; existing: boolean }
export interface ManagedProcessSelector { worktreeId: string; taskName: string }

export interface ManagedProcessSupervisorOptions {
  stateStore: ManagedProcessStateStore;
  logs: ManagedLogStore;
  gracePeriodMs?: number;
  pollIntervalMs?: number;
  inspectProcess?: (pid: number) => Promise<ProcessInspection>;
  inspectProcessGroup?: (pgid: number) => Promise<ProcessGroupInspection>;
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  now?: () => Date;
  onError?: (error: unknown) => void;
  runtimeInvocation?: RuntimeInvocation;
  /** Test seam for exercising durable cleanup ownership when cooperative abort fails. */
  anchorIgnoresAbort?: boolean;
}

export interface RuntimeInvocation {
  executable: string;
  prefixArgs: readonly string[];
}

export interface ManagedProcessStateStore {
  createManagedProcess(input: ManagedProcessInput, options?: ManagedProcessCreateOptions): ManagedProcessRecord;
  getManagedProcess(id: string): ManagedProcessRecord | null;
  updateManagedProcess(id: string, update: ManagedProcessUpdate): ManagedProcessRecord | null;
  listManagedProcesses(query?: ManagedProcessQuery): ManagedProcessRecord[];
  findActiveManagedProcess(worktreeId: string, taskName: string): ManagedProcessRecord | null;
  reserveManagedProcessStart(
    worktreeId: string, taskName: string, token: string, createdAt: string,
    options?: ManagedProcessReservationOptions,
  ): boolean;
  releaseManagedProcessStart(worktreeId: string, taskName: string, token: string): boolean;
  releaseExpiredManagedProcessStart(worktreeId: string, taskName: string, now: string): boolean;
  releaseExpiredManagedProcessReplacement(record: ManagedProcessRecord, now: string): boolean;
  hasManagedProcessStartReservation(worktreeId: string, taskName: string): boolean;
}

interface OwnedChild {
  child: ChildProcess;
  exitListener: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
}

export class ManagedProcessError extends Error {
  readonly code: 'RUNTIME_TASK_NOT_RUNNING' | 'RUNTIME_PROCESS_IDENTITY_STALE'
    | 'RUNTIME_START_FAILED' | 'RUNTIME_STOP_FAILED';
  readonly context: Record<string, unknown>;

  constructor(code: ManagedProcessError['code'], message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ManagedProcessError';
    this.code = code;
    this.context = context;
  }
}

export class ManagedProcessSupervisor {
  readonly #stateStore: ManagedProcessStateStore;
  readonly #logs: ManagedLogStore;
  readonly #gracePeriodMs: number;
  readonly #pollIntervalMs: number;
  readonly #inspectProcess: (pid: number) => Promise<ProcessInspection>;
  readonly #inspectGroup: (pgid: number) => Promise<ProcessGroupInspection>;
  readonly #signalGroup: (pgid: number, signal: NodeJS.Signals) => void;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #anchorIgnoresAbort: boolean;
  readonly #runtimeInvocation: RuntimeInvocation;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #owned = new Map<string, OwnedChild>();
  #closed = false;

  constructor(options: ManagedProcessSupervisorOptions) {
    this.#stateStore = options.stateStore;
    this.#logs = options.logs;
    this.#gracePeriodMs = nonnegativeInteger(options.gracePeriodMs ?? 5_000, 'Process grace period');
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 25, 'Process poll interval');
    this.#inspectProcess = options.inspectProcess ?? inspectProcess;
    this.#inspectGroup = options.inspectProcessGroup ?? inspectProcessGroup;
    this.#signalGroup = options.signalProcessGroup ?? ((pgid, signal) => process.kill(-pgid, signal));
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => {});
    this.#anchorIgnoresAbort = options.anchorIgnoresAbort ?? false;
    this.#runtimeInvocation = options.runtimeInvocation ?? defaultRuntimeInvocation();
  }

  async start(input: ManagedProcessStartInput): Promise<ManagedProcessStartResult> {
    this.#assertOpen();
    return await this.#serialize(ownerKey(input.worktreeId, input.taskName), async () => this.#startLocked(input));
  }

  async stop(selector: ManagedProcessSelector): Promise<ManagedProcessRecord> {
    this.#assertOpen();
    return await this.#serialize(ownerKey(selector.worktreeId, selector.taskName), async () => {
      const record = this.#stateStore.findActiveManagedProcess(selector.worktreeId, selector.taskName);
      if (record === null) throw taskNotRunning(selector);
      return await this.#stopLocked(record);
    });
  }

  async stopRecord(record: ManagedProcessRecord): Promise<ManagedProcessRecord> {
    this.#assertOpen();
    return await this.#serialize(ownerKey(record.worktreeId, record.taskName), async () => {
      const current = this.#stateStore.getManagedProcess(record.id);
      if (current === null || !isActiveState(current.state)) return current ?? record;
      return await this.#stopLocked(current);
    });
  }

  async stopAll(worktreeId: string): Promise<ManagedProcessRecord[]> {
    const stopped: ManagedProcessRecord[] = [];
    for (const record of this.#stateStore.listManagedProcesses({ worktreeId, states: activeStates })) {
      stopped.push(await this.stopRecord(record));
    }
    return stopped;
  }

  async restart(input: ManagedProcessStartInput): Promise<ManagedProcessStartResult> {
    this.#assertOpen();
    return await this.#serialize(ownerKey(input.worktreeId, input.taskName), async () => {
      const token = randomUUID();
      const existing = this.#stateStore.findActiveManagedProcess(input.worktreeId, input.taskName);
      const acquiredAt = this.#now().toISOString();
      if (!this.#stateStore.reserveManagedProcessStart(
        input.worktreeId,
        input.taskName,
        token,
        acquiredAt,
        {
          expiresAt: reservationExpiry(acquiredAt),
          ...(existing === null ? {} : { replaceProcessId: existing.id }),
        },
      )) {
        throw new ManagedProcessError('RUNTIME_START_FAILED', 'Managed task restart is already in progress.', {
          worktreeId: input.worktreeId, taskName: input.taskName, reason: 'START_CONFLICT',
        });
      }
      try {
        if (existing !== null) await this.#stopLocked(existing);
        const result = await this.#spawn(input, token);
        this.#stateStore.releaseManagedProcessStart(input.worktreeId, input.taskName, token);
        return result;
      } catch (error) {
        if (error instanceof DurableCleanupOwnershipError) throw error;
        this.#stateStore.releaseManagedProcessStart(input.worktreeId, input.taskName, token);
        throw error;
      }
    });
  }

  list(worktreeId?: string): ManagedProcessRecord[] {
    return this.#stateStore.listManagedProcesses(worktreeId === undefined ? {} : { worktreeId });
  }

  async recover(): Promise<ManagedProcessRecord[]> {
    this.#assertOpen();
    const recovered: ManagedProcessRecord[] = [];
    const candidates = this.#stateStore.listManagedProcesses()
      .filter((record) => isActiveState(record.state) || record.cleanupRequired);
    for (const record of candidates) {
      const inspection = await inspectWithRetry(
        record.pid,
        this.#inspectProcess,
        Math.min(this.#gracePeriodMs, 250),
        this.#pollIntervalMs,
      );
      if (inspection.status === 'present' && identityMatches(record, inspection.identity)) {
        const launchedStarting = record.state === 'STARTING'
          && await this.#logs.hasLaunchAcknowledgement(record.stdoutPath, record.pid);
        if (record.cleanupRequired && (record.state === 'FAILED' || !launchedStarting && record.state === 'STARTING')) {
          const cleaned = await this.#terminateCleanupOwned(record);
          if (cleaned) {
            recovered.push(this.#transition(record, 'FAILED', false));
            this.#releaseReservationAfterRecovery(record);
          } else {
            recovered.push(record);
          }
        } else if (record.state === 'STOPPING') {
          try { recovered.push(await this.#stopLocked(record)); }
          catch { recovered.push(this.#stateStore.getManagedProcess(record.id) ?? record); }
        } else {
          await this.#logs.recover(record.stdoutPath, record.stderrPath);
          recovered.push(this.#transition(record, 'RUNNING', false));
          this.#releaseReservationAfterRecovery(record);
        }
      } else if (inspection.status === 'absent') {
        const group = await this.#inspectGroup(record.pgid);
        if (group.status === 'absent') {
          recovered.push(this.#transition(
            record,
            record.state === 'FAILED' ? 'FAILED' : 'STOPPED',
            false,
          ));
          this.#releaseReservationAfterRecovery(record);
        } else {
          recovered.push(this.#transition(record, 'FAILED', true));
        }
      } else if (inspection.status === 'present') {
        recovered.push(record.state === 'FAILED'
          ? this.#transition(record, 'FAILED', false)
          : this.#transition(record, 'STALE_IDENTITY', false));
        this.#releaseReservationAfterRecovery(record);
      } else {
        recovered.push(this.#transition(record, 'FAILED', true));
      }
    }
    return recovered;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const owned = [...this.#owned.values()];
    this.#owned.clear();
    await Promise.allSettled(owned.map(async ({ child, exitListener }) => {
      child.off('exit', exitListener);
      child.unref();
    }));
    await this.#logs.close();
  }

  async #startLocked(input: ManagedProcessStartInput): Promise<ManagedProcessStartResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      const acquiredAt = this.#now().toISOString();
      if (this.#stateStore.reserveManagedProcessStart(
        input.worktreeId,
        input.taskName,
        token,
        acquiredAt,
        { expiresAt: reservationExpiry(acquiredAt) },
      )) {
        try {
          const result = await this.#spawn(input, token);
          this.#stateStore.releaseManagedProcessStart(input.worktreeId, input.taskName, token);
          return result;
        } catch (error) {
          if (!(error instanceof DurableCleanupOwnershipError)) {
            this.#stateStore.releaseManagedProcessStart(input.worktreeId, input.taskName, token);
          }
          throw error;
        }
      }
      if (this.#stateStore.hasManagedProcessStartReservation(input.worktreeId, input.taskName)) {
        const existing = this.#stateStore.findActiveManagedProcess(input.worktreeId, input.taskName);
        if (existing?.state === 'RUNNING' && !existing.cleanupRequired) {
          const inspection = await this.#inspectProcess(existing.pid);
          if (inspection.status === 'present' && identityMatches(existing, inspection.identity)) {
            if (this.#releaseReservationAfterRecovery(existing)) {
              return { record: existing, existing: true };
            }
            if (this.#stateStore.releaseExpiredManagedProcessReplacement(
              existing,
              this.#now().toISOString(),
            )) return { record: existing, existing: true };
          }
        }
        throw new ManagedProcessError('RUNTIME_START_FAILED', 'Managed task lifecycle operation is already in progress.', {
          worktreeId: input.worktreeId, taskName: input.taskName, reason: 'START_CONFLICT',
        });
      }
      const existing = this.#stateStore.findActiveManagedProcess(input.worktreeId, input.taskName);
      if (existing === null) { await delay(this.#pollIntervalMs); continue; }
      if (existing.state === 'STOPPING') {
        throw new ManagedProcessError('RUNTIME_START_FAILED', 'Managed task lifecycle operation is already in progress.', {
          worktreeId: input.worktreeId, taskName: input.taskName, reason: 'START_CONFLICT',
        });
      }
      const inspection = await this.#inspectProcess(existing.pid);
      if (inspection.status === 'present' && identityMatches(existing, inspection.identity)) {
        return { record: this.#transition(existing, 'RUNNING'), existing: true };
      }
      if (inspection.status === 'present') {
        this.#transition(existing, 'STALE_IDENTITY');
        continue;
      }
      if (inspection.status === 'absent') {
        const group = await this.#inspectGroup(existing.pgid);
        this.#transition(existing, group.status === 'absent' ? 'STOPPED' : 'FAILED');
        continue;
      }
      throw new ManagedProcessError('RUNTIME_START_FAILED', 'Managed process identity could not be inspected.', {
        worktreeId: input.worktreeId, taskName: input.taskName, reason: inspection.reason,
      });
    }
    throw new ManagedProcessError('RUNTIME_START_FAILED', 'Managed task start is already in progress.', {
      worktreeId: input.worktreeId, taskName: input.taskName, reason: 'START_CONFLICT',
    });
  }

  async #spawn(input: ManagedProcessStartInput, reservationToken: string): Promise<ManagedProcessStartResult> {
    if (input.argv[0] === undefined || input.argv[0].length === 0) throw startFailure(input, new Error('EMPTY_COMMAND'));
    const logs = await this.#logs.prepare(input.worktreeId, input.taskName);
    let child: ChildProcess;
    try {
      child = await spawnAnchor({
        input,
        logs,
        ignoreAbort: this.#anchorIgnoresAbort,
        runtimeInvocation: this.#runtimeInvocation,
      });
    } catch (error) {
      throw startFailure(input, error);
    }
    const pid = child.pid;
    if (pid === undefined) throw startFailure(input, new Error('NO_PID'));

    let pendingExit: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
    let recordId: string | null = null;
    const exitListener = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (recordId === null) pendingExit = { exitCode, signal };
      else void this.#recordExit(recordId, input.worktreeId, input.taskName, exitCode, signal);
    };
    child.once('exit', exitListener);

    const handshake = child.stdout;
    const control = child.stdin;
    const readyIdentity = await waitForAnchorHandshake(handshake, child, () => pendingExit !== null);
    if (readyIdentity === null || readyIdentity.pid !== pid || readyIdentity.pgid !== pid) {
      child.off('exit', exitListener);
      await this.#rollbackSpawn(child, pid, control, null, logs);
      throw startFailure(input, new Error('ANCHOR_HANDSHAKE_INVALID'));
    }
    const identity = readyIdentity;

    let record: ManagedProcessRecord | null = null;
    try {
      record = this.#stateStore.createManagedProcess({
        worktreeId: input.worktreeId, taskName: input.taskName, ...identity,
        state: 'STARTING', startedAt: this.#now().toISOString(), stoppedAt: null,
        stdoutPath: logs.stdoutPath, stderrPath: logs.stderrPath, cleanupRequired: true,
        cleanupOwnerToken: reservationToken,
      }, { reservationToken });
      recordId = record.id;
      this.#owned.set(record.id, { child, exitListener });
      const inspection = await waitForIdentity(pid, this.#inspectProcess, this.#pollIntervalMs, () => pendingExit !== null);
      if (inspection.status !== 'present') {
        throw new Error(inspection.status === 'failed' ? inspection.reason : 'ANCHOR_EXITED');
      }
      if (!sameIdentity(identity, inspection.identity)) throw new Error('ANCHOR_IDENTITY_MISMATCH');
      await sendAnchorCommand(control, 'GO');
      const launch = await waitForLaunchAck(child.stderr, child, () => pendingExit !== null);
      if (!launch.ok) throw new Error(launch.reason);
      record = this.#stateStore.updateManagedProcess(record.id, {
        expectedStates: ['STARTING'], state: 'RUNNING', stoppedAt: null,
        cleanupRequired: false, reservationToken,
      });
      if (record === null) throw new Error('START_TRANSITION_LOST');
    } catch (error) {
      child.off('exit', exitListener);
      if (recordId !== null) this.#owned.delete(recordId);
      let cleanupError: unknown;
      try { await this.#rollbackSpawn(child, pid, control, identity, logs); }
      catch (cleanupFailure) { cleanupError = cleanupFailure; }
      let repairError: unknown;
      if (recordId !== null) {
        const current = this.#stateStore.getManagedProcess(recordId);
        if (current !== null && isActiveState(current.state)) {
          try { this.#transition(current, 'FAILED', cleanupError !== undefined); }
          catch (failure) { repairError = failure; }
        }
      }
      if (cleanupError !== undefined || repairError !== undefined) {
        if (recordId === null) {
          try {
            this.#stateStore.createManagedProcess({
              worktreeId: input.worktreeId,
              taskName: input.taskName,
              ...identity,
              state: 'FAILED',
              startedAt: this.#now().toISOString(),
              stoppedAt: this.#now().toISOString(),
              stdoutPath: logs.stdoutPath,
              stderrPath: logs.stderrPath,
              cleanupRequired: true,
              cleanupOwnerToken: reservationToken,
            }, { reservationToken });
          } catch (durabilityError) { repairError = durabilityError; }
        }
        throw new DurableCleanupOwnershipError(input, cleanupError ?? repairError);
      }
      throw startFailure(input, error);
    }
    if (pendingExit !== null) {
      const outcome = pendingExit as { exitCode: number | null; signal: NodeJS.Signals | null };
      await this.#recordExit(record.id, input.worktreeId, input.taskName, outcome.exitCode, outcome.signal);
      record = this.#stateStore.getManagedProcess(record.id) ?? record;
    }
    return { record, existing: false };
  }

  async #rollbackSpawn(
    child: ChildProcess,
    pgid: number,
    control: Writable | null,
    expectedIdentity: ProcessIdentity | null,
    _logs: PreparedManagedLogs,
  ): Promise<void> {
    try {
      await sendAnchorCommand(control, 'ABORT').catch(() => {});
      if (await waitForChildExit(
        child,
        expectedIdentity === null ? anchorProtocolTimeoutMs : this.#gracePeriodMs,
      )) return;
      if (expectedIdentity === null) throw new Error('ROLLBACK_IDENTITY_UNAVAILABLE');
      const inspected = await this.#inspectProcess(pgid);
      if (inspected.status === 'failed') throw new Error('ROLLBACK_INSPECTION_FAILED');
      if (inspected.status === 'absent') return;
      if (!sameIdentity(expectedIdentity, inspected.identity)) throw new Error('ROLLBACK_IDENTITY_STALE');
      this.#signalGroup(expectedIdentity.pgid, 'SIGKILL');
      const group = await waitForGroupAbsent(
        expectedIdentity.pgid, this.#inspectGroup, this.#gracePeriodMs, this.#pollIntervalMs,
      );
      if (group !== 'gone') throw new Error(group === 'failed' ? 'ROLLBACK_INSPECTION_FAILED' : 'ROLLBACK_GROUP_ALIVE');
    } finally {
      control?.destroy();
      child.unref();
    }
  }

  async #stopLocked(record: ManagedProcessRecord): Promise<ManagedProcessRecord> {
    const stopping = record.state === 'STOPPING' ? record : this.#transition(record, 'STOPPING');
    try {
      const inspected = await inspectWithRetry(
        stopping.pid,
        this.#inspectProcess,
        Math.min(this.#gracePeriodMs, 250),
        this.#pollIntervalMs,
      );
      if (inspected.status === 'failed') throw new Error(inspected.reason);
      if (inspected.status === 'absent') {
        const group = await this.#inspectGroup(stopping.pgid);
        if (group.status === 'failed') throw new Error(group.reason);
        if (group.status === 'present') throw new Error('OWNERSHIP_ANCHOR_MISSING');
        return this.#transition(stopping, 'STOPPED');
      }
      if (!identityMatches(stopping, inspected.identity)) return this.#transition(stopping, 'STALE_IDENTITY');

      try { this.#signalGroup(stopping.pgid, 'SIGTERM'); }
      catch (error) { if (!isNoSuchProcess(error)) throw error; }
      const termResult = await waitForOwnedGroupChange(
        stopping, this.#inspectProcess, this.#inspectGroup, this.#gracePeriodMs, this.#pollIntervalMs,
      );
      if (termResult === 'gone') return this.#transition(stopping, 'STOPPED');
      if (termResult === 'mismatch') {
        const group = await this.#inspectGroup(stopping.pgid);
        if (group.status === 'failed') throw new Error(group.reason);
        return this.#transition(stopping, group.status === 'absent' ? 'STOPPED' : 'STALE_IDENTITY');
      }
      if (termResult === 'failed') throw new Error('PROCESS_INSPECTION_FAILED');

      const beforeKill = await inspectWithRetry(
        stopping.pid,
        this.#inspectProcess,
        Math.min(this.#gracePeriodMs, 250),
        this.#pollIntervalMs,
      );
      if (beforeKill.status === 'failed') throw new Error(beforeKill.reason);
      if (beforeKill.status === 'absent') {
        const group = await this.#inspectGroup(stopping.pgid);
        if (group.status === 'failed') throw new Error(group.reason);
        if (group.status === 'absent') return this.#transition(stopping, 'STOPPED');
        throw new Error('OWNERSHIP_ANCHOR_MISSING');
      }
      if (!identityMatches(stopping, beforeKill.identity)) return this.#transition(stopping, 'STALE_IDENTITY');
      try { this.#signalGroup(stopping.pgid, 'SIGKILL'); }
      catch (error) { if (!isNoSuchProcess(error)) throw error; }
      const killed = await waitForGroupAbsent(
        stopping.pgid, this.#inspectGroup, this.#gracePeriodMs, this.#pollIntervalMs,
      );
      if (killed !== 'gone') throw new Error(killed === 'failed' ? 'PROCESS_INSPECTION_FAILED' : 'GROUP_REMAINED_ALIVE');
      return this.#transition(stopping, 'STOPPED');
    } catch (error) {
      const failed = this.#transition(stopping, 'FAILED');
      throw new ManagedProcessError('RUNTIME_STOP_FAILED', 'Managed task could not be stopped safely.', {
        worktreeId: stopping.worktreeId, taskName: stopping.taskName, processId: stopping.id,
        reason: safeErrorCode(error), state: failed.state,
      });
    }
  }

  async #recordExit(
    recordId: string, worktreeId: string, taskName: string,
    exitCode: number | null, signal: NodeJS.Signals | null,
  ): Promise<void> {
    await this.#serialize(ownerKey(worktreeId, taskName), async () => {
      this.#owned.delete(recordId);
      const record = this.#stateStore.getManagedProcess(recordId);
      if (record === null || !isActiveState(record.state)) return;
      const group = await waitForGroupAbsent(
        record.pgid, this.#inspectGroup, this.#gracePeriodMs, this.#pollIntervalMs,
      );
      const state: ManagedProcessState = group === 'gone'
        ? (record.state === 'STOPPING' || (exitCode === 0 && signal === null) ? 'STOPPED' : 'FAILED')
        : 'FAILED';
      this.#transition(record, state);
    }).catch((error) => this.#reportError(error));
  }

  #transition(
    record: ManagedProcessRecord,
    state: ManagedProcessState,
    cleanupRequired = record.cleanupRequired,
  ): ManagedProcessRecord {
    if (record.state === state && record.cleanupRequired === cleanupRequired) return record;
    const updated = this.#stateStore.updateManagedProcess(record.id, {
      expectedStates: [record.state],
      state,
      stoppedAt: isActiveState(state) ? null : this.#now().toISOString(),
      cleanupRequired,
    });
    return updated ?? this.#stateStore.getManagedProcess(record.id) ?? record;
  }

  async #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#locks.set(key, current);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.#locks.get(key) === current) this.#locks.delete(key); }
  }

  #assertOpen(): void { if (this.#closed) throw new Error('Managed process supervisor is closed'); }
  #releaseExpiredReservation(record: ManagedProcessRecord): void {
    this.#stateStore.releaseExpiredManagedProcessStart(
      record.worktreeId,
      record.taskName,
      this.#now().toISOString(),
    );
  }
  #releaseReservationAfterRecovery(record: ManagedProcessRecord): boolean {
    return record.cleanupOwnerToken !== undefined
      && this.#stateStore.releaseManagedProcessStart(record.worktreeId, record.taskName, record.cleanupOwnerToken);
  }

  async #terminateCleanupOwned(record: ManagedProcessRecord): Promise<boolean> {
    const beforeTerm = await this.#inspectProcess(record.pid);
    if (beforeTerm.status === 'failed') return false;
    if (beforeTerm.status === 'absent') {
      return (await this.#inspectGroup(record.pgid)).status === 'absent';
    }
    if (!identityMatches(record, beforeTerm.identity)) return true;
    try { this.#signalGroup(record.pgid, 'SIGTERM'); }
    catch (error) { if (!isNoSuchProcess(error)) return false; }
    const term = await waitForOwnedGroupChange(
      record, this.#inspectProcess, this.#inspectGroup, this.#gracePeriodMs, this.#pollIntervalMs,
    );
    if (term === 'gone' || term === 'mismatch') return true;
    if (term === 'failed') return false;
    const beforeKill = await this.#inspectProcess(record.pid);
    if (beforeKill.status === 'failed') return false;
    if (beforeKill.status === 'absent') return (await this.#inspectGroup(record.pgid)).status === 'absent';
    if (!identityMatches(record, beforeKill.identity)) return true;
    try { this.#signalGroup(record.pgid, 'SIGKILL'); }
    catch (error) { if (!isNoSuchProcess(error)) return false; }
    return await waitForGroupAbsent(
      record.pgid, this.#inspectGroup, this.#gracePeriodMs, this.#pollIntervalMs,
    ) === 'gone';
  }
  #reportError(error: unknown): void { try { this.#onError(error); } catch {} }
}

export async function inspectProcess(pid: number): Promise<ProcessInspection> {
  if (!Number.isSafeInteger(pid) || pid < 1) return { status: 'absent' };
  let stdout: string;
  try {
    stdout = (await execFileAsync('ps', [
      '-ww', '-p', String(pid), '-o', 'pgid=', '-o', 'state=', '-o', 'lstart=', '-o', 'comm=', '-o', 'command=',
    ], { encoding: 'utf8', env: stableEnvironment(), maxBuffer: 64 * 1024, timeout: 1_000 })).stdout;
  } catch (error) {
    return isPsAbsent(error) ? { status: 'absent' } : { status: 'failed', reason: safeErrorCode(error) };
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { status: 'absent' };
  if (lines.length !== 1) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
  const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+?)\s*$/.exec(lines[0] as string);
  if (match === null) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
  const pgid = Number.parseInt(match[1] as string, 10);
  if (!Number.isSafeInteger(pgid) || pgid < 1) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
  if ((match[2] as string).startsWith('Z')) return { status: 'absent' };
  return { status: 'present', identity: {
    pid, pgid, processStartTime: match[3] as string,
    commandFingerprint: observedCommandFingerprint(match[4] as string, match[5] as string),
  } };
}

export async function inspectProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const result = await inspectProcess(pid);
  return result.status === 'present' ? result.identity : null;
}

export async function inspectProcessGroup(pgid: number): Promise<ProcessGroupInspection> {
  if (!Number.isSafeInteger(pgid) || pgid < 1) return { status: 'absent' };
  let stdout: string;
  try {
    stdout = (await execFileAsync('ps', ['-axo', 'pid=', '-o', 'pgid=', '-o', 'state='], {
      encoding: 'utf8', env: stableEnvironment(), maxBuffer: 4 * 1024 * 1024, timeout: 1_000,
    })).stdout;
  } catch (error) { return { status: 'failed', reason: safeErrorCode(error) }; }
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
    if (Number.parseInt(match[2] as string, 10) === pgid && !(match[3] as string).startsWith('Z')) {
      pids.push(Number.parseInt(match[1] as string, 10));
    }
  }
  return pids.length === 0 ? { status: 'absent' } : { status: 'present', pids };
}

function identityMatches(record: ManagedProcessRecord, identity: ProcessIdentity): boolean {
  return record.pid === identity.pid && record.pgid === identity.pgid
    && record.processStartTime === identity.processStartTime
    && record.commandFingerprint === identity.commandFingerprint;
}

async function waitForIdentity(
  pid: number, inspect: (pid: number) => Promise<ProcessInspection>, pollIntervalMs: number,
  hasExited: () => boolean,
): Promise<ProcessInspection> {
  const deadline = Date.now() + anchorProtocolTimeoutMs;
  let previous: ProcessIdentity | null = null;
  while (true) {
    const result = await inspect(pid);
    if (result.status === 'failed') return result;
    if (result.status === 'present' && previous !== null && sameIdentity(result.identity, previous)) return result;
    previous = result.status === 'present' ? result.identity : null;
    if (result.status === 'absent' && hasExited()) return result;
    if (Date.now() >= deadline) return { status: 'failed', reason: 'IDENTITY_TIMEOUT' };
    await delay(pollIntervalMs);
  }
}

async function waitForOwnedGroupChange(
  record: ManagedProcessRecord, inspect: (pid: number) => Promise<ProcessInspection>,
  inspectGroup: (pgid: number) => Promise<ProcessGroupInspection>, timeoutMs: number, pollIntervalMs: number,
): Promise<'gone' | 'mismatch' | 'alive' | 'failed'> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const identity = await inspect(record.pid);
    if (identity.status === 'failed') {
      if (Date.now() >= deadline) return 'failed';
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (identity.status === 'present' && !identityMatches(record, identity.identity)) return 'mismatch';
    const group = await inspectGroup(record.pgid);
    if (group.status === 'failed') {
      if (Date.now() >= deadline) return 'failed';
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (identity.status === 'absent' && group.status === 'absent') return 'gone';
    if (Date.now() >= deadline) return identity.status === 'absent' && group.status === 'present' ? 'failed' : 'alive';
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

async function inspectWithRetry(
  pid: number,
  inspect: (pid: number) => Promise<ProcessInspection>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ProcessInspection> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await inspect(pid);
    if (result.status !== 'failed' || Date.now() >= deadline) return result;
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

async function waitForGroupAbsent(
  pgid: number, inspect: (pgid: number) => Promise<ProcessGroupInspection>, timeoutMs: number, pollIntervalMs: number,
): Promise<'gone' | 'alive' | 'failed'> {
  const deadline = Date.now() + Math.max(timeoutMs, 2_000);
  while (true) {
    const result = await inspect(pgid);
    if (result.status === 'absent') return 'gone';
    if (result.status === 'failed') {
      if (Date.now() >= deadline) return 'failed';
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (Date.now() >= deadline) return 'alive';
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function waitForAnchorHandshake(
  stream: Readable | null,
  child: ChildProcess,
  hasExited: () => boolean,
): Promise<ProcessIdentity | null> {
  if (stream === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let content = '';
    const finish = (value: ProcessIdentity | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners();
      child.off('exit', onExit);
      if ('unref' in stream && typeof stream.unref === 'function') stream.unref();
      if (stream.closed) resolve(value);
      else {
        stream.once('close', () => resolve(value));
        stream.destroy();
      }
    };
    const onExit = () => finish(null);
    const timer = setTimeout(() => finish(null), anchorProtocolTimeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      content += chunk;
      const newline = content.indexOf('\n');
      if (newline < 0) return;
      finish(parseReadyIdentity(content.slice(0, newline)));
    });
    stream.on('error', () => finish(null));
    child.once('exit', onExit);
    if (hasExited()) finish(null);
  });
}

function parseReadyIdentity(line: string): ProcessIdentity | null {
  if (!line.startsWith('READY ')) return null;
  try {
    const value = JSON.parse(line.slice('READY '.length)) as Partial<ProcessIdentity>;
    if (
      !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
      || !Number.isSafeInteger(value.pgid) || Number(value.pgid) < 1
      || typeof value.processStartTime !== 'string' || value.processStartTime.length === 0
      || typeof value.commandFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.commandFingerprint)
    ) return null;
    return value as ProcessIdentity;
  } catch {
    return null;
  }
}

function waitForLaunchAck(
  stream: Readable | null,
  child: ChildProcess,
  hasExited: () => boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (stream === null) return Promise.resolve({ ok: false, reason: 'ANCHOR_STATUS_UNAVAILABLE' });
  return new Promise((resolve) => {
    let settled = false;
    let content = '';
    const finish = (value: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners();
      child.off('exit', onExit);
      if ('unref' in stream && typeof stream.unref === 'function') stream.unref();
      stream.destroy();
      resolve(value);
    };
    const onExit = () => finish({ ok: false, reason: 'ANCHOR_EXITED_BEFORE_LAUNCH' });
    const timer = setTimeout(() => finish({ ok: false, reason: 'ANCHOR_LAUNCH_TIMEOUT' }), anchorProtocolTimeoutMs);
    timer.unref();
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      content += chunk;
      const newline = content.indexOf('\n');
      if (newline < 0) return;
      const line = content.slice(0, newline);
      finish(line === 'LAUNCHED'
        ? { ok: true }
        : { ok: false, reason: line.startsWith('ERROR ') ? line.slice(6) : 'ANCHOR_LAUNCH_INVALID' });
    });
    stream.on('error', () => finish({ ok: false, reason: 'ANCHOR_STATUS_FAILED' }));
    child.once('exit', onExit);
    if (hasExited()) onExit();
  });
}

function sendAnchorCommand(stream: Writable | null, command: 'GO' | 'ABORT'): Promise<void> {
  if (stream === null || stream.destroyed) return Promise.reject(new Error('ANCHOR_CONTROL_UNAVAILABLE'));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('error', onError);
      stream.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error('ANCHOR_CONTROL_TIMEOUT')), anchorProtocolTimeoutMs);
    timer.unref();
    stream.once('error', onError);
    stream.end(`${command}\n`, () => finish());
    if ('unref' in stream && typeof stream.unref === 'function') stream.unref();
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(timeoutMs, 100));
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    child.once('exit', onExit);
  });
}

function childSpawned(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
}

async function spawnAnchor(options: {
  input: ManagedProcessStartInput;
  logs: PreparedManagedLogs;
  ignoreAbort: boolean;
  runtimeInvocation: RuntimeInvocation;
}): Promise<ChildProcess> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const child = spawn(options.runtimeInvocation.executable, [
        ...options.runtimeInvocation.prefixArgs,
        '__wtm_internal_anchor',
        plannedCommandFingerprint(options.input),
      ], {
        cwd: options.input.cwd,
        env: {
          ...(options.input.env ?? process.env),
          WTM_ANCHOR_SPEC: JSON.stringify({
            argv: options.input.argv,
            shell: options.input.shell ?? false,
            ignoreAbort: options.ignoreAbort,
            logs: options.logs,
          }),
        },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      await childSpawned(child);
      return child;
    } catch (error) {
      lastError = error;
      if (!isTransientPipeCreationFailure(error) || attempt === 5) break;
      await delay(10 * (2 ** attempt));
    }
  }
  throw lastError;
}

function isTransientPipeCreationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'EAGAIN'
    || error.code === 'EMFILE'
    || error.code === 'ENFILE'
    || (error.code === 'ENOENT' && error instanceof Error && error.message.includes('connect'));
}

function taskNotRunning(selector: ManagedProcessSelector): ManagedProcessError {
  return new ManagedProcessError('RUNTIME_TASK_NOT_RUNNING', 'Managed task is not running.', {
    worktreeId: selector.worktreeId,
    taskName: selector.taskName,
  });
}

function startFailure(input: ManagedProcessStartInput, error: unknown): ManagedProcessError {
  return new ManagedProcessError('RUNTIME_START_FAILED', 'Managed task could not be started.', {
    worktreeId: input.worktreeId, taskName: input.taskName, reason: safeErrorCode(error),
  });
}

class DurableCleanupOwnershipError extends ManagedProcessError {
  constructor(input: ManagedProcessStartInput, error: unknown) {
    super('RUNTIME_START_FAILED', 'Managed task cleanup requires recovery.', {
      worktreeId: input.worktreeId,
      taskName: input.taskName,
      reason: safeErrorCode(error),
      state: 'FAILED',
    });
  }
}

function plannedCommandFingerprint(input: ManagedProcessStartInput): string {
  return createHash('sha256')
    .update(input.shell === true ? 'shell\0' : 'argv\0')
    .update(JSON.stringify(input.argv))
    .digest('hex');
}

function reservationExpiry(acquiredAt: string): string {
  const milliseconds = Date.parse(acquiredAt);
  if (!Number.isFinite(milliseconds)) throw new Error('Managed process reservation time is invalid');
  return new Date(milliseconds + 30_000).toISOString();
}

function defaultRuntimeInvocation(): RuntimeInvocation {
  // A standalone executable re-invokes itself; there is no separate entry script.
  if (process.getBuiltinModule?.('node:sea')?.isSea() === true) {
    return { executable: process.execPath, prefixArgs: [] };
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('WTM CLI entry path is unavailable');
  return { executable: process.execPath, prefixArgs: [entry] };
}

function stableEnvironment(): NodeJS.ProcessEnv { return { ...process.env, LC_ALL: 'C', LANG: 'C' }; }
function isPsAbsent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 1
    && 'stdout' in error
    && String(error.stdout).trim().length === 0
    && 'stderr' in error
    && String(error.stderr).trim().length === 0;
}
function ownerKey(worktreeId: string, taskName: string): string { return `${worktreeId}\0${taskName}`; }
function isActiveState(state: ManagedProcessState): boolean { return state === 'STARTING' || state === 'RUNNING' || state === 'STOPPING'; }
function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.pgid === right.pgid
    && left.processStartTime === right.processStartTime && left.commandFingerprint === right.commandFingerprint;
}
function observedCommandFingerprint(executable: string, command: string): string {
  const anchorMarker = /(?:^|\s)([a-f0-9]{64})\s*$/.exec(command)?.[1];
  return createHash('sha256')
    .update(executable)
    .update('\0')
    .update(anchorMarker === undefined ? command : `wtm-anchor:${anchorMarker}`)
    .digest('hex');
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function isNoSuchProcess(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'; }
function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'UNKNOWN';
}
function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}
function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative integer`);
  return value;
}
