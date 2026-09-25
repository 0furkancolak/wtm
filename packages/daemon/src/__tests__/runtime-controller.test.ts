import { describe, expect, test } from 'bun:test';
import {
  defaultMaxIpcFrameBytes,
  encodeFrame,
  jsonEnvelopeSchema,
  protocolVersion,
  type IpcRequest,
} from '@wtm/protocol';
import {
  WtmTaskResolutionError,
  WtmTemplateError,
  type ManagedProcessRecord,
  type ResolvedTask,
} from '@wtm/core';
import { DaemonRegistrationError, DaemonRuntimeController, type DaemonRuntimeResolver } from '../runtime-controller';

const processRecord: ManagedProcessRecord = {
  id: 'process-1',
  worktreeId: 'worktree-7',
  taskName: 'dev',
  pid: 42001,
  pgid: 42001,
  processStartTime: 'start',
  commandFingerprint: 'fingerprint',
  state: 'RUNNING',
  startedAt: '2026-08-27T09:00:00.000Z',
  stoppedAt: null,
  stdoutPath: '/logs/stdout.log',
  stderrPath: '/logs/stderr.log',
  cleanupRequired: false,
};

const task: ResolvedTask = {
  argv: ['node', 'server.js'],
  shell: false,
  cwd: '/repo/wt',
  envDelta: { PORT: '24007' },
  background: true,
  singleton: true,
};

function request(command: string, args: unknown): IpcRequest {
  return { protocol: protocolVersion, id: 'request-1', command, arguments: args };
}

