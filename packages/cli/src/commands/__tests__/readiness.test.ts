import { describe, expect, test } from 'bun:test';
import { runCli } from '../../main';
import type { RuntimeDaemonClient } from '../runtime-client';
import { runStartCommand } from '../start';

describe('start and restart readiness CLI', () => {
  test('reports a caller cancellation separately from an unavailable daemon', async () => {
    const controller = new AbortController();
    const client: RuntimeDaemonClient = { request: async () => {
      controller.abort(); throw new Error('private transport detail');
    } };
    const result = await runStartCommand({ cwd: '/repo', taskName: 'dev', wait: true }, client, controller.signal);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('RUNTIME_READINESS_ABORTED');
    expect(JSON.stringify(result)).not.toContain('private transport detail');
    let calls = 0;
    const alreadyAborted = await runStartCommand({ cwd: '/repo', taskName: 'dev', wait: true }, { request: async () => { calls += 1; throw new Error('must not send'); } }, controller.signal);
    expect(alreadyAborted.errors[0]?.code).toBe('RUNTIME_READINESS_ABORTED');
    expect(calls).toBe(0);
    const unavailable = await runStartCommand({ cwd: '/repo', taskName: 'dev', wait: true }, { request: async () => { throw new Error('connection failed'); } });
    expect(unavailable.errors[0]?.code).toBe('WTM_DAEMON_UNAVAILABLE');
  });
  test('passes bounded waits and a longer per-request transport timeout without changing ordinary requests', async () => {
    const calls: unknown[] = [];
    const client: RuntimeDaemonClient = { request: async (command, args, options) => {
      calls.push({ command, args, options });
      return { schemaVersion: 1, ok: true, command, data: {}, warnings: [], errors: [] };
    } };
    const dependencies = { cwd: '/repo', runtimeClient: client, stdout: () => {}, stderr: () => {} };
    expect(await runCli(['start', 'dev', '--wait', '--timeout', '6s', '--json'], dependencies)).toBe(0);
    expect(await runCli(['restart', 'dev', '--wait', '--json'], dependencies)).toBe(0);
    expect(await runCli(['start', 'dev', '--json'], dependencies)).toBe(0);
    expect(calls).toEqual([
      { command: 'start', args: { cwd: '/repo', taskName: 'dev', wait: true, waitTimeoutMs: 6000 }, options: { timeoutMs: 36000, cancelRemote: true } },
      { command: 'restart', args: { cwd: '/repo', taskName: 'dev', wait: true }, options: { timeoutMs: 330000, cancelRemote: true } },
      { command: 'start', args: { cwd: '/repo', taskName: 'dev' }, options: undefined },
    ]);
  });

  test('rejects invalid wait flags before sending any request, including timeout without wait', async () => {
    let calls = 0;
    const client: RuntimeDaemonClient = { request: async () => { calls += 1; throw new Error('must not send'); } };
    for (const command of ['start', 'restart']) {
      for (const flags of [['--timeout', '3s'], ['--wait', '--timeout', '0s'], ['--wait', '--timeout', '6m'], ['--wait', '--timeout', 'garbage']]) {
        let output = '';
        const code = await runCli([command, 'dev', ...flags, '--json'], {
          cwd: '/repo', runtimeClient: client, stdout: (value) => { output += value; }, stderr: () => {},
        });
        expect(code).not.toBe(0);
        expect(JSON.parse(output).ok).toBe(false);
      }
    }
    expect(calls).toBe(0);
  });
});
