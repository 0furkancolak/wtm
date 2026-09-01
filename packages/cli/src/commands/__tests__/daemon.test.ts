import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DaemonSocketPathTooLongError,
  daemonSocketPathLimitBytes,
  measureDaemonSocketPath,
  publishedDaemonSocketPath,
} from '@wtm/core';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { launchdPaths } from '@wtm/daemon/launchd';
import type { LaunchdLifecycle } from '@wtm/daemon/launchd';
import {
  runDaemonLifecycleCommand,
  serveDaemon,
  type DaemonSignalSource,
} from '../daemon';
import { createCli, runCli } from '../../main';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const serveScenarioPath = fileURLToPath(new URL('./daemon-serve.scenario.ts', import.meta.url));
const serveFailureScenarioPath = fileURLToPath(new URL('./daemon-serve-failure.scenario.ts', import.meta.url));

/** A published socket path one byte past what a Unix socket address can hold. */
const overLimitSocketPath = publishedDaemonSocketPath(`/${'h'.repeat(62)}`);

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

  test('install refuses an over-long socket path instead of publishing an agent that can never answer', async () => {
    const manager = fakeManager();
    let installed = false;
    manager.install = async () => {
      installed = true;
      throw new Error('the agent should never have been published');
    };
    let probed = 0;
    const reachable = async () => { probed += 1; return false; };

    const envelope = await runDaemonLifecycleCommand('install', manager, reachable, overLimitSocketPath);

    // Nothing was published, and the readiness poll — which would have spent its whole deadline
    // waiting for a socket that cannot exist — was never entered.
    expect(installed).toBe(false);
    expect(probed).toBe(0);
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(envelope.errors[0]?.message).toContain(String(daemonSocketPathLimitBytes));
    expect(envelope.errors[0]?.message).toContain(String(daemonSocketPathLimitBytes + 1));
    expect(envelope.errors[0]?.message).toContain(overLimitSocketPath);
    expect(envelope.errors[0]?.context).toMatchObject({
      action: 'install',
      byteLength: daemonSocketPathLimitBytes + 1,
      limitBytes: daemonSocketPathLimitBytes,
    });
    expect(envelope.errors[0]?.remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);
  });

  test('a socket path that fits is installed and polled as before', async () => {
    const manager = fakeManager();

    const envelope = await runDaemonLifecycleCommand(
      'install',
      manager,
      async () => true,
      publishedDaemonSocketPath('/Users/x'),
    );

    expect(envelope).toMatchObject({ ok: true, command: 'daemon install', data: { reachable: true } });
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
      const reported: unknown[] = [];
      const serving = serveDaemon({
        runtimeFactory: async () => ({
          start: async () => { if (failure === 'start') throw new Error('raw startup secret'); },
          close: async () => { closes += 1; if (failure === 'close') throw new Error('raw close secret'); },
        }),
        signals,
        reportError: (error) => { reported.push(error); },
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
      // The cause is kept out of the envelope but must still reach the daemon's log.
      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toBe(`raw ${failure === 'start' ? 'startup' : 'close'} secret`);
      expect(closes).toBe(1);
      expect(signals.listenerCount()).toBe(0);
    }
  });

  test('a coded startup failure keeps its code, its measurement, its remediation and its exit status', async () => {
    const signals = new FakeSignals();
    const reported: unknown[] = [];
    const failure = new DaemonSocketPathTooLongError(measureDaemonSocketPath(overLimitSocketPath));

    const result = await serveDaemon({
      runtimeFactory: async () => { throw failure; },
      signals,
      reportError: (error) => { reported.push(error); },
    });

    // Exit 2 is the class for configuration the user has to change, and is what every other
    // command already exits with for this code.
    expect(result.exitCode).toBe(2);
    expect(jsonEnvelopeSchema.parse(result.envelope)).toEqual(result.envelope);
    expect(result.envelope.errors).toEqual([{
      code: 'WTM_SOCKET_PATH_TOO_LONG',
      message: failure.message,
      severity: 'error',
      context: {
        action: 'serve',
        path: overLimitSocketPath,
        byteLength: daemonSocketPathLimitBytes + 1,
        limitBytes: daemonSocketPathLimitBytes,
        exceededBy: 1,
        publishedPath: overLimitSocketPath,
        boundPath: measureDaemonSocketPath(overLimitSocketPath).boundPath,
      },
      remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }],
    }]);
    // Identity reaching the envelope is not licence for frames to reach it too.
    expect(JSON.stringify(result)).not.toContain('    at ');
    expect(reported).toEqual([failure]);
    expect(signals.listenerCount()).toBe(0);
  });
});