describe('DaemonRuntimeController', () => {
  test('routes managed operations through resolved worktree and task context', async () => {
    const calls: Array<[string, unknown]> = [];
    const controller = new DaemonRuntimeController({
      supervisor: {
        start: async (input) => { calls.push(['start', input]); return { record: processRecord, existing: false }; },
        restart: async (input) => { calls.push(['restart', input]); return { record: processRecord, existing: false }; },
        stop: async (input) => { calls.push(['stop', input]); return { ...processRecord, state: 'STOPPED' }; },
        stopAll: async (worktreeId) => { calls.push(['stopAll', worktreeId]); return [{ ...processRecord, state: 'STOPPED' }]; },
        list: (worktreeId) => { calls.push(['list', worktreeId]); return [processRecord]; },
      },
      logs: { read: async (path, limit) => `${path}:${limit}` },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: { WTM_WORKTREE_ID: '7' } }),
      },
    });

    const envelopes = await Promise.all([
      controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' })),
      controller.handle(request('restart', { cwd: '/repo/wt', taskName: 'dev' })),
      controller.handle(request('stop', { cwd: '/repo/wt', taskName: 'dev' })),
      controller.handle(request('stop', { cwd: '/repo/wt' })),
      controller.handle(request('ps', { cwd: '/repo/wt' })),
      controller.handle(request('logs', { cwd: '/repo/wt', taskName: 'dev', follow: false })),
    ]);

    expect(envelopes.every((envelope) => jsonEnvelopeSchema.safeParse(envelope).success)).toBe(true);
    expect(envelopes.map(({ command }) => command)).toEqual(['start', 'restart', 'stop', 'stop', 'ps', 'logs']);
    // A budget admission check reads `list()` before `start`, so `start` is no longer
    // necessarily the very first recorded call.
    expect(calls.find(([name]) => name === 'start')).toEqual(['start', {
      worktreeId: 'worktree-7',
      taskName: 'dev',
      argv: ['node', 'server.js'],
      cwd: '/repo/wt',
      env: { ...process.env, PORT: '24007' },
      shell: false,
    }]);
    expect(envelopes[5]?.data).toEqual({ logs: [{
      processId: 'process-1',
      taskName: 'dev',
      stdout: '/logs/stdout.log:65536',
      stderr: '/logs/stderr.log:65514',
    }] });
  });

  test('exec preserves raw argv and only resolves cwd and environment', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: { SAFE: '$HOME; rm literal' } }),
      },
    });
    const argv = ['printf', '%s', '$HOME; touch /tmp/not-created'];

    const envelope = await controller.handle(request('exec', { cwd: '/repo/wt/subdir', argv }));

    expect(envelope.data).toEqual({ argv, cwd: '/repo/wt', envDelta: { SAFE: '$HOME; rm literal' } });
  });

  test('rejects invalid requests and never exposes thrown secrets or stacks', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => { throw new Error('secret=/Users/private stack trace'); },
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const invalid = await controller.handle(request('exec', { cwd: '/repo/wt', argv: [] }));
    const failed = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(invalid.errors[0]?.code).toBe('WTM_DAEMON_INVALID_REQUEST');
    expect(failed.errors).toEqual([{
      code: 'WTM_DAEMON_REQUEST_FAILED',
      message: 'Runtime request failed.',
      severity: 'error',
      context: { command: 'start' },
    }]);
    expect(JSON.stringify(failed)).not.toContain('private');
    expect(JSON.stringify(failed)).not.toContain('stack trace');
  });

  test('reports a resolution failure by its own code and message', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => {
          throw new WtmTaskResolutionError('Unknown task: dev', { taskName: 'dev' });
        },
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const failed = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(failed.errors).toEqual([{
      code: 'WTM_CONFIG_INVALID',
      message: 'Unknown task: dev',
      severity: 'error',
      context: { command: 'start', taskName: 'dev' },
    }]);
  });

  test('reports an unregistered directory as a missing workspace, not a daemon failure', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => { throw new DaemonRegistrationError('Not registered.'); },
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const failed = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(failed.errors[0]).toMatchObject({
      code: 'WTM_WORKSPACE_NOT_FOUND',
      message: 'Not registered.',
    });
  });

  test('names the configuration mistake behind an unresolvable template', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => { throw new WtmTemplateError('port.api'); },
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const failed = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    // Referring to an endpoint the workspace never configured is a one-line mistake, and used
    // to arrive as "Runtime request failed", which names neither the line nor the endpoint.
    expect(failed.errors[0]).toMatchObject({
      code: 'WTM_TEMPLATE_UNRESOLVED',
      message: 'Unable to resolve template variable {port.api}.',
      context: { command: 'start', variable: 'port.api' },
    });
  });

  test('reports both the workspace and the worktree a runtime command acted on', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    // A workspace holds many worktrees, so the worktree id alone answered a different question
    // from the one the field name asks.
    expect((await controller.handle(request('ps', { cwd: '/repo/wt' }))).scope)
      .toEqual({ mode: 'local', workspaceId: 'workspace-1', worktreeId: 'worktree-7' });
  });

  test('ps lists live runs and each task\'s latest crash by default, and every run with all', async () => {
    const row = (id: string, taskName: string, state: ManagedProcessRecord['state'], extra: Partial<ManagedProcessRecord> = {}) => ({
      ...processRecord, id, taskName, state, startedAt: `2026-09-25T07:0${id.slice(-1)}:00.000Z`,
      stoppedAt: state === 'RUNNING' || state === 'STALE_IDENTITY' ? null : '2026-09-25T08:00:00.000Z', ...extra,
    }) as ManagedProcessRecord;
    const records = [
      row('run-1', 'dev', 'STOPPED'),
      row('run-2', 'dev', 'FAILED', { exitCode: 1 }),
      row('run-3', 'dev', 'RUNNING'),
      row('run-4', 'api', 'STOPPED'),
      row('run-5', 'api', 'FAILED', { exitCode: 1, cleanupOwnerToken: 'reservation-secret' }),
      row('run-6', 'web', 'FAILED', { exitSignal: 'SIGKILL' }),
      row('run-7', 'web', 'STOPPED'),
      row('run-8', 'worker', 'STALE_IDENTITY'),
      row('run-9', 'queue', 'FAILED', { cleanupRequired: true }),
    ];
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => records },
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const live = await controller.handle(request('ps', { cwd: '/repo/wt' }));
    const every = await controller.handle(request('ps', { cwd: '/repo/wt', all: true }));

    // A clean stop is history; a crash stays visible until the task is started again.
    expect((live.data as { processes: ManagedProcessRecord[] }).processes.map(({ id }) => id))
      .toEqual(['run-3', 'run-5', 'run-8', 'run-9']);
    expect((live.data as { omitted: number }).omitted).toBe(5);
    expect((every.data as { processes: ManagedProcessRecord[] }).processes).toHaveLength(9);
    expect(every.data).not.toHaveProperty('omitted');
    // The reservation token is a capability to release a start, not something to print.
    expect(JSON.stringify([live, every])).not.toContain('reservation-secret');
  });

  test('ps marks a running record whose task already exited, while what it left behind lingers', async () => {
    const records = [
      { ...processRecord, id: 'run-1', taskName: 'api', state: 'RUNNING', stoppedAt: null },
      { ...processRecord, id: 'run-2', taskName: 'web', state: 'RUNNING', stoppedAt: null },
    ] as ManagedProcessRecord[];
    const controller = new DaemonRuntimeController({
      supervisor: {
        ...noProcesses(),
        list: () => records,
        taskExit: async (record) => record.id === 'run-1'
          ? { pid: record.pid, exitCode: 1, signal: null, exitedAt: '2026-09-25T07:27:11.000Z' }
          : null,
      },
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const processes = ((await controller.handle(request('ps', { cwd: '/repo/wt' }))).data as {
      processes: Array<ManagedProcessRecord & { taskExited?: unknown }>;
    }).processes;

    expect(processes.find(({ id }) => id === 'run-1')?.taskExited)
      .toEqual({ exitCode: 1, signal: null, exitedAt: '2026-09-25T07:27:11.000Z' });
    expect(processes.find(({ id }) => id === 'run-2')).not.toHaveProperty('taskExited');
  });

  test('strictly rejects command-specific unknown argument keys before resolution', async () => {
    let resolutions = 0;
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => { resolutions += 1; return { workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }; },
        resolveWorktree: async () => { resolutions += 1; return { workspaceId: 'workspace-1', worktreeId: 'worktree-7' }; },
        resolveExec: async () => { resolutions += 1; return { cwd: '/repo/wt', envDelta: {} }; },
      },
    });

    const invalid = await Promise.all([
      controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev', secret: true })),
      controller.handle(request('ps', { cwd: '/repo/wt', taskName: 'extra' })),
      controller.handle(request('logs', { cwd: '/repo/wt', follow: false, offset: 1 })),
      controller.handle(request('exec', { cwd: '/repo/wt', argv: ['true'], shell: true })),
    ]);

    expect(invalid.every((envelope) => envelope.errors[0]?.code === 'WTM_DAEMON_INVALID_REQUEST')).toBe(true);
    expect(resolutions).toBe(0);
  });

  test('bounds aggregate multi-task log data below the IPC frame limit', async () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      ...processRecord,
      id: `process-${index}`,
      taskName: `task-${index}`,
      stdoutPath: `/logs/${index}.stdout.log`,
      stderrPath: `/logs/${index}.stderr.log`,
    }));
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => records },
      logs: { read: async () => '🧪'.repeat(300_000) },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const envelope = await controller.handle(request('logs', { cwd: '/repo/wt', follow: false }));
    const response = { protocol: protocolVersion, id: 'request-1', envelope };

    expect((envelope.data as { truncated: boolean }).truncated).toBe(true);
    expect(() => encodeFrame(Buffer.from(JSON.stringify(response)), defaultMaxIpcFrameBytes)).not.toThrow();
  });

  test('accounts for worst-case JSON escaping across both streams and multiple tasks', async () => {
    const records = Array.from({ length: 128 }, (_, index) => ({
      ...processRecord,
      id: `control-${index}`,
      taskName: `control-task-${index}`,
      stdoutPath: `/logs/control-${index}.stdout.log`,
      stderrPath: `/logs/control-${index}.stderr.log`,
    }));
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => records },
      logs: { read: async () => '\0\b\f\n\r\t'.repeat(100_000) },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'w'.repeat(10_000) }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const maximumId = 'i'.repeat(128);
    const envelope = await controller.handle({
      ...request('logs', { cwd: '/repo/wt', follow: false }),
      id: maximumId,
    });
    const response = { protocol: protocolVersion, id: maximumId, envelope };

    expect((envelope.scope?.workspaceId ?? '').length).toBeLessThanOrEqual(128);
    expect(() => encodeFrame(Buffer.from(JSON.stringify(response)), defaultMaxIpcFrameBytes)).not.toThrow();
  });

  test('retains requested cursors for tasks receiving no remaining aggregate budget', async () => {
    const records = ['first', 'second'].map((taskName, index) => ({
      ...processRecord,
      id: `process-${index}`,
      taskName,
      stdoutPath: `/logs/${index}.stdout.log`,
      stderrPath: `/logs/${index}.stderr.log`,
    }));
    const calls: string[] = [];
    const retained = { dev: 9, ino: 8, offset: 7, generation: '4' };
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => records },
      logs: {
        read: async () => '',
        readCursor: async (path, _cursor, limit = 0) => {
          calls.push(path);
          return {
            content: 'x'.repeat(limit),
            cursor: { dev: 1, ino: 2, offset: limit, rotated: false },
          };
        },
      },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const envelope = await controller.handle(request('logs', {
      cwd: '/repo/wt',
      follow: false,
      cursors: { 'process-1': { stdout: retained, stderr: retained } },
    }));
    const entries = (envelope.data as { logs: Array<{ cursors: unknown }> }).logs;

    expect(calls).toEqual(['/logs/0.stdout.log']);
    expect(entries[1]?.cursors).toEqual({ stdout: retained, stderr: retained });
  });

  test('strictly accepts per-stream cursors and returns bounded deltas with next cursors', async () => {
    const reads: unknown[] = [];
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => [processRecord] },
      logs: {
        read: async () => { throw new Error('cursor reader must be used'); },
        readCursor: async (path, cursor, limit) => {
          reads.push({ path, cursor, limit });
          return {
            content: path.includes('stdout') ? 'next-out' : 'next-err',
            cursor: { dev: 1, ino: path.includes('stdout') ? 2 : 3, offset: 12, rotated: false },
          };
        },
      },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });
    const stdoutCursor = { dev: 1, ino: 2, offset: 4 };

    const envelope = await controller.handle(request('logs', {
      cwd: '/repo/wt',
      taskName: 'dev',
      follow: false,
      cursors: { 'process-1': { stdout: stdoutCursor } },
    }));

    expect(reads).toEqual([
      { path: '/logs/stdout.log', cursor: stdoutCursor, limit: 64 * 1024 },
      { path: '/logs/stderr.log', cursor: undefined, limit: (64 * 1024) - 8 },
    ]);
    expect(envelope.data).toMatchObject({ logs: [{
      stdout: 'next-out',
      stderr: 'next-err',
      cursors: {
        stdout: { dev: 1, ino: 2, offset: 12, rotated: false },
        stderr: { dev: 1, ino: 3, offset: 12, rotated: false },
      },
    }] });
  });

  test('reports a stale stop identity as a runtime safety failure', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: {
        ...noProcesses(),
        stop: async () => ({ ...processRecord, state: 'STALE_IDENTITY' }),
      },
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
    });

    const envelope = await controller.handle(request('stop', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]).toEqual({
      code: 'RUNTIME_PROCESS_IDENTITY_STALE',
      message: 'Managed process identity is stale.',
      severity: 'error',
      context: { command: 'stop', processId: 'process-1', taskName: 'dev', worktreeId: 'worktree-7' },
    });
  });
  /**
   * Idle suspension (`[tasks.<name>.idle]`, todo item 14) dates its window from these calls and
   * from nothing else — WTM has no reverse proxy, so traffic to the task's own port never reaches
   * the daemon. What the daemon *can* see is asserted here so the docs' claim about which
   * interactions count stays a claim the code keeps.
   */
  test('reports every task a request observed, so an idle window can be dated from it', async () => {
    const observed: Array<[string, string | undefined]> = [];
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => [processRecord] },
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-7',
          workspaceWorktreeIds: ['worktree-7', 'worktree-8'],
        }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
      onTaskActivity: (worktreeId, taskName) => { observed.push([worktreeId, taskName]); },
    });

    await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));
    await controller.handle(request('restart', { cwd: '/repo/wt', taskName: 'dev' }));
    await controller.handle(request('logs', { cwd: '/repo/wt', follow: false }));
    await controller.handle(request('ps', { cwd: '/repo/wt' }));
    // Neither is an observation of a managed task: `exec` runs raw argv in the foreground, and a
    // stop ends the run whose window would have been extended.
    await controller.handle(request('exec', { cwd: '/repo/wt', argv: ['ls'] }));
    await controller.handle(request('stop', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(observed).toEqual([
      ['worktree-7', 'dev'],
      ['worktree-7', 'dev'],
      ['worktree-7', 'dev'],
      // `ps` asks about a whole workspace scope at once, and names no single task.
      ['worktree-7', undefined],
      ['worktree-8', undefined],
    ]);
  });

  test('an activity listener that throws never costs the request that reported it', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      },
      onTaskActivity: () => { throw new Error('idle bookkeeping failed'); },
    });

    const envelope = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(true);
  });
});

