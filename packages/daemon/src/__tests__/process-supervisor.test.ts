import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ManagedProcessInput,
  ManagedProcessCreateOptions,
  ManagedProcessQuery,
  ManagedProcessRecord,
  ManagedProcessUpdate,
  ManagedProcessReservationOptions,
} from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import { createDarwinProcessPlatform } from '@wtm/platform/process';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { ManagedLogStore } from '../logs';
import {
  ManagedProcessSupervisor,
  type ManagedProcessSupervisorOptions,
  inspectProcess,
  inspectProcessGroup,
  inspectProcessIdentity,
  type ManagedProcessStateStore,
  type ProcessIdentity,
  type ProcessInspection,
} from '../process-supervisor';

const fixturePath = fileURLToPath(new URL('./process-group-fixture.scenario.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');
const cleanups: Array<() => Promise<void>> = [];

function createSupervisor(options: ManagedProcessSupervisorOptions): ManagedProcessSupervisor {
  return new ManagedProcessSupervisor({ runtimeInvocation: developmentRuntimeInvocation(), ...options });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(gracePeriodMs = 1_000) {
  const root = await mkdtemp(join(tmpdir(), 'wtm-supervisor-'));
  const store = new MemoryProcessStore();
  const worktree = { id: 'worktree-1' };
  const supervisor = createSupervisor({
    stateStore: store,
    logs: new ManagedLogStore({ root: join(root, 'logs') }),
    gracePeriodMs,
    pollIntervalMs: 10,
  });
  cleanups.push(async () => {
    // A safety-path assertion can terminalize a row while its exact owned anchor
    // remains live. Teardown therefore checks every retained fixture identity.
    const killedGroups = new Set<number>();
    for (const record of store.listManagedProcesses()) {
      const identity = await inspectProcessIdentity(record.pid);
      if (identity !== null && identityMatches(record, identity)) {
        try {
          process.kill(-record.pgid, 'SIGKILL');
          killedGroups.add(record.pgid);
        } catch (error) {
          if (!isNoSuchProcess(error)) throw error;
        }
      }
    }
    for (const pgid of killedGroups) {
      await waitFor(async () => (await inspectProcessGroup(pgid)).status === 'absent', 2_000);
    }
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, worktree, supervisor };
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

class MemoryProcessStore implements ManagedProcessStateStore {
  readonly #records = new Map<string, ManagedProcessRecord>();
  readonly #reservations = new Map<string, { token: string; expiresAt: string; replaceProcessId?: string }>();

  createManagedProcess(input: ManagedProcessInput, options: ManagedProcessCreateOptions = {}): ManagedProcessRecord {
    const key = `${input.worktreeId}\0${input.taskName}`;
    if (options.reservationToken !== undefined && this.#reservations.get(key)?.token !== options.reservationToken) {
      throw new Error('Reservation not owned');
    }
    if (this.findActiveManagedProcess(input.worktreeId, input.taskName) !== null) {
      throw new Error('Managed task is already active');
    }
    const record = { ...input, cleanupRequired: input.cleanupRequired ?? false, id: randomUUID() };
    this.#records.set(record.id, record);
    return { ...record };
  }

  getManagedProcess(id: string): ManagedProcessRecord | null {
    const record = this.#records.get(id);
    return record === undefined ? null : { ...record };
  }

  updateManagedProcess(id: string, update: ManagedProcessUpdate): ManagedProcessRecord | null {
    const record = this.#records.get(id);
    if (record === undefined) throw new Error('Unknown managed process');
    if (!update.expectedStates.includes(record.state)) return null;
    if (
      update.reservationToken !== undefined
      && this.#reservations.get(`${record.worktreeId}\0${record.taskName}`)?.token !== update.reservationToken
    ) throw new Error('Reservation not owned');
    const updated = { ...record, ...update, stoppedAt: update.stoppedAt ?? null };
    this.#records.set(id, updated);
    return { ...updated };
  }

  listManagedProcesses(query: ManagedProcessQuery = {}): ManagedProcessRecord[] {
    return [...this.#records.values()]
      .filter((record) => query.worktreeId === undefined || record.worktreeId === query.worktreeId)
      .filter((record) => query.taskName === undefined || record.taskName === query.taskName)
      .filter((record) => query.states === undefined || query.states.includes(record.state))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map((record) => ({ ...record }));
  }

  findActiveManagedProcess(worktreeId: string, taskName: string): ManagedProcessRecord | null {
    return this.listManagedProcesses({
      worktreeId,
      taskName,
      states: ['STARTING', 'RUNNING', 'STOPPING'],
    }).at(-1) ?? null;
  }

  reserveManagedProcessStart(
    worktreeId: string,
    taskName: string,
    token: string,
    _createdAt: string,
    options: ManagedProcessReservationOptions = {},
  ): boolean {
    const key = `${worktreeId}\0${taskName}`;
    const reservation = this.#reservations.get(key);
    const active = this.findActiveManagedProcess(worktreeId, taskName);
    if (reservation !== undefined && !(reservation.expiresAt <= _createdAt && active === null)) return false;
    if (reservation !== undefined) this.#reservations.delete(key);
    if (active !== null && options.replaceProcessId !== active.id) return false;
    this.#reservations.set(key, {
      token,
      expiresAt: options.expiresAt ?? _createdAt,
      ...(options.replaceProcessId === undefined ? {} : { replaceProcessId: options.replaceProcessId }),
    });
    return true;
  }

  releaseManagedProcessStart(worktreeId: string, taskName: string, token: string): boolean {
    const key = `${worktreeId}\0${taskName}`;
    if (this.#reservations.get(key)?.token !== token) return false;
    this.#reservations.delete(key);
    return true;
  }

  releaseExpiredManagedProcessStart(worktreeId: string, taskName: string, now: string): boolean {
    const key = `${worktreeId}\0${taskName}`;
    const reservation = this.#reservations.get(key);
    const protectedProcess = this.listManagedProcesses({ worktreeId, taskName })
      .some((record) => ['STARTING', 'RUNNING', 'STOPPING'].includes(record.state) || record.cleanupRequired);
    if (reservation === undefined || reservation.expiresAt > now || protectedProcess) return false;
    this.#reservations.delete(key);
    return true;
  }

  releaseExpiredManagedProcessReplacement(record: ManagedProcessRecord, now: string): boolean {
    const key = `${record.worktreeId}\0${record.taskName}`;
    const reservation = this.#reservations.get(key);
    const current = this.#records.get(record.id);
    if (
      reservation === undefined || reservation.expiresAt > now || reservation.replaceProcessId !== record.id
      || current === undefined || current.state !== 'RUNNING' || current.cleanupRequired
      || !identityMatches(current, record)
    ) return false;
    this.#reservations.delete(key);
    return true;
  }

  releaseManagedProcessStartAfterRecovery(worktreeId: string, taskName: string): boolean {
    return this.#reservations.delete(`${worktreeId}\0${taskName}`);
  }

  hasManagedProcessStartReservation(worktreeId: string, taskName: string): boolean {
    return this.#reservations.has(`${worktreeId}\0${taskName}`);
  }

  forceRecord(id: string, update: Partial<ManagedProcessRecord> & { cleanupRequired?: boolean }): void {
    const current = this.#records.get(id);
    if (current === undefined) throw new Error('Unknown managed process');
    this.#records.set(id, { ...current, ...update });
  }

  forceReservation(
    worktreeId: string,
    taskName: string,
    token: string,
    expiresAt: string,
    replaceProcessId?: string,
  ): void {
    this.#reservations.set(`${worktreeId}\0${taskName}`, { token, expiresAt, ...(replaceProcessId === undefined ? {} : { replaceProcessId }) });
  }
}

class FaultProcessStore extends MemoryProcessStore {
  throwOnCreate = false;
  createFailuresRemaining = 0;
  failRunningUpdate = false;

  override createManagedProcess(
    input: ManagedProcessInput,
    options: ManagedProcessCreateOptions = {},
  ): ManagedProcessRecord {
    if (this.throwOnCreate || this.createFailuresRemaining-- > 0) throw new Error('injected create failure');
    return super.createManagedProcess(input, options);
  }

  override updateManagedProcess(id: string, update: ManagedProcessUpdate): ManagedProcessRecord | null {
    if (this.failRunningUpdate && update.state === 'RUNNING') return null;
    return super.updateManagedProcess(id, update);
  }
}

/**
 * The three `ps` readers moved to `@wtm/platform` in C1-3; the functions this module exports are
 * now the same names delegating to the port the platform seam selects for this host. These tests
 * are the ones that would fail if the delegation were wired to the wrong platform, or if a future
 * edit reintroduced a second copy of the parsing here — the rest of this file exercises the
 * readers through the supervisor and would still pass against a divergent duplicate.
 *
 * The host is macOS, so the selected port and `createDarwinProcessPlatform()` are the same
 * implementation and these assertions cannot tell them apart. That is the limit of what is
 * decidable here, and it is why the selection is asserted separately below rather than left to be
 * inferred from readers that would agree either way.
 */
describe('the daemon default process readers are the platform macOS readers', () => {
  const platform = createDarwinProcessPlatform();

  test('delegate to the port the platform seam selected, not to a hardcoded macOS one', async () => {
    const selected = selectPlatformRuntime().process;

    expect(selectPlatformRuntime().id).toBe(process.platform as 'darwin' | 'linux');
    expect(await inspectProcess(process.pid)).toEqual(await selected.inspectProcess(process.pid));
    expect(await inspectProcessGroup(process.pid)).toEqual(await selected.inspectProcessGroup(process.pid));
  });

  test('agree with @wtm/platform about the running process', async () => {
    const viaPlatform = await platform.inspectProcess(process.pid);
    expect(viaPlatform.status).toBe('present');
    expect(await inspectProcess(process.pid)).toEqual(viaPlatform);
    expect(await inspectProcessIdentity(process.pid))
      .toEqual(viaPlatform.status === 'present' ? viaPlatform.identity : null);
  });

  test('agree with @wtm/platform about the running process group', async () => {
    const identity = await inspectProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    const pgid = (identity as ProcessIdentity).pgid;
    const viaDaemon = await inspectProcessGroup(pgid);
    const viaPlatform = await platform.inspectProcessGroup(pgid);
    expect(viaDaemon.status).toBe('present');
    expect(viaPlatform.status).toBe('present');
    expect(viaDaemon.status === 'present' ? [...viaDaemon.pids] : []).toContain(process.pid);
    expect(viaPlatform.status === 'present' ? [...viaPlatform.pids] : []).toContain(process.pid);
  });

  test('report a reaped process as absent, not as a failure', async () => {
    const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });
    expect(await inspectProcess(pid)).toEqual({ status: 'absent' });
    expect(await inspectProcessIdentity(pid)).toBeNull();
  });
});

describe('ManagedProcessSupervisor', () => {
  test('stopping a task terminates its entire owned process group', async () => {
    const { root, worktree, supervisor } = await setup();
    const pidFile = join(root, 'group.json');
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'dev',
      argv: ['node', '--import', tsxLoader, fixturePath, 'parent', pidFile, 'normal'],
      cwd: root,
      env: process.env,
    });
    const pids = await waitForJson(pidFile) as { parentPid: number; childPid: number };
    const beforeStop = await inspectProcessIdentity(started.record.pid);
    expect(beforeStop !== null && identityMatches(started.record, beforeStop)).toBe(true);

    const stopped = await supervisor.stop({ worktreeId: worktree.id, taskName: 'dev' });

    expect(started.record.pgid).toBe(started.record.pid);
    expect(stopped.state).toBe('STOPPED');
    await waitFor(() => !pidExists(pids.parentPid) && !pidExists(pids.childPid));
  });

  test('a stale stored identity never signals an unrelated process group', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const unrelated = spawn('node', ['--import', tsxLoader, fixturePath, 'member', 'unused', 'normal'], {
      detached: true,
      stdio: 'ignore',
    });
    if (unrelated.pid === undefined) throw new Error('Expected unrelated PID');
    const actual = await waitForIdentity(unrelated.pid);
    const record = store.createManagedProcess({
      worktreeId: worktree.id,
      taskName: 'stale',
      pid: actual.pid,
      pgid: actual.pgid,
      processStartTime: actual.processStartTime,
      commandFingerprint: 'sha256:not-the-unrelated-command',
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      stdoutPath: join(root, 'stale.stdout.log'),
      stderrPath: join(root, 'stale.stderr.log'),
    });
    cleanups.push(async () => {
      const current = await inspectProcessIdentity(actual.pid);
      if (current !== null && sameIdentity(actual, current)) process.kill(-actual.pgid, 'SIGKILL');
    });

    const stopped = await supervisor.stop({ worktreeId: worktree.id, taskName: 'stale' });

    expect(stopped.id).toBe(record.id);
    expect(stopped.state).toBe('STALE_IDENTITY');
    expect(pidExists(unrelated.pid)).toBe(true);
  });

  test('concurrent singleton starts serialize and return one live record', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const pidFile = join(root, 'singleton.json');
    const input = {
      worktreeId: worktree.id,
      taskName: 'dev',
      argv: ['node', '--import', tsxLoader, fixturePath, 'parent', pidFile, 'normal'],
      cwd: root,
      env: process.env,
    };

    const [first, second] = await Promise.all([supervisor.start(input), supervisor.start(input)]);

    expect(first.record.id).toBe(second.record.id);
    expect([first.existing, second.existing].sort()).toEqual([false, true]);
    expect(store.listManagedProcesses({ states: ['STARTING', 'RUNNING', 'STOPPING'] })).toHaveLength(1);
    await supervisor.stop({ worktreeId: worktree.id, taskName: 'dev' });
  });

  test('create failure synchronously removes the exact newly spawned task and group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-supervisor-create-fault-'));
    const store = new FaultProcessStore();
    store.throwOnCreate = true;
    let killedPgid = 0;
    let inspections = 0;
    const supervisor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      gracePeriodMs: 100,
      pollIntervalMs: 10,
      inspectProcess: async (pid) => {
        inspections += 1;
        return inspections <= 2 ? await inspectProcess(pid) : { status: 'failed', reason: 'PS_INJECTED' };
      },
      signalProcessGroup: (pgid, signal) => { killedPgid = pgid; process.kill(-pgid, signal); },
    });
    cleanups.push(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
    const descendantMarker = join(root, 'create-descendant-launched');
    await expect(supervisor.start({
      worktreeId: 'worktree-1', taskName: 'create-fault',
      argv: ['/bin/sh', '-c', `printf launched > '${descendantMarker}'; exec sleep 30`],
      cwd: root, env: process.env,
    })).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });

    expect(killedPgid).toBe(0);
    expect(inspections).toBe(0);
    expect(store.findActiveManagedProcess('worktree-1', 'create-fault')).toBeNull();
    expect(await readFile(descendantMarker, 'utf8').then(() => true, () => false)).toBe(false);
  });

  test('pre-identity inspection failure retains durable cleanup ownership when ABORT is refused', async () => {
    const { root, store, worktree } = await setup(25);
    const marker = join(root, 'must-not-launch');
    let anchorPid = 0;
    const supervisor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs-preidentity') }),
      gracePeriodMs: 25,
      pollIntervalMs: 5,
      inspectProcess: async (pid) => { anchorPid = pid; return { status: 'failed', reason: 'PS_INJECTED' }; },
      anchorIgnoresAbort: true,
    });
    cleanups.push(async () => {
      if (anchorPid > 0) {
        const identity = await inspectProcessIdentity(anchorPid);
        if (identity !== null && identity.pid === identity.pgid) {
          try { process.kill(-identity.pgid, 'SIGKILL'); } catch (error) { if (!isNoSuchProcess(error)) throw error; }
        }
      }
      await supervisor.close();
    });

    await expect(supervisor.start({
      worktreeId: worktree.id,
      taskName: 'preidentity',
      argv: ['/bin/sh', '-c', `printf launched > '${marker}'`],
      cwd: root,
      env: process.env,
    })).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });

    const record = store.listManagedProcesses()[0] as (ManagedProcessRecord & { cleanupRequired?: boolean }) | undefined;
    expect(record?.state).toBe('FAILED');
    expect(record?.cleanupRequired).toBe(true);
    expect(store.hasManagedProcessStartReservation(worktree.id, 'preidentity')).toBe(true);
    expect(await readFile(marker, 'utf8').then(() => true, () => false)).toBe(false);

    await supervisor.close();
    const recovery = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs-preidentity') }),
      gracePeriodMs: 50,
      pollIntervalMs: 5,
    });
    cleanups.push(() => recovery.close());
    await recovery.recover();
    await waitFor(async () => (await inspectProcessGroup(record?.pgid ?? 0)).status === 'absent');
    if (store.hasManagedProcessStartReservation(worktree.id, 'preidentity')) await recovery.recover();
    expect(store.hasManagedProcessStartReservation(worktree.id, 'preidentity')).toBe(false);
  });

  test('does not publish RUNNING until the anchor acknowledges successful task launch', async () => {
    const { root, store, worktree, supervisor } = await setup();

    await expect(supervisor.start({
      worktreeId: worktree.id,
      taskName: 'missing',
      argv: ['/definitely/missing/wtm-command'],
      cwd: root,
      env: process.env,
    })).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });

    expect(store.listManagedProcesses().some(({ state }) => state === 'RUNNING')).toBe(false);
    expect(store.hasManagedProcessStartReservation(worktree.id, 'missing')).toBe(false);
  });

  test('RUNNING transition failure kills the group and terminalizes the created row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-supervisor-update-fault-'));
    const store = new FaultProcessStore();
    store.failRunningUpdate = true;
    let killedPgid = 0;
    let inspections = 0;
    const supervisor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      gracePeriodMs: 100,
      pollIntervalMs: 10,
      inspectProcess: async (pid) => { inspections += 1; return await inspectProcess(pid); },
      signalProcessGroup: (pgid, signal) => { killedPgid = pgid; process.kill(-pgid, signal); },
    });
    cleanups.push(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
    const descendantMarker = join(root, 'update-descendant-launched');
    await expect(supervisor.start({
      worktreeId: 'worktree-1', taskName: 'update-fault',
      argv: ['/bin/sh', '-c', `printf launched > '${descendantMarker}'; exec sleep 30`],
      cwd: root, env: process.env,
    })).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });

    expect(killedPgid).toBeGreaterThan(0);
    expect(inspections).toBeGreaterThanOrEqual(3);
    expect(store.listManagedProcesses()).toMatchObject([{ state: 'FAILED', cleanupRequired: false }]);
    await waitFor(async () => (await inspectProcessGroup(killedPgid)).status === 'absent');
    expect(await readFile(descendantMarker, 'utf8')).toBe('launched');
  });

  test('abort refusal plus KILL EPERM retains durable cleanup ownership and reports explicit failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-supervisor-abort-refusal-'));
    const store = new FaultProcessStore();
    store.createFailuresRemaining = 1;
    const signalError = Object.assign(new Error('denied'), { code: 'EPERM' });
    let stableAnchorIdentity: ProcessIdentity | null = null;
    const supervisor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      gracePeriodMs: 25,
      pollIntervalMs: 5,
      inspectProcess: async (pid) => {
        stableAnchorIdentity ??= await waitForIdentity(pid);
        return { status: 'present', identity: stableAnchorIdentity };
      },
      signalProcessGroup: () => { throw signalError; },
      anchorIgnoresAbort: true,
    });
    cleanups.push(async () => {
      const record = store.listManagedProcesses()[0];
      if (record !== undefined) {
        const current = await inspectProcessIdentity(record.pid);
        if (current !== null && identityMatches(record, current)) {
          try {
            process.kill(-record.pgid, 'SIGKILL');
            await waitFor(async () => (await inspectProcessGroup(record.pgid)).status === 'absent', 2_000);
          } catch (error) {
            if (!isNoSuchProcess(error)) throw error;
          }
        }
      }
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    });

    await expect(supervisor.start({
      worktreeId: 'worktree-1',
      taskName: 'abort-refusal',
      argv: ['/usr/bin/true'],
      cwd: root,
      env: process.env,
    })).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED', context: { reason: 'EPERM' } });

    const cleanupRecord = store.listManagedProcesses()[0];
    expect(cleanupRecord?.state).toBe('FAILED');
    expect(store.hasManagedProcessStartReservation('worktree-1', 'abort-refusal')).toBe(true);
    expect(cleanupRecord === undefined ? null : await inspectProcessIdentity(cleanupRecord.pid)).not.toBeNull();
  });

  test('restart holds ownership across stop and start against a competing supervisor', async () => {
    const { root, store, worktree, supervisor } = await setup(100);
    const input = {
      worktreeId: worktree.id,
      taskName: 'restart-race',
      argv: ['/bin/sleep', '30'],
      cwd: root,
      env: process.env,
    };
    const original = await supervisor.start(input);
    let blockInspection = true;
    let releaseInspection = () => {};
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    let announceInspection = () => {};
    const inspectionEntered = new Promise<void>((resolve) => { announceInspection = resolve; });
    const restarting = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      gracePeriodMs: 100,
      pollIntervalMs: 10,
      inspectProcess: async (pid) => {
        if (blockInspection) {
          blockInspection = false;
          announceInspection();
          await inspectionGate;
        }
        return await inspectProcess(pid);
      },
    });
    const competitor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      gracePeriodMs: 100,
      pollIntervalMs: 10,
    });
    cleanups.push(() => competitor.close(), () => restarting.close());

    const restartPromise = restarting.restart(input);
    await inspectionEntered;
    await expect(competitor.start(input)).rejects.toMatchObject({
      code: 'RUNTIME_START_FAILED', context: { reason: 'START_CONFLICT' },
    });
    releaseInspection();
    const restarted = await restartPromise;

    expect(restarted.record.id).not.toBe(original.record.id);
    expect(restarted.existing).toBe(false);
    expect(store.findActiveManagedProcess(worktree.id, 'restart-race')?.id).toBe(restarted.record.id);
    await competitor.stop({ worktreeId: worktree.id, taskName: 'restart-race' });
  });

  test('natural child exit updates state and preserves direct file logs', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const readyFile = join(root, 'natural.ready');
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'once',
      argv: ['node', '--import', tsxLoader, fixturePath, 'natural', readyFile, 'normal'],
      cwd: root,
      env: process.env,
    });

    let taskPid = 0;
    await waitFor(async () => {
      taskPid = Number.parseInt(await readFile(readyFile, 'utf8').catch(() => ''), 10);
      return Number.isSafeInteger(taskPid) && taskPid > 0;
    });
    process.kill(taskPid, 'SIGUSR1');
    await waitFor(() => store.getManagedProcess(started.record.id)?.state === 'STOPPED');
    expect(await readFile(started.record.stdoutPath, 'utf8')).toBe('natural stdout\n');
    expect(await readFile(started.record.stderrPath, 'utf8')).toBe('natural stderr\n');
  });

  test('anchor-owned writers rotate a fast stream without gaps or duplicate bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-rotation-'));
    const store = new MemoryProcessStore();
    const logs = new ManagedLogStore({ root: join(root, 'logs'), rotationBytes: 32, retainedFiles: 3 });
    const supervisor = createSupervisor({ stateStore: store, logs, pollIntervalMs: 10 });
    cleanups.push(async () => {
      for (const record of store.listManagedProcesses()) {
        const identity = await inspectProcessIdentity(record.pid);
        if (identity !== null && identityMatches(record, identity)) {
          try { process.kill(-record.pgid, 'SIGKILL'); } catch (error) { if (!isNoSuchProcess(error)) throw error; }
        }
      }
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    });
    const payload = Array.from({ length: 100 }, (_, index) => String(index % 10)).join('');

    const started = await supervisor.start({
      worktreeId: 'worktree-1',
      taskName: 'rotate-fast',
      argv: ['node', '-e', `process.stdout.write(${JSON.stringify(payload)})`],
      cwd: root,
      env: process.env,
    });
    await waitFor(() => store.getManagedProcess(started.record.id)?.state === 'STOPPED');
    const paths = [3, 2, 1].map((generation) => `${started.record.stdoutPath}.${generation}`)
      .concat(started.record.stdoutPath);
    const chunks = await Promise.all(paths.map((path) => readFile(path, 'utf8')));

    expect(chunks.join('')).toBe(payload);
    for (const path of paths) expect((await readFile(path)).byteLength).toBeLessThanOrEqual(32);
  });

  test.each([
      { name: 'marker', phase: 'marker', shifts: 0, archived: false, opened: false },
      { name: 'closed', phase: 'closed', shifts: 0, archived: false, opened: false },
      { name: 'oldest-only', phase: 'closed', shifts: 1, archived: false, opened: false },
      { name: 'oldest-and-newest', phase: 'closed', shifts: 2, archived: false, opened: false },
      { name: 'shifted', phase: 'shifted', shifts: 2, archived: false, opened: false },
      { name: 'shifted-current-absent', phase: 'shifted', shifts: 2, archived: true, opened: false },
      { name: 'archived', phase: 'archived', shifts: 2, archived: true, opened: false },
      { name: 'opened', phase: 'opened', shifts: 2, archived: true, opened: true },
    ] as const)('replacement anchor finishes partial retained-generation shift $name idempotently', async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-restart-rotation-'));
      const store = new MemoryProcessStore();
      const logs = new ManagedLogStore({ root: join(root, 'logs'), rotationBytes: 4, retainedFiles: 3 });
      const taskName = `restart-${scenario.name}`;
      const opened = await logs.open('worktree-1', taskName);
      await opened.stdout.write('B1--');
      await writeFile(`${opened.stdoutPath}.generation`, '1', { mode: 0o600 });
      const cursor = (await logs.readCursor(opened.stdoutPath)).cursor;
      await opened.close();
      await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
      await writeFile(opened.stdoutPath, 'B2--', { mode: 0o600 });
      await writeFile(`${opened.stdoutPath}.2`, 'B0--', { mode: 0o600 });
      await writeFile(`${opened.stdoutPath}.generation`, '2', { mode: 0o600 });
      if (scenario.shifts >= 1) await rename(`${opened.stdoutPath}.2`, `${opened.stdoutPath}.3`);
      if (scenario.shifts >= 2) await rename(`${opened.stdoutPath}.1`, `${opened.stdoutPath}.2`);
      if (scenario.archived) await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
      if (scenario.opened) await writeFile(opened.stdoutPath, '', { mode: 0o600 });
      await writeFile(`${opened.stdoutPath}.generation`, `rotating-2-${scenario.phase}-4242`, { mode: 0o600 });
      const supervisor = createSupervisor({ stateStore: store, logs, pollIntervalMs: 10 });
      cleanups.push(async () => {
        await supervisor.close();
        await rm(root, { recursive: true, force: true });
      });

      const started = await supervisor.start({
        worktreeId: 'worktree-1', taskName,
        argv: ['node', '-e', "process.stdout.write('B3--')"], cwd: root, env: process.env,
      });
      await waitFor(async () =>
        await readFile(opened.stdoutPath, 'utf8').catch(() => '') === 'B3--'
        && await readFile(`${opened.stdoutPath}.generation`, 'utf8').catch(() => '') === '3',
      10_000);
      const after = await logs.readCursor(opened.stdoutPath, cursor, 32);
      expect(after.content).toBe('B2--B3--');
      expect(await readFile(`${opened.stdoutPath}.generation`, 'utf8')).toBe('3');
      expect(await readFile(`${opened.stdoutPath}.1`, 'utf8')).toBe('B2--');
      expect(await readFile(`${opened.stdoutPath}.2`, 'utf8')).toBe('B1--');
      expect(await readFile(`${opened.stdoutPath}.3`, 'utf8')).toBe('B0--');

      const beforeRepeat = await Promise.all([
        opened.stdoutPath, `${opened.stdoutPath}.1`, `${opened.stdoutPath}.2`, `${opened.stdoutPath}.3`,
      ].map((path) => readFile(path, 'utf8')));
      if (scenario.name === 'oldest-and-newest') {
        await supervisor.stopRecord(started.record);
        await writeFile(`${opened.stdoutPath}.generation`, 'rotating-2-opened-repeat', { mode: 0o600 });
        await supervisor.start({
          worktreeId: 'worktree-1', taskName, argv: ['/usr/bin/true'], cwd: root, env: process.env,
        });
        expect(await Promise.all([
          opened.stdoutPath, `${opened.stdoutPath}.1`, `${opened.stdoutPath}.2`, `${opened.stdoutPath}.3`,
        ].map((path) => readFile(path, 'utf8')))).toEqual(beforeRepeat);
      }
  });

  test.each([
    { name: 'invalid marker', marker: 'not-a-generation', retained: true },
    { name: 'closed marker with missing current', marker: 'rotating-2-closed-4242', retained: true },
    { name: 'shifted marker without an archive', marker: 'rotating-2-shifted-4242', retained: false },
  ])('replacement anchor fails closed for $name', async ({ name, marker, retained }) => {
    const root = await mkdtemp(join(tmpdir(), `wtm-anchor-invalid-${name.replaceAll(' ', '-')}-`));
    const store = new MemoryProcessStore();
    const logs = new ManagedLogStore({ root: join(root, 'logs'), rotationBytes: 4, retainedFiles: 3 });
    const opened = await logs.open('worktree-1', 'invalid-recovery');
    await opened.stdout.write('B2--');
    await opened.close();
    if (retained) await rename(opened.stdoutPath, `${opened.stdoutPath}.1`);
    else await rm(opened.stdoutPath);
    await writeFile(`${opened.stdoutPath}.generation`, marker, { mode: 0o600 });
    const supervisor = createSupervisor({ stateStore: store, logs, pollIntervalMs: 10 });
    cleanups.push(async () => {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    });

    await expect(supervisor.start({
      worktreeId: 'worktree-1', taskName: 'invalid-recovery',
      argv: ['/usr/bin/true'], cwd: root, env: process.env,
    })).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED', context: { reason: 'LOG_SETUP_FAILED' } });
    if (retained) expect(await readFile(`${opened.stdoutPath}.1`, 'utf8')).toBe('B2--');
    else expect(await lstat(`${opened.stdoutPath}.1`).then(() => true, () => false)).toBe(false);
  });

  test('task leader exit leaves the anchor and record running until its descendant exits', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const pidFile = join(root, 'descendant.json');
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'descendant',
      argv: ['node', '--import', tsxLoader, fixturePath, 'parent', pidFile, 'exit-parent'],
      cwd: root,
      env: process.env,
    });
    const pids = await waitForJson(pidFile) as { parentPid: number; childPid: number };

    await waitFor(() => !pidExists(pids.parentPid));
    expect(pidExists(pids.childPid)).toBe(true);
    expect(store.getManagedProcess(started.record.id)?.state).toBe('RUNNING');
    await waitFor(async () => (await inspectProcess(started.record.pid)).status === 'present');

    const stopped = await supervisor.stop({ worktreeId: worktree.id, taskName: 'descendant' });
    expect(stopped.state).toBe('STOPPED');
    await waitFor(() => !pidExists(pids.childPid));
  });

  test('TERM-honoring task leader with TERM-ignoring descendant escalates through the verified anchor', async () => {
    const { root, worktree, supervisor } = await setup(500);
    const pidFile = join(root, 'child-ignore.json');
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'child-ignore',
      argv: ['node', '--import', tsxLoader, fixturePath, 'parent', pidFile, 'child-ignore'],
      cwd: root,
      env: process.env,
    });
    const pids = await waitForJson(pidFile) as { parentPid: number; childPid: number };

    const stopped = await supervisor.stop({ worktreeId: worktree.id, taskName: 'child-ignore' });

    expect(stopped.state).toBe('STOPPED');
    expect(started.record.pgid).toBe(started.record.pid);
    await waitFor(() => !pidExists(pids.parentPid) && !pidExists(pids.childPid));
  });

  test('a command that exits before identity inspection still gets a terminal non-signalable record', async () => {
    const { root, store, worktree, supervisor } = await setup();

    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'instant',
      argv: ['/usr/bin/true'],
      cwd: root,
      env: process.env,
    });

    await waitFor(() => !['STARTING', 'RUNNING', 'STOPPING'].includes(
      store.getManagedProcess(started.record.id)?.state ?? 'RUNNING',
    ), 10_000);
    expect(store.getManagedProcess(started.record.id)?.state).toBe('STOPPED');
    expect(store.findActiveManagedProcess(worktree.id, 'instant')).toBeNull();
    expect(await readFile(started.record.stdoutPath, 'utf8')).toBe('');
    expect(await readFile(started.record.stderrPath, 'utf8')).toBe('');
  });

  test('TERM-ignoring groups are KILLed only after an immediate identity recheck', async () => {
    const { root, worktree, supervisor } = await setup(500);
    const pidFile = join(root, 'ignore.json');
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'ignore',
      argv: ['node', '--import', tsxLoader, fixturePath, 'parent', pidFile, 'ignore-term'],
      cwd: root,
      env: process.env,
    });
    const pids = await waitForJson(pidFile) as { parentPid: number; childPid: number };

    const stopped = await supervisor.stop({ worktreeId: worktree.id, taskName: 'ignore' });

    expect(stopped.state).toBe('STOPPED');
    await waitFor(() => !pidExists(pids.parentPid) && !pidExists(pids.childPid));
    expect(started.record.pgid).not.toBe(pids.parentPid);
  });

  test('an identity race before escalation marks stale and does not send KILL', async () => {
    const { root, store, worktree } = await setup(30);
    let inspection = 0;
    const signaled: NodeJS.Signals[] = [];
    const identity: ProcessIdentity = {
      pid: 51001,
      pgid: 51001,
      processStartTime: 'start',
      commandFingerprint: 'fingerprint',
    };
    const record = store.createManagedProcess({
      worktreeId: worktree.id,
      taskName: 'race',
      ...identity,
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      stdoutPath: join(root, 'race.stdout.log'),
      stderrPath: join(root, 'race.stderr.log'),
    });
    const supervisor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs-race') }),
      gracePeriodMs: 1,
      pollIntervalMs: 1,
      inspectProcess: async (): Promise<ProcessInspection> => {
        inspection += 1;
        return { status: 'present', identity: inspection < 3 ? identity : { ...identity, processStartTime: 'reused' } };
      },
      inspectProcessGroup: async () => ({ status: 'present', pids: [identity.pid] }),
      signalProcessGroup: (_pgid, signal) => { signaled.push(signal); },
    });
    cleanups.push(() => supervisor.close());

    const stopped = await supervisor.stopRecord(record);

    expect(stopped.state).toBe('STALE_IDENTITY');
    expect(signaled).toEqual(['SIGTERM']);
  });

  test('inspection failure marks stop failed and never signals or claims stopped', async () => {
    const { root, store, worktree } = await setup();
    const record = store.createManagedProcess({
      worktreeId: worktree.id,
      taskName: 'inspection-failure',
      pid: 51002,
      pgid: 51002,
      processStartTime: 'start',
      commandFingerprint: 'fingerprint',
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      stdoutPath: join(root, 'failure.stdout.log'),
      stderrPath: join(root, 'failure.stderr.log'),
    });
    const signals: NodeJS.Signals[] = [];
    const supervisor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs-failure') }),
      inspectProcess: async () => ({ status: 'failed', reason: 'PS_PERMISSION' }),
      signalProcessGroup: (_pgid, signal) => { signals.push(signal); },
    });
    cleanups.push(() => supervisor.close());

    await expect(supervisor.stopRecord(record)).rejects.toMatchObject({ code: 'RUNTIME_STOP_FAILED' });
    expect(store.getManagedProcess(record.id)?.state).toBe('FAILED');
    expect(signals).toEqual([]);
  });

  test('daemon recovery verifies stored identities without adopting them', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const pidFile = join(root, 'recovery.json');
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'recover',
      argv: ['node', '--import', tsxLoader, fixturePath, 'parent', pidFile, 'normal'],
      cwd: root,
      env: process.env,
    });
    await waitForJson(pidFile);
    const stale = store.createManagedProcess({
      ...started.record,
      taskName: 'old',
      commandFingerprint: 'wrong',
      state: 'RUNNING',
    });
    store.forceRecord(started.record.id, { cleanupOwnerToken: 'crashed-owner' });
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    expect(store.reserveManagedProcessStart(
      worktree.id,
      'recover',
      'crashed-owner',
      new Date(Date.now() - 2_000).toISOString(),
      { expiresAt: expiredAt, replaceProcessId: started.record.id },
    )).toBe(true);

    const recovered = await supervisor.recover();

    expect(store.getManagedProcess(started.record.id)?.state).toBe('RUNNING');
    expect(recovered.map(({ state }) => state).sort()).toEqual(['RUNNING', 'STALE_IDENTITY']);
    expect(store.getManagedProcess(stale.id)?.state).toBe('STALE_IDENTITY');
    expect(store.hasManagedProcessStartReservation(worktree.id, 'recover')).toBe(false);
    await supervisor.stop({ worktreeId: worktree.id, taskName: 'recover' });
  });

  test('recovery releases a crash-left lease for a verified live RUNNING anchor', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const input = {
      worktreeId: worktree.id,
      taskName: 'crash-running',
      argv: ['/bin/sleep', '30'],
      cwd: root,
      env: process.env,
    };
    const started = await supervisor.start(input);
    store.forceRecord(started.record.id, { cleanupOwnerToken: 'crashed-token' });
    expect(store.reserveManagedProcessStart(
      worktree.id,
      input.taskName,
      'crashed-token',
      new Date().toISOString(),
      { expiresAt: new Date(Date.now() + 60_000).toISOString(), replaceProcessId: started.record.id },
    )).toBe(true);

    await supervisor.recover();

    expect(store.hasManagedProcessStartReservation(worktree.id, input.taskName)).toBe(false);
    const existing = await supervisor.start(input);
    expect(existing.existing).toBe(true);
    expect(existing.record.id).toBe(started.record.id);
    await supervisor.stop({ worktreeId: worktree.id, taskName: input.taskName });
  });

  test('recovery never releases a different owner token for a live RUNNING anchor', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'other-owner',
      argv: ['/bin/sleep', '30'],
      cwd: root,
      env: process.env,
    });
    expect(store.reserveManagedProcessStart(
      worktree.id,
      'other-owner',
      'different-owner-token',
      new Date().toISOString(),
      { expiresAt: new Date(Date.now() + 60_000).toISOString(), replaceProcessId: started.record.id },
    )).toBe(true);

    await supervisor.recover();

    expect(store.hasManagedProcessStartReservation(worktree.id, 'other-owner')).toBe(true);
    expect(store.releaseManagedProcessStart(worktree.id, 'other-owner', 'different-owner-token')).toBe(true);
    await supervisor.stop({ worktreeId: worktree.id, taskName: 'other-owner' });
  });

  test('reclaims only an expired restart lease tied to the exact verified old process', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const input = { worktreeId: worktree.id, taskName: 'restart-crash', argv: ['/bin/sleep', '30'], cwd: root, env: process.env };
    const started = await supervisor.start(input);
    let now = new Date('2026-08-27T12:00:05.000Z');
    store.forceReservation(worktree.id, input.taskName, 'restart-owner', '2026-08-27T12:00:10.000Z', started.record.id);
    const recovered = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      now: () => now,
      pollIntervalMs: 10,
    });
    cleanups.push(() => recovered.close());

    await expect(recovered.start(input)).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });
    expect(store.hasManagedProcessStartReservation(worktree.id, input.taskName)).toBe(true);
    now = new Date('2026-08-27T12:00:11.000Z');
    const existing = await recovered.start(input);

    expect(existing).toMatchObject({ existing: true, record: { id: started.record.id } });
    expect(store.hasManagedProcessStartReservation(worktree.id, input.taskName)).toBe(false);
    await supervisor.stop({ worktreeId: worktree.id, taskName: input.taskName });
  });

  test('keeps expired restart leases when replacement identity is mismatched or unavailable', async () => {
    for (const inspection of [
      { status: 'present', identity: { pid: 52000, pgid: 52000, processStartTime: 'reused', commandFingerprint: 'wrong' } } as ProcessInspection,
      { status: 'failed', reason: 'PS_DENIED' } as ProcessInspection,
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'wtm-restart-closed-'));
      const store = new MemoryProcessStore();
      const record = store.createManagedProcess({
        worktreeId: 'wt', taskName: 'dev', pid: 52000, pgid: 52000,
        processStartTime: 'original', commandFingerprint: 'fingerprint', state: 'RUNNING',
        startedAt: '2026-08-27T12:00:00.000Z', stoppedAt: null,
        stdoutPath: join(root, 'logs/wt/dev/stdout.log'), stderrPath: join(root, 'logs/wt/dev/stderr.log'),
      });
      store.forceReservation('wt', 'dev', 'restart-owner', '2026-08-27T12:00:01.000Z', record.id);
      const candidate = createSupervisor({
        stateStore: store, logs: new ManagedLogStore({ root: join(root, 'logs') }),
        now: () => new Date('2026-08-27T12:00:02.000Z'), inspectProcess: async () => inspection,
      });
      await expect(candidate.start({ worktreeId: 'wt', taskName: 'dev', argv: ['/bin/true'], cwd: root }))
        .rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });
      expect(store.hasManagedProcessStartReservation('wt', 'dev')).toBe(true);
      await candidate.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not reclaim an expired ordinary start lease from a verified live process', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const input = { worktreeId: worktree.id, taskName: 'ordinary-lease', argv: ['/bin/sleep', '30'], cwd: root, env: process.env };
    await supervisor.start(input);
    store.forceReservation(worktree.id, input.taskName, 'ordinary-owner', '2000-01-01T00:00:00.000Z');

    await expect(supervisor.start(input)).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });
    expect(store.hasManagedProcessStartReservation(worktree.id, input.taskName)).toBe(true);
    await supervisor.stop({ worktreeId: worktree.id, taskName: input.taskName });
  });

  test('recovery promotes a launch-acknowledged STARTING anchor and releases its matching lease', async () => {
    const { root, store, worktree, supervisor } = await setup();
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'crash-after-launch',
      argv: ['/bin/sleep', '30'],
      cwd: root,
      env: process.env,
    });
    const token = 'launch-crash-token';
    store.forceRecord(started.record.id, {
      state: 'STARTING', stoppedAt: null, cleanupRequired: true, cleanupOwnerToken: token,
    });
    expect(store.reserveManagedProcessStart(
      worktree.id,
      'crash-after-launch',
      token,
      new Date().toISOString(),
      { expiresAt: new Date(Date.now() + 60_000).toISOString(), replaceProcessId: started.record.id },
    )).toBe(true);

    const recovered = await supervisor.recover();

    expect(recovered.find(({ id }) => id === started.record.id)).toMatchObject({
      state: 'RUNNING', cleanupRequired: false,
    });
    expect(store.hasManagedProcessStartReservation(worktree.id, 'crash-after-launch')).toBe(false);
    await supervisor.stop({ worktreeId: worktree.id, taskName: 'crash-after-launch' });
  });

  test('recovery terminates a verified live cleanup-owned FAILED anchor and releases its lease', async () => {
    const { root, store, worktree, supervisor } = await setup(50);
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'cleanup-crash',
      argv: ['node', '--import', tsxLoader, fixturePath, 'member', 'unused', 'normal'],
      cwd: root,
      env: process.env,
    });
    store.forceRecord(started.record.id, {
      state: 'FAILED', stoppedAt: new Date().toISOString(), cleanupRequired: true,
      cleanupOwnerToken: 'cleanup-token',
    });
    expect(store.reserveManagedProcessStart(
      worktree.id,
      'cleanup-crash',
      'cleanup-token',
      new Date().toISOString(),
      { expiresAt: new Date(Date.now() - 1).toISOString() },
    )).toBe(true);

    const recovered = await supervisor.recover();

    expect(recovered.find(({ id }) => id === started.record.id)).toMatchObject({ state: 'FAILED' });
    await waitFor(async () => (await inspectProcessGroup(started.record.pgid)).status === 'absent');
    if (store.hasManagedProcessStartReservation(worktree.id, 'cleanup-crash')) await supervisor.recover();
    expect(store.hasManagedProcessStartReservation(worktree.id, 'cleanup-crash')).toBe(false);
  });

  test('daemon close leaves the anchor-owned writer rotating while recovery remains read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-supervisor-recover-logs-'));
    const store = new MemoryProcessStore();
    const worktree = { id: 'worktree-1' };
    const logsRoot = join(root, 'logs');
    const supervisor = createSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: logsRoot, rotationBytes: 64, retainedFiles: 3 }),
      gracePeriodMs: 100,
      pollIntervalMs: 10,
    });
    const started = await supervisor.start({
      worktreeId: worktree.id,
      taskName: 'recover-logs',
      argv: ['node', '-e', "let n=0;setInterval(()=>process.stdout.write(String(n++).padStart(8,'0')),5)"],
      cwd: root,
      env: process.env,
    });
    await supervisor.close();
    expect(await inspectProcessIdentity(started.record.pid)).not.toBeNull();

    const recoveredLogs = new ManagedLogStore({
      root: logsRoot, rotationBytes: 64, retainedFiles: 3,
    });
    const recoveredSupervisor = createSupervisor({
      stateStore: store,
      logs: recoveredLogs,
      gracePeriodMs: 100,
      pollIntervalMs: 10,
    });
    cleanups.push(async () => {
      const current = await inspectProcessIdentity(started.record.pid);
      if (current !== null && identityMatches(started.record, current)) {
        try { process.kill(-started.record.pgid, 'SIGKILL'); } catch (error) { if (!isNoSuchProcess(error)) throw error; }
      }
      await recoveredSupervisor.close();
      await rm(root, { recursive: true, force: true });
    });

    const recovered = await recoveredSupervisor.recover();
    await waitFor(async () => readFile(`${started.record.stdoutPath}.1`, 'utf8').then(() => true, () => false));

    expect(recovered[0]?.state).toBe('RUNNING');
    expect((await readFile(`${started.record.stdoutPath}.1`)).byteLength).toBeLessThanOrEqual(64);
    expect((await readFile(started.record.stdoutPath)).byteLength).toBeLessThanOrEqual(64);
    await recoveredSupervisor.stop({ worktreeId: worktree.id, taskName: 'recover-logs' });
  });
});

async function waitForJson(path: string): Promise<unknown> {
  let value = '';
  await waitFor(async () => {
    try { value = await readFile(path, 'utf8'); return value.length > 0; } catch { return false; }
  });
  return JSON.parse(value);
}

async function waitForIdentity(pid: number): Promise<ProcessIdentity> {
  let identity: ProcessIdentity | null = null;
  await waitFor(async () => { identity = await inspectProcessIdentity(pid); return identity !== null; });
  if (identity === null) throw new Error('Process identity unavailable');
  return identity;
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function identityMatches(record: ManagedProcessRecord, identity: ProcessIdentity): boolean {
  return record.pid === identity.pid
    && record.pgid === identity.pgid
    && record.processStartTime === identity.processStartTime
    && record.commandFingerprint === identity.commandFingerprint;
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid
    && left.pgid === right.pgid
    && left.processStartTime === right.processStartTime
    && left.commandFingerprint === right.commandFingerprint;
}