describe('daemon failure output', () => {
  test('a start failure tells the user what happened without a frame, and keeps the frames in the log', async () => {
    const home = await mkdtemp('/tmp/wtm-daemon-failure-');
    try {
      const result = spawnSync('node', ['--import', 'tsx', serveFailureScenarioPath], {
        env: { ...process.env, HOME: home },
        timeout: scenarioTimeoutMs,
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      // Everything a person could see. The envelope on stdout was already clean; the
      // reporter beside it was not.
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toContain('/Users/runner');
        expect(stream).not.toContain('.cjs');
        expect(stream).not.toContain('    at ');
        expect(stream).not.toContain('at createProductionDaemon');
      }
      // One actionable line, and only one.
      const reported = result.stderr.trimEnd().split('\n');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain('The WTM daemon runtime could not be created.');

      // Dropping the frames from the terminal must not drop them from the record: the daemon
      // runs unattended and its own log is the only place the cause can survive.
      const log = await readFile(launchdPaths(home).stderrPath, 'utf8');
      expect(log).toContain('at createProductionDaemon (/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, scenarioTimeoutMs);

  test('an over-long HOME refuses serve with one coded line naming the length and the limit', async () => {
    const fixture = await overLongHome();
    const measurement = measureDaemonSocketPath(publishedDaemonSocketPath(fixture.home));
    try {
      const result = spawnSync('node', ['--import', 'tsx', serveScenarioPath], {
        env: { ...process.env, HOME: fixture.home },
        timeout: scenarioTimeoutMs,
        encoding: 'utf8',
      });

      // Exit 2, not 1: the daemon cannot run here until the user changes something.
      expect(result.status, result.stderr).toBe(2);
      const envelope = JSON.parse(result.stdout);
      expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(envelope).toMatchObject({ ok: false, command: 'daemon serve', data: null });
      expect(envelope.errors[0].code).toBe('WTM_SOCKET_PATH_TOO_LONG');
      expect(envelope.errors[0].message).toContain(String(measurement.byteLength));
      expect(envelope.errors[0].message).toContain(String(daemonSocketPathLimitBytes));
      expect(envelope.errors[0].context).toMatchObject({
        action: 'serve',
        byteLength: measurement.byteLength,
        limitBytes: daemonSocketPathLimitBytes,
      });
      expect(envelope.errors[0].remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);

      // One actionable line on stderr, and still no frames on either stream.
      const reported = result.stderr.trimEnd().split('\n');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain(String(measurement.byteLength));
      expect(reported[0]).toContain(String(daemonSocketPathLimitBytes));
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toContain('    at ');
        expect(stream).not.toContain('/Users/runner');
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, scenarioTimeoutMs);
});

/**
 * A real HOME whose published socket path lands one byte past the limit.
 *
 * The refusal is a property of the address's length, so the fixture has to hit a length rather
 * than merely be deep — and the directory is created for real, because a refusal that only
 * happened because `HOME` did not exist would prove nothing about the measurement.
 */
async function overLongHome(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp('/tmp/wtm-daemon-long-home-');
  const padding = daemonSocketPathLimitBytes + 1 - Buffer.byteLength(publishedDaemonSocketPath(root)) - 1;
  if (padding < 1) throw new Error('the temporary root is already past the socket path limit');
  const home = join(root, 'h'.repeat(padding));
  await mkdir(home, { recursive: true });
  return { root, home };
}

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
  // The label is derived per HOME, so a stub that pins the bare one would stop resembling
  // anything the lifecycle can return.
  const label = launchdPaths('/tmp/fake-home').label;
  return {
    install: async () => ({ action: 'install', state: 'installed', label, plistPath: '/tmp/agent.plist' }),
    uninstall: async () => ({ action: 'uninstall', state: 'uninstalled', label, plistPath: '/tmp/agent.plist' }),
    status: async () => ({ action: 'status', state: 'loaded', label, plistPath: '/tmp/agent.plist', runState: 'running' }),
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
