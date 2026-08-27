import { describe, expect, test } from 'bun:test';
import {
  defaultMaxIpcFrameBytes,
  encodeFrame,
  jsonEnvelopeSchema,
  protocolVersion,
  type IpcRequest,
} from '@wtm/protocol';
import type { ManagedProcessRecord, ResolvedTask } from '@wtm/core';
import { DaemonRuntimeController } from '../runtime-controller';

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
        resolveTask: async () => ({ worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ worktreeId: 'worktree-7' }),
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
    expect(calls[0]).toEqual(['start', {
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
        resolveTask: async () => ({ worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ worktreeId: 'worktree-7' }),
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
        resolveWorktree: async () => ({ worktreeId: 'worktree-7' }),
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

  test('strictly rejects command-specific unknown argument keys before resolution', async () => {
    let resolutions = 0;
    const controller = new DaemonRuntimeController({
      supervisor: noProcesses(),
      logs: { read: async () => '' },
      resolver: {
        resolveTask: async () => { resolutions += 1; return { worktreeId: 'worktree-7', task }; },
        resolveWorktree: async () => { resolutions += 1; return { worktreeId: 'worktree-7' }; },
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
        resolveTask: async () => ({ worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ worktreeId: 'worktree-7' }),
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
        resolveTask: async () => ({ worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ worktreeId: 'w'.repeat(10_000) }),
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
        resolveTask: async () => ({ worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ worktreeId: 'worktree-7' }),
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
        resolveTask: async () => ({ worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ worktreeId: 'worktree-7' }),
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
        resolveTask: async () => ({ worktreeId: 'worktree-7', task }),
        resolveWorktree: async () => ({ worktreeId: 'worktree-7' }),
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
