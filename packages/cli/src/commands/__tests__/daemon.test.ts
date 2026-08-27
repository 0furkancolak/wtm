import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import type { LaunchdLifecycle } from '@wtm/daemon/launchd';
import {
  runDaemonLifecycleCommand,
  serveDaemon,
  type DaemonSignalSource,
} from '../daemon';
import { createCli, runCli } from '../../main';

const serveScenarioPath = fileURLToPath(new URL('./daemon-serve.scenario.ts', import.meta.url));

describe('daemon lifecycle command', () => {
  test.each(['install', 'uninstall', 'status'] as const)('returns a schema-valid %s envelope', async (action) => {
    const manager = fakeManager();
    const envelope = await runDaemonLifecycleCommand(action, manager);

    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope).toMatchObject({ ok: true, command: `daemon ${action}`, data: { action } });
  });

  test('maps typed launchd failures to a stable error without leaking raw exceptions', async () => {
    const manager = fakeManager();
    manager.status = async () => {
      const error = new Error('raw secret');
      Object.assign(error, { code: 'LAUNCHD_DOMAIN_UNAVAILABLE', context: { operation: 'print-domain' } });
      throw error;
    };

    const envelope = await runDaemonLifecycleCommand('status', manager);

    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'daemon status',
      data: null,
      warnings: [],
      errors: [{
        code: 'WTM_DAEMON_UNAVAILABLE',
        message: 'The launchd user domain is unavailable.',
        severity: 'error',
        context: { action: 'status', operation: 'print-domain' },
      }],
    });
  });
});

describe('daemon serve', () => {
  test('starts in the foreground, handles the first signal, closes once, and removes listeners', async () => {
    const events: string[] = [];
    const signals = new FakeSignals();
    const serving = serveDaemon({
      runtimeFactory: async () => ({
        start: async () => { events.push('start'); },
        close: async () => { events.push('close'); },
      }),
      signals,
    });
    await until(() => events.includes('start'));

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    const result = await serving;

    expect(events).toEqual(['start', 'close']);
    expect(result).toEqual({
      exitCode: 0,
      envelope: {
        schemaVersion: 1,
        ok: true,
        command: 'daemon serve',
        data: { state: 'stopped', signal: 'SIGTERM' },
        warnings: [],
        errors: [],
      },
    });
    expect(signals.listenerCount()).toBe(0);
  });

  test('a signal during startup waits for startup then closes exactly once', async () => {
    const events: string[] = [];
    const signals = new FakeSignals();
    let releaseStart = () => {};
    const serving = serveDaemon({
      runtimeFactory: async () => ({
        start: async () => {
          events.push('start-begin');
          await new Promise<void>((resolve) => { releaseStart = resolve; });
          events.push('start-end');
        },
        close: async () => { events.push('close'); },
      }),
      signals,
    });
    await until(() => events.includes('start-begin'));
    signals.emit('SIGINT');
    expect(events).toEqual(['start-begin']);
    releaseStart();

    expect((await serving).exitCode).toBe(0);
    expect(events).toEqual(['start-begin', 'start-end', 'close']);
  });

  test('startup and close failures return deterministic status 1 and always clean listeners', async () => {
    for (const failure of ['start', 'close'] as const) {
      const signals = new FakeSignals();
      let closes = 0;
      const serving = serveDaemon({
        runtimeFactory: async () => ({
          start: async () => { if (failure === 'start') throw new Error('raw startup secret'); },
          close: async () => { closes += 1; if (failure === 'close') throw new Error('raw close secret'); },
        }),
        signals,
      });
      if (failure === 'close') {
        await until(() => signals.listenerCount() === 2);
        signals.emit('SIGTERM');
      }

      const result = await serving;
      expect(result.exitCode).toBe(1);
      expect(result.envelope.ok).toBe(false);
      expect(result.envelope.errors[0]?.message).toBe(
        failure === 'start' ? 'WTM daemon could not start.' : 'WTM daemon could not close cleanly.',
      );
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(closes).toBe(1);
      expect(signals.listenerCount()).toBe(0);
    }
  });
});

describe('daemon CLI surface', () => {
  test('exposes strict nested lifecycle and serve words', () => {
    const cli = createCli({ daemonLifecycle: fakeManager() });
    const daemon = cli.commands.find((command) => command.name() === 'daemon');
    expect(daemon?.commands.map((command) => command.name())).toEqual(['install', 'uninstall', 'status', 'serve']);
  });

  test('renders lifecycle JSON and rejects unknown nested words with usage status 2', async () => {
    let stdout = '';
    let stderr = '';
    const output = { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; } };
    expect(await runCli(['daemon', 'status', '--json'], { daemonLifecycle: fakeManager(), ...output })).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: 'daemon status', data: { state: 'loaded' } });

    stdout = '';
    stderr = '';
    expect(await runCli(['daemon', 'reload'], { daemonLifecycle: fakeManager(), ...output })).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain("unknown command 'reload'");
  });

  test('uses the injected runtime factory and signal source for serve without process.exit', async () => {
    let stdout = '';
    const signals = new FakeSignals();
    let started = false;
    const running = runCli(['daemon', 'serve', '--json'], {
      daemonRuntimeFactory: async () => ({
        start: async () => { started = true; },
        close: async () => {},
      }),
      daemonSignals: signals,
      stdout: (value) => { stdout += value; },
      stderr: () => {},
    });
    await until(() => started);
    signals.emit('SIGTERM');

    expect(await running).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: 'daemon serve' });
  });

  test('wires serve to the production runtime factory and closes its real socket on SIGTERM', async () => {
    const home = await mkdtemp('/tmp/wtm-daemon-serve-');
    const socketPath = join(home, 'Library', 'Application Support', 'WTM', 'wtmd.sock');
    const child = spawn('node', ['--import', 'tsx', serveScenarioPath], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const resultPromise = childResult(child);
    try {
      await untilAsync(async () => await lstat(socketPath).then((stat) => stat.isSocket(), () => false), 10_000);
      child.kill('SIGTERM');
      const result = await resultPromise;
      expect(result.code, result.stderr).toBe(0);
      expect(result.signal).toBeNull();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true, command: 'daemon serve', data: { state: 'stopped', signal: 'SIGTERM' },
      });
      expect(await lstat(socketPath).then(() => true, () => false)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);
});

function fakeManager(): LaunchdLifecycle {
  return {
    install: async () => ({ action: 'install', state: 'installed', label: 'dev.wtm.daemon', plistPath: '/tmp/agent.plist' }),
    uninstall: async () => ({ action: 'uninstall', state: 'uninstalled', label: 'dev.wtm.daemon', plistPath: '/tmp/agent.plist' }),
    status: async () => ({ action: 'status', state: 'loaded', label: 'dev.wtm.daemon', plistPath: '/tmp/agent.plist' }),
  };
}

class FakeSignals implements DaemonSignalSource {
  readonly #listeners = new Map<NodeJS.Signals, Set<() => void>>();

  on(signal: NodeJS.Signals, listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
  }

  off(signal: NodeJS.Signals, listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of this.#listeners.get(signal) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function untilAsync(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function childResult(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
