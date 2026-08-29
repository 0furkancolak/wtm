import type {
  ManagedProcessCreateOptions,
  ManagedProcessInput,
  ManagedProcessQuery,
  ManagedProcessRecord,
  ManagedProcessReservationOptions,
  ManagedProcessUpdate,
} from '../../core/src/state/store';
import type { ManagedProcessStateStore } from '../../daemon/src/process-supervisor';

/** In-memory managed-process state for tests that exercise real process ownership. */
export class MemoryManagedProcessStore implements ManagedProcessStateStore {
  readonly #records = new Map<string, ManagedProcessRecord>();
  #reservation: { key: string; token: string } | null = null;

  createManagedProcess(input: ManagedProcessInput, options: ManagedProcessCreateOptions = {}): ManagedProcessRecord {
    if (this.#reservation?.token !== options.reservationToken) throw new Error('Reservation not owned');
    const record = { ...input, cleanupRequired: input.cleanupRequired ?? false, id: crypto.randomUUID() };
    this.#records.set(record.id, record);
    return { ...record };
  }
  getManagedProcess(id: string): ManagedProcessRecord | null { return this.#copy(this.#records.get(id)); }
  updateManagedProcess(id: string, update: ManagedProcessUpdate): ManagedProcessRecord | null {
    const record = this.#records.get(id);
    if (record === undefined || !update.expectedStates.includes(record.state)) return null;
    const updated = { ...record, ...update, stoppedAt: update.stoppedAt ?? null };
    this.#records.set(id, updated);
    return { ...updated };
  }
  listManagedProcesses(query: ManagedProcessQuery = {}): ManagedProcessRecord[] {
    return [...this.#records.values()]
      .filter((record) => query.worktreeId === undefined || record.worktreeId === query.worktreeId)
      .filter((record) => query.taskName === undefined || record.taskName === query.taskName)
      .filter((record) => query.states === undefined || query.states.includes(record.state))
      .map((record) => ({ ...record }));
  }
  findActiveManagedProcess(worktreeId: string, taskName: string): ManagedProcessRecord | null {
    return this.listManagedProcesses({ worktreeId, taskName, states: ['STARTING', 'RUNNING', 'STOPPING'] })[0] ?? null;
  }
  reserveManagedProcessStart(
    worktreeId: string,
    taskName: string,
    token: string,
    _createdAt: string,
    _options: ManagedProcessReservationOptions = {},
  ): boolean {
    if (this.#reservation !== null) return false;
    this.#reservation = { key: `${worktreeId}\0${taskName}`, token };
    return true;
  }
  releaseManagedProcessStart(worktreeId: string, taskName: string, token: string): boolean {
    if (this.#reservation?.key !== `${worktreeId}\0${taskName}` || this.#reservation.token !== token) return false;
    this.#reservation = null;
    return true;
  }
  releaseExpiredManagedProcessStart(): boolean { return false; }
  releaseExpiredManagedProcessReplacement(): boolean { return false; }
  hasManagedProcessStartReservation(worktreeId: string, taskName: string): boolean {
    return this.#reservation?.key === `${worktreeId}\0${taskName}`;
  }
  #copy(record: ManagedProcessRecord | undefined): ManagedProcessRecord | null {
    return record === undefined ? null : { ...record };
  }
}
