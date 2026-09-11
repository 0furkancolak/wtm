import { describe, expect, test } from 'bun:test';
import type { ManagedProcessRecord, ResolvedTask } from '@wtm/core';
import { jsonEnvelopeSchema, protocolVersion, type IpcRequest } from '@wtm/protocol';
import { DaemonRuntimeController, type DaemonRuntimeControllerOptions } from '../runtime-controller';

const record: ManagedProcessRecord = {
  id: 'process-1', worktreeId: 'worktree-1', taskName: 'dev', pid: 42, pgid: 42,
  processStartTime: 'start-1', commandFingerprint: 'fingerprint-1', state: 'RUNNING',
  startedAt: '2026-09-10T00:00:00.000Z', stoppedAt: null,
  stdoutPath: '/private/stdout.log', stderrPath: '/private/stderr.log', cleanupRequired: false,
};
const task: ResolvedTask = {
  argv: ['node', 'server.js'], cwd: '/repo', envDelta: {}, shell: false, background: true, singleton: true,
  healthcheck: { type: 'http', url: 'http://localhost:4321/health', timeoutMs: 100, intervalMs: 100 },
};

function request(command = 'start', wait = true): IpcRequest {
  return { protocol: protocolVersion, id: 'request-1', command, arguments: { cwd: '/repo', taskName: 'dev', ...(wait ? { wait } : {}) } };
}

async function within<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Readiness fixture did not reach its expected phase.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture(input: { task?: ResolvedTask; record?: ManagedProcessRecord; existing?: boolean } = {}) {
  let current = input.record ?? record;
  const calls: string[] = [];
  const options: DaemonRuntimeControllerOptions = {
    supervisor: {
      start: async () => { calls.push('start'); return { record: current, existing: input.existing ?? false }; },
      restart: async () => { calls.push('restart'); return { record: current, existing: false }; },
      stop: async () => { calls.push('stop'); current = { ...current, state: 'STOPPED' }; return current; },
      stopAll: async () => { calls.push('stopAll'); return []; },
      list: () => [current],
    },
    resolver: {
      resolveTask: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-1', task: input.task ?? task }),
      resolveWorktree: async () => ({ workspaceId: 'workspace-1', worktreeId: 'worktree-1' }),
      resolveExec: async () => ({ cwd: '/repo', envDelta: {} }),
    },
    logs: { read: async () => '', readCompletion: async () => null },
    inspectProcess: async () => ({ status: 'present', identity: current }),
    readinessFetch: async () => { calls.push('probe'); return new Response(null, { status: 204 }); },
    onRuntimeEvent: (event) => { calls.push(event); },
  };
  return { options, calls, getRecord: () => current };
}

