import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, FrameDecoder, protocolVersion, type JsonEnvelope } from '@wtm/protocol';
import { runCli } from '../../main';
import type { RuntimeDaemonClient } from '../runtime-client';

function success(command: string, data: unknown): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: true, command, data, warnings: [], errors: [] };
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (chunk: string) => { stdout += chunk; },
    stderr: (chunk: string) => { stderr += chunk; },
    out: () => stdout,
    err: () => stderr,
  };
}

describe('persistent job CLI', () => {
  test('historical success with a persisted stop reason cannot validate sources', async () => {
    for (const stopReason of ['CANCELLED', 'TIMED_OUT', 'INTERRUPTED', 'invalid-reason']) {
      const data = { job: { jobId: 'job-1', state: 'SUCCEEDED', exitCode: 0, signal: null, slotHeld: false, stopReason },
        terminal: true, successful: true, sourceValidity: 'UNCHANGED' };
      const output = capture();
      expect(await runCli(['jobs', 'result', 'job-1', '--json'], {
        runtimeClient: { request: async () => success('jobs.result', data) }, ...output,
      })).toBeGreaterThan(0);
      expect(JSON.parse(output.out())).toMatchObject({ ok: false, data,
        errors: [{ code: stopReason === 'invalid-reason' ? 'WTM_DAEMON_REQUEST_FAILED' : 'WTM_JOB_UNSUCCESSFUL' }] });
    }
  });
  test('refuses unknown or contradictory daemon waiting evidence', async () => {
    for (const action of ['list', 'status']) {
      for (const job of [
        { jobId: 'job-1', state: 'QUEUED', waitingReason: 'unregistered_reason' },
        { jobId: 'job-1', state: 'SUCCEEDED', waitingReason: 'concurrency' },
        { jobId: 'job-1', state: 'SUCCEEDED', waitingReason: 'memory_budget' },
      ]) {
        const data = action === 'list' ? { jobs: [job] } : { job };
        const argv = action === 'list' ? ['jobs', action, '--json'] : ['jobs', action, 'job-1', '--json'];
        const output = capture();
        expect(await runCli(argv, { runtimeClient: { request: async () => success(`jobs.${action}`, data) }, ...output })).toBeGreaterThan(0);
        expect(JSON.parse(output.out()).errors[0].code).toBe('WTM_DAEMON_REQUEST_FAILED');
      }
    }
  });

  test('shows queued waiting reasons in JSON and human output without changing result semantics', async () => {
    for (const waitingReason of ['concurrency', 'worktree_busy', 'fifo', 'dispatch_pending', 'memory_budget']) {
      const job = { jobId: 'job-1', state: 'QUEUED', waitingReason };
      for (const json of [true, false]) {
        const output = capture();
        expect(await runCli(['jobs', 'status', 'job-1', ...(json ? ['--json'] : [])], {
          runtimeClient: { request: async () => success('jobs.status', { job }) }, ...output,
        })).toBe(0);
        if (json) expect(JSON.parse(output.out()).data.job).toEqual(job);
        else expect(output.out()).toContain(`waitingReason: ${waitingReason}`);
      }
    }
  });
  test('enqueue sends one request, reports acceptance, and does not wait for completion', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, args });
        return success(command, { jobId: 'job-1', state: 'QUEUED', accepted: true, idempotencyKey: 'check-1', reused: false });
      },
    };
    const output = capture();
    expect(await runCli(['run', 'typecheck', '--enqueue', '--idempotency-key', 'check-1', '--json'], {
      cwd: '/repo/feature', runtimeClient: client, ...output,
    })).toBe(0);
    expect(calls).toEqual([{
      command: 'jobs.enqueue', args: { cwd: '/repo/feature', taskName: 'typecheck', idempotencyKey: 'check-1' },
    }]);
    expect(JSON.parse(output.out())).toMatchObject({ command: 'run', ok: true, data: { jobId: 'job-1', state: 'QUEUED' } });
    expect(output.err()).toBe('');
  });

  test('ambiguous enqueue failure returns the generated key for an idempotent retry', async () => {
    let key = '';
    const output = capture();
    expect(await runCli(['--json', 'run', 'typecheck', '--enqueue'], {
      cwd: '/repo/feature',
      runtimeClient: { request: async (_command, args) => {
        key = (args as { idempotencyKey: string }).idempotencyKey;
        throw new Error('private daemon socket details');
      } },
      ...output,
    })).toBe(4);
    expect(key).toMatch(/^[a-f\d-]{36}$/);
    expect(JSON.parse(output.out())).toMatchObject({
      ok: false, command: 'run', errors: [{ code: 'WTM_DAEMON_UNAVAILABLE', context: { idempotencyKey: key } }],
    });
    expect(output.out()).not.toContain('private daemon');
  });

  test('enqueue refuses an acceptance for a different idempotency key and preserves the retry key', async () => {
    const output = capture();
    expect(await runCli(['run', 'check', '--enqueue', '--idempotency-key', 'requested-key', '--json'], {
      runtimeClient: { request: async () => success('jobs.enqueue', {
        jobId: 'job-other', state: 'QUEUED', accepted: true, idempotencyKey: 'other-key', reused: false,
      }) }, ...output,
    })).toBeGreaterThan(0);
    expect(JSON.parse(output.out())).toMatchObject({
      ok: false, errors: [{ code: 'WTM_DAEMON_REQUEST_FAILED', context: { idempotencyKey: 'requested-key' } }],
    });
  });

  test('job queries use host queue IDs without requiring the current directory to be registered', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const cases = [
      { argv: ['jobs', 'list', '--json'], command: 'jobs.list', args: {} },
      { argv: ['jobs', 'status', 'job-1', '--json'], command: 'jobs.status', args: { jobId: 'job-1' } },
      { argv: ['jobs', 'logs', 'job-1', '--tail', '27', '--json'], command: 'jobs.logs', args: { jobId: 'job-1', tail: 27 } },
      { argv: ['jobs', 'cancel', 'job-1', '--json'], command: 'jobs.cancel', args: { jobId: 'job-1' } },
    ];
    const client: RuntimeDaemonClient = { request: async (command, args) => {
      calls.push({ command, args });
      return success(command, command === 'jobs.logs'
        ? { jobId: 'job-1', stdout: 'one\n', stderr: '', truncated: false }
        : command === 'jobs.list' ? { jobs: [] } : { job: { jobId: 'job-1', state: 'QUEUED' } });
    } };
    for (const entry of cases) {
      const output = capture();
      expect(await runCli(entry.argv, { cwd: '/not-a-repository', runtimeClient: client, ...output })).toBe(0);
      expect(JSON.parse(output.out()).command).toBe(entry.command.replace('.', ' '));
    }
    expect(calls).toEqual(cases.map(({ command, args }) => ({ command, args })));
  });

  test('result preserves the payload and refuses pending, unsuccessful, or stale-source evidence', async () => {
    for (const entry of [
      { terminal: false, successful: false, sourceValidity: 'UNCHANGED', expected: 'WTM_JOB_NOT_COMPLETE' },
      { terminal: true, successful: false, sourceValidity: 'UNCHANGED', expected: 'WTM_JOB_UNSUCCESSFUL' },
      { terminal: true, successful: true, sourceValidity: 'CHANGED', expected: 'WTM_JOB_SOURCE_CHANGED' },
      { terminal: true, successful: true, sourceValidity: 'UNKNOWN', expected: 'WTM_JOB_SOURCE_CHANGED' },
    ]) {
      const { expected, ...flags } = entry;
      const data = { job: { jobId: 'job-1', state: flags.successful ? 'SUCCEEDED' : flags.terminal ? 'FAILED' : 'QUEUED', exitCode: flags.successful ? 0 : flags.terminal ? 7 : null, signal: null, slotHeld: false }, ...flags };
      const output = capture();
      const exit = await runCli(['jobs', 'result', 'job-1', '--json'], {
        runtimeClient: { request: async () => success('jobs.result', data) }, ...output,
      });
      expect(exit).toBeGreaterThan(0);
      expect(JSON.parse(output.out())).toMatchObject({ ok: false, command: 'jobs result', data, errors: [{ code: expected }] });
    }
  });

  test('result exits successfully only for confirmed success against unchanged source', async () => {
    const data = { job: { jobId: 'job-1', state: 'SUCCEEDED', exitCode: 0, signal: null, slotHeld: false }, terminal: true, successful: true, sourceValidity: 'UNCHANGED' };
    const output = capture();
    expect(await runCli(['--json', 'jobs', 'result', 'job-1'], {
      runtimeClient: { request: async () => success('jobs.result', data) }, ...output,
    })).toBe(0);
    expect(JSON.parse(output.out())).toMatchObject({ ok: true, data });
  });

  test('a contradictory or malformed result cannot be mistaken for successful validation', async () => {
    for (const job of [
      { jobId: 'job-1', state: 'FAILED', exitCode: 0, signal: null, slotHeld: false },
      { jobId: 'job-1', state: 'SUCCEEDED', exitCode: 7, signal: null, slotHeld: false },
      { jobId: 'job-1', state: 'SUCCEEDED', exitCode: null, signal: null, slotHeld: false },
      { jobId: 'job-1', state: 'SUCCEEDED', exitCode: 0, signal: null, slotHeld: true },
      { jobId: 'job-1', state: 'SUCCEEDED', signal: null, slotHeld: false },
      { jobId: 'job-1', state: 'SUCCEEDED', exitCode: 0, signal: 'SIGTERM', slotHeld: false },
      { jobId: 'job-1', state: 'SUCCEEDED', exitCode: 0, slotHeld: false },
    ]) {
      const output = capture();
      expect(await runCli(['jobs', 'result', 'job-1', '--json'], {
        runtimeClient: { request: async () => success('jobs.result', { job, terminal: true, successful: true, sourceValidity: 'UNCHANGED' }) },
        ...output,
      })).toBeGreaterThan(0);
      expect(JSON.parse(output.out()).ok).toBe(false);
    }
  });

  test('job selectors refuse a successful response belonging to another job', async () => {
    for (const action of ['status', 'result', 'cancel', 'logs']) {
      const data = action === 'logs'
        ? { jobId: 'job-other', stdout: 'other task', stderr: '', truncated: false }
        : { job: { jobId: 'job-other', state: 'SUCCEEDED', exitCode: 0, signal: null, slotHeld: false }, terminal: true, successful: true, sourceValidity: 'UNCHANGED' };
      const output = capture();
      expect(await runCli(['jobs', action, 'job-1', '--json'], {
        runtimeClient: { request: async () => success(`jobs.${action}`, data) }, ...output,
      })).toBeGreaterThan(0);
      expect(JSON.parse(output.out())).toMatchObject({ ok: false, data, errors: [{ code: 'WTM_DAEMON_REQUEST_FAILED' }] });
    }
  });

  test('production CLI connects enqueue and job queries to its daemon socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-jobs-cli-'));
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\wtm-jobs-cli-${process.pid}-${Date.now()}` : join(directory, 'd.sock');
    const sockets = new Set<Socket>();
    const calls: string[] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const decoder = new FrameDecoder();
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
          const request = JSON.parse(frame.toString()) as { id: string; command: string };
          calls.push(request.command);
          const data = request.command === 'jobs.enqueue'
            ? { jobId: 'job-1', state: 'QUEUED', accepted: true, idempotencyKey: 'stable-key', reused: false }
            : { jobs: [] };
          socket.write(encodeFrame(Buffer.from(JSON.stringify({ protocol: protocolVersion, id: request.id, envelope: success(request.command, data) }))));
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      for (const argv of [
        ['run', 'check', '--enqueue', '--idempotency-key', 'stable-key', '--json'],
        ['jobs', 'list', '--json'],
      ]) {
        const output = capture();
        expect(await runCli(argv, { daemonSocketPath: socketPath, cwd: directory, ...output })).toBe(0);
        expect(JSON.parse(output.out()).ok).toBe(true);
      }
      expect(calls).toEqual(['jobs.enqueue', 'jobs.list']);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('enqueue-only options cannot accidentally execute a foreground task', async () => {
    const output = capture();
    let requests = 0;
    expect(await runCli(['run', 'typecheck', '--idempotency-key', 'check-1', '--json'], {
      cwd: '/does-not-exist', runtimeClient: { request: async () => { requests += 1; throw new Error(); } }, ...output,
    })).toBe(2);
    expect(JSON.parse(output.out())).toMatchObject({ ok: false, errors: [{ code: 'WTM_CONFIG_INVALID' }] });
    expect(requests).toBe(0);
  });

  test('invalid tail counts are usage errors before making a daemon request', async () => {
    for (const tail of ['0', '-1', '1.5', 'NaN', '1001']) {
      const output = capture();
      expect(await runCli(['jobs', 'logs', 'job-1', '--tail', tail, '--json'], {
        runtimeClient: { request: async () => { throw new Error('must not send'); } }, ...output,
      })).toBe(2);
      expect(JSON.parse(output.out())).toMatchObject({ ok: false, errors: [{ code: 'WTM_CONFIG_INVALID' }] });
    }
  });
});
