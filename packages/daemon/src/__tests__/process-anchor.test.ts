import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedLogStore } from '../logs';
import { ManagedProcessSupervisor } from '../process-supervisor';
import type { ManagedProcessStateStore } from '../process-supervisor';
import type {
  ManagedProcessCreateOptions,
  ManagedProcessInput,
  ManagedProcessQuery,
  ManagedProcessRecord,
  ManagedProcessReservationOptions,
  ManagedProcessUpdate,
} from '@wtm/core';

const cleanups: Array<() => Promise<void>> = [];
const cliEntry = fileURLToPath(new URL('../../../cli/src/bin.ts', import.meta.url));
const nodeExecutable = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('process anchor runtime invocation', () => {
  test('starts and stops through the injected executable without resolving a runtime from PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-runtime-'));
    const commands = join(root, 'commands');
    await mkdir(commands);
    await symlink('/bin/ps', join(commands, 'ps'));
    const task = join(commands, 'fixture-task');
    await writeFile(task, '#!/bin/sh\nexec /bin/sleep 30\n');
    await chmod(task, 0o700);
    const store = new MemoryStore();
    const supervisor = new ManagedProcessSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      pollIntervalMs: 10,
      runtimeInvocation: {
        executable: nodeExecutable,
        prefixArgs: ['--import', import.meta.resolve('tsx'), cliEntry],
      },
    });
    cleanups.push(async () => {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    });

    const started = await supervisor.start({
      worktreeId: 'worktree-1',
      taskName: 'fixture',
      argv: ['fixture-task'],
      cwd: root,
      env: { PATH: commands },
    });

    expect(started.record.state).toBe('RUNNING');
    expect((await supervisor.stop({ worktreeId: 'worktree-1', taskName: 'fixture' })).state).toBe('STOPPED');
  });
});

class MemoryStore implements ManagedProcessStateStore {
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