describe('DaemonRuntimeController budgets', () => {
  function resolver() {
    return {
      resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
      resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
      resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
    };
  }

  test('refuses a start that would exceed the configured process budget', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: resolver(),
      budgets: { maxProcesses: 0 },
    });

    const envelope = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]).toMatchObject({
      code: 'RUNTIME_PROCESS_BUDGET_EXCEEDED',
      context: { taskName: 'dev', worktreeId: 'worktree-7', limit: 0, current: 0 },
    });
  });

  test('never refuses a restart of an already-active task on the process budget', async () => {
    let started = false;
    const controller = new DaemonRuntimeController({
      supervisor: {
        ...noProcesses(),
        restart: async () => { started = true; return { record: processRecord, existing: true }; },
        list: () => [processRecord],
      },
      logs: { read: async () => '' },
      resolver: resolver(),
      // The one already-active process (`processRecord`, task "dev") is exactly at the limit,
      // so a fresh start would be refused, but replacing it in place must not be.
      budgets: { maxProcesses: 1 },
    });

    const envelope = await controller.handle(request('restart', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(true);
    expect(started).toBe(true);
  });

  test('refuses a start that would drop host available memory below the configured floor', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: resolver(),
      budgets: { minAvailableMemoryBytes: 512 * 1024 * 1024 },
      readMemory: () => ({ availableBytes: 100 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 }),
    });

    const envelope = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]).toMatchObject({
      code: 'RUNTIME_MEMORY_BUDGET_EXCEEDED',
      context: { taskName: 'dev', worktreeId: 'worktree-7', floorMib: 512, availableMib: 100 },
    });
  });

  test('fails open when the host memory reading is unavailable', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: resolver(),
      budgets: { minAvailableMemoryBytes: 512 * 1024 * 1024 },
      readMemory: () => ({ availableBytes: null, totalBytes: null }),
    });

    const envelope = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(true);
  });

  test('leaves both budgets unenforced when neither is configured', async () => {
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: resolver(),
    });

    const envelope = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(true);
  });

  test('does not admit two concurrent starts past the process budget (TOCTOU regression)', async () => {
    // `supervisor.list()` never grows here on purpose — it stays `[]` for the whole test, so the
    // only thing that can make the second concurrent request see the first one is the
    // controller's own in-flight reservation. Without it, both requests read the same `length: 0`
    // between their `resolveTask` await and their `supervisor.start` await, and both are admitted
    // against a budget of 1.
    let concurrentStarts = 0;
    let maxConcurrentStarts = 0;
    const controller = new DaemonRuntimeController({
      supervisor: {
        ...noProcesses(),
        start: async () => {
          concurrentStarts += 1;
          maxConcurrentStarts = Math.max(maxConcurrentStarts, concurrentStarts);
          await Promise.resolve();
          concurrentStarts -= 1;
          return { record: processRecord, existing: false };
        },
      },
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-7' }),
        resolveExec: async () => ({ cwd: '/repo/wt', envDelta: {} }),
      } satisfies DaemonRuntimeResolver,
      budgets: { maxProcesses: 1 },
    });

    const [first, second] = await Promise.all([
      controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' })),
      controller.handle(request('start', { cwd: '/repo/wt', taskName: 'build' })),
    ]);
    const outcomes = [first, second];

    expect(outcomes.filter((envelope) => envelope.ok)).toHaveLength(1);
    const refused = outcomes.find((envelope) => !envelope.ok);
    expect(refused?.errors[0]).toMatchObject({ code: 'RUNTIME_PROCESS_BUDGET_EXCEEDED' });
    expect(maxConcurrentStarts).toBeLessThanOrEqual(1);
  });

  test('does not count stopped/failed history toward the process budget — only currently-active processes', async () => {
    // `list()` never prunes: every stop/restart leaves its row behind for `wtm ps`/`wtm logs`
    // history. A daemon whose cumulative lifetime start count has crossed the budget, but has
    // nothing running right now, must still admit a start.
    const history: ManagedProcessRecord[] = [
      { ...processRecord, id: 'process-old-1', state: 'STOPPED' },
      { ...processRecord, id: 'process-old-2', state: 'FAILED' },
      { ...processRecord, id: 'process-old-3', state: 'STOPPED' },
    ];
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => history },
      logs: { read: async () => '' },
      resolver: resolver(),
      budgets: { maxProcesses: 1 },
    });

    const envelope = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(true);
  });

  test('still refuses a start once currently-active processes alone reach the budget', async () => {
    const history: ManagedProcessRecord[] = [
      { ...processRecord, id: 'process-old-1', state: 'STOPPED' },
      { ...processRecord, id: 'process-active', taskName: 'build', state: 'RUNNING' },
    ];
    const controller = new DaemonRuntimeController({
      supervisor: { ...noProcesses(), list: () => history },
      logs: { read: async () => '' },
      resolver: resolver(),
      budgets: { maxProcesses: 1 },
    });

    const envelope = await controller.handle(request('start', { cwd: '/repo/wt', taskName: 'dev' }));

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]).toMatchObject({ code: 'RUNTIME_PROCESS_BUDGET_EXCEEDED', context: { current: 1, limit: 1 } });
  });
});

function noProcesses() {
  return {
    start: async () => ({ record: processRecord, existing: false }),
    restart: async () => ({ record: processRecord, existing: false }),
    stop: async () => processRecord,
    stopAll: async () => [],
    list: () => [],
  };
}
