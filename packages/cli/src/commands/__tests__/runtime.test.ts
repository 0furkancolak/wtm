import { describe, expect, test } from 'bun:test';
import { jsonEnvelopeSchema, type JsonEnvelope } from '@wtm/protocol';
import { runCli } from '../../main';
import type { ForegroundExecutor, RuntimeDaemonClient } from '../exec';

function success(command: string, data: unknown = {}): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: true, command, data, warnings: [], errors: [] };
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
    out: () => stdout,
    err: () => stderr,
  };
}

describe('runtime CLI commands', () => {
  test('start stop restart ps and ordinary logs send stable daemon IPC request shapes', async () => {
    const calls: Array<{ command: string; arguments: unknown }> = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, arguments: args });
        return success(command, { accepted: true });
      },
    };
    const cases = [
      { argv: ['start', 'dev', '--json'], call: { command: 'start', arguments: { cwd: '/repo/wt', taskName: 'dev' } } },
      { argv: ['stop', 'dev', '--json'], call: { command: 'stop', arguments: { cwd: '/repo/wt', taskName: 'dev' } } },
      { argv: ['stop', '--json'], call: { command: 'stop', arguments: { cwd: '/repo/wt' } } },
      { argv: ['restart', 'dev', '--json'], call: { command: 'restart', arguments: { cwd: '/repo/wt', taskName: 'dev' } } },
      { argv: ['ps', '--json'], call: { command: 'ps', arguments: { cwd: '/repo/wt' } } },
      { argv: ['logs', 'dev', '--json'], call: { command: 'logs', arguments: { cwd: '/repo/wt', taskName: 'dev', follow: false } } },
    ] as const;

    for (const testCase of cases) {
      const output = capture();
      expect(await runCli(testCase.argv, { cwd: '/repo/wt', runtimeClient: client, ...output })).toBe(0);
      expect(output.err()).toBe('');
      expect(jsonEnvelopeSchema.parse(JSON.parse(output.out())).ok).toBe(true);
    }
    expect(calls).toEqual(cases.map(({ call }) => call));
  });

  test('exec sends raw argv for daemon context resolution and never enables a shell', async () => {
    const calls: Array<{ command: string; arguments: unknown }> = [];
    const executions: Parameters<ForegroundExecutor>[] = [];
    const client: RuntimeDaemonClient = {
      request: async (command, args) => {
        calls.push({ command, arguments: args });
        return success('exec', {
          argv: ['printf', '%s', '$HOME; touch /tmp/not-created'],
          cwd: '/repo/wt',
          envDelta: { WTM_WORKTREE_ID: '7' },
        });
      },
    };
    const execute: ForegroundExecutor = async (...args) => {
      executions.push(args);
      return { exitCode: 0, signal: null };
    };
    const output = capture();

    const exitCode = await runCli(
      ['--json', 'exec', '--', 'printf', '%s', '$HOME; touch /tmp/not-created'],
      { cwd: '/repo/wt', runtimeClient: client, execForeground: execute, ...output },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{
      command: 'exec',
      arguments: { cwd: '/repo/wt', argv: ['printf', '%s', '$HOME; touch /tmp/not-created'] },
    }]);
    expect(executions).toEqual([[{
      argv: ['printf', '%s', '$HOME; touch /tmp/not-created'],
      cwd: '/repo/wt',
      envDelta: { WTM_WORKTREE_ID: '7' },
      shell: false,
    }]]);
  });

  test('logs follow writes raw chunks and does not render a JSON envelope', async () => {
    const output = capture();
    const client: RuntimeDaemonClient = {
      request: async () => { throw new Error('ordinary request must not be used'); },
      followLogs: async (args, write, options) => {
        expect(args).toEqual({ cwd: '/repo/wt', taskName: 'dev' });
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        await write('one\n');
        await write('two\n');
        return 0;
      },
    };

    const listenersBefore = process.listenerCount('SIGINT');

    expect(await runCli(['logs', 'dev', '--follow'], {
      cwd: '/repo/wt',
      runtimeClient: client,
      ...output,
    })).toBe(0);
    expect(output.out()).toBe('one\ntwo\n');
    expect(output.err()).toBe('');
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
  });

  test('daemon failures are sanitized into one stable envelope', async () => {
    const output = capture();
    const client: RuntimeDaemonClient = {
      request: async () => { throw new Error('connect /Users/private/secret.sock stack'); },
    };

    expect(await runCli(['ps', '--json'], { cwd: '/repo/wt', runtimeClient: client, ...output })).toBe(4);
    const envelope = JSON.parse(output.out());
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.errors).toEqual([{
      code: 'WTM_DAEMON_UNAVAILABLE',
      message: 'WTM daemon is unavailable.',
      severity: 'error',
      context: { command: 'ps' },
    }]);
    expect(output.out()).not.toContain('/Users/private');
    expect(output.out()).not.toContain('stack');
  });
});