describe('runtime controller readiness', () => {
  test('normal start returns NOT_CHECKED without HTTP or identity probing', async () => {
    const { options, calls } = fixture();
    options.inspectProcess = async () => { throw new Error('unexpected inspection'); };
    const result = await new DaemonRuntimeController(options).handle(request('start', false));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ process: record, existing: false, readiness: {
      state: 'NOT_CHECKED', probe: null, attempts: 0, elapsedMs: 0, observedAt: null,
    } });
    expect(calls).toEqual(['start', 'runtime.started']);
  });

  test.each(['start', 'restart'])('%s does not report a terminal launch record as success', async (command) => {
    const { options, calls } = fixture({ record: { ...record, state: 'FAILED' } });
    const result = await new DaemonRuntimeController(options).handle(request(command, false));
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('RUNTIME_START_FAILED');
    expect(result.data).toMatchObject({ process: { state: 'FAILED' }, readiness: { state: 'PROCESS_EXITED' } });
    expect(calls).not.toContain('runtime.started');
    expect(calls).not.toContain('probe');
  });

  test.each(['start', 'restart'])('%s validates a missing healthcheck before lifecycle side effects', async (command) => {
    const noHealthcheck = { ...task };
    delete noHealthcheck.healthcheck;
    const { options, calls } = fixture({ task: noHealthcheck });
    const result = await new DaemonRuntimeController(options).handle(request(command));
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('WTM_CONFIG_INVALID');
    expect(calls).toEqual([]);
  });

  test.each([
    { url: 'file:///private/secret' },
    { url: 'http://user:password@localhost/' },
    { timeoutMs: 300001 },
    { intervalMs: 0 },
  ])('invalid resolved healthcheck %j cannot restart a service', async (invalid) => {
    const { options, calls } = fixture({ task: { ...task, healthcheck: { ...task.healthcheck!, ...invalid } } });
    const result = await new DaemonRuntimeController(options).handle(request('restart'));
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('WTM_CONFIG_INVALID');
    expect(calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('/private/secret');
  });

  test('a disconnected caller cannot restart after task resolution finishes', async () => {
    const { options, calls } = fixture();
    const abort = new AbortController();
    const resolve = options.resolver.resolveTask;
    options.resolver.resolveTask = async (...args) => { abort.abort(); return await resolve(...args); };
    const result = await new DaemonRuntimeController(options).handle(request('restart'), { signal: abort.signal });
    expect(result.errors[0]?.code).toBe('RUNTIME_READINESS_ABORTED');
    expect(calls).toEqual([]);
  });

  test('existing managed service is observed without a new runtime event', async () => {
    const { options, calls } = fixture({ existing: true });
    const result = await new DaemonRuntimeController(options).handle(request());
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ process: record, existing: true, readiness: { state: 'READY', attempts: 1 } });
    expect(calls).toEqual(['start', 'probe']);
    expect(jsonEnvelopeSchema.safeParse(result).success).toBe(true);
  });

  test('wait timeout returns process evidence and leaves the managed service running', async () => {
    const { options, calls, getRecord } = fixture();
    options.readinessFetch = async () => new Response(null, { status: 503 });
    const result = await new DaemonRuntimeController(options).handle({
      ...request(), arguments: { cwd: '/repo', taskName: 'dev', wait: true, waitTimeoutMs: 20 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('RUNTIME_READINESS_TIMEOUT');
    expect(result.data).toMatchObject({ process: record, readiness: { state: 'TIMED_OUT', attempts: 1 } });
    expect(result.scope).toEqual({ mode: 'local', workspaceId: 'workspace-1', worktreeId: 'worktree-1' });
    expect(getRecord().state).toBe('RUNNING');
    expect(calls).toEqual(['start', 'runtime.started']);
    expect(jsonEnvelopeSchema.safeParse(result).success).toBe(true);
  });

  test('a concurrent stop can finish while readiness HTTP is outstanding', async () => {
    const { options, getRecord } = fixture();
    let probed!: () => void;
    const started = new Promise<void>((resolve) => { probed = resolve; });
    let release!: (response: Response) => void;
    options.readinessFetch = async () => await new Promise<Response>((resolve) => { release = resolve; probed(); });
    const controller = new DaemonRuntimeController(options);
    const waiting = controller.handle(request());
    await within(started);
    const stopped = await controller.handle({ ...request('stop', false) });
    expect(stopped.ok).toBe(true);
    expect(getRecord().state).toBe('STOPPED');
    release(new Response(null, { status: 200 }));
    const result = await waiting;
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('RUNTIME_READINESS_FAILED');
    expect(result.data).toMatchObject({ readiness: { state: 'PROCESS_EXITED' } });
  });

  test('disconnect aborts observation without calling supervisor stop', async () => {
    const { options, calls, getRecord } = fixture();
    const abort = new AbortController();
    options.readinessFetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      abort.abort();
    });
    const result = await new DaemonRuntimeController(options).handle(request(), { signal: abort.signal });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('RUNTIME_READINESS_ABORTED');
    expect(result.data).toMatchObject({ readiness: { state: 'ABORTED' } });
    expect(getRecord().state).toBe('RUNNING');
    expect(calls).toEqual(['start', 'runtime.started']);
  });

  test('wait without a trusted completion reader fails closed', async () => {
    const { options, calls } = fixture();
    delete options.logs.readCompletion;
    const result = await new DaemonRuntimeController(options).handle(request());
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('RUNTIME_READINESS_FAILED');
    expect(result.data).toMatchObject({ readiness: { state: 'EVIDENCE_UNAVAILABLE' } });
    expect(calls).not.toContain('probe');
  });
});
