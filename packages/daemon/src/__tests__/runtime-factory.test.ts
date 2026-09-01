import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonStateStore } from '@wtm/core';
import { UnsupportedPlatformError, selectPlatformRuntime } from '@wtm/platform';
import type { PlatformRuntime } from '@wtm/platform/ports';
import { DaemonSocketPathTooLongError, daemonSocketFileName } from '@wtm/platform/socket';
import { MemoryManagedProcessStore } from '../../../testkit/src/managed-process-store';
import {
  inspectProcessGroup,
  inspectProcessIdentity,
  type ProcessIdentity,
} from '../process-supervisor';
import { createProductionDaemon, defaultProductionRuntimePaths } from '../runtime-factory';

const scenarioPath = fileURLToPath(new URL('./runtime-factory.scenario.ts', import.meta.url));
const privateDatabaseScenarioPath = fileURLToPath(new URL('./private-database.scenario.ts', import.meta.url));

describe('production daemon composition', () => {
  test('runs CLI start, ps, and stop through a real temporary socket and SQLite store', () => {
    const result = spawnSync('node', ['--import', 'tsx', scenarioPath], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      startExit: 0,
      startState: 'RUNNING',
      psRunning: true,
      stopExit: 0,
      stopState: 'STOPPED',
    });
  }, 20_000);

  test('default CLI client reaches the documented HOME socket without runtime injection', () => {
    const home = mkdtempSync('/tmp/wtm-default-home-');
    try {
      const result = spawnSync('node', ['--import', 'tsx', scenarioPath, 'default-client'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...process.env, HOME: home },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        startExit: 0,
        startState: 'RUNNING',
        psRunning: true,
        stopExit: 0,
        stopState: 'STOPPED',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('closing the daemon releases control handles while a detached task remains live', async () => {
    const child = spawn('node', ['--import', 'tsx', scenarioPath, 'close-live'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = waitForExit(child, 15_000);
    const output = await readJsonLine(child.stdout);
    const identity = output.identity as ProcessIdentity;
    try {
      expect(output).toMatchObject({ startExit: 0, startState: 'RUNNING' });
      expect(await inspectProcessIdentity(identity.pid)).toEqual(identity);
      const result = await exited;
      expect(result).toEqual({ code: 0, signal: null, stderr: '' });
      expect(await inspectProcessIdentity(identity.pid)).toEqual(identity);
    } finally {
      const current = await inspectProcessIdentity(identity.pid);
      if (current !== null && sameIdentity(current, identity)) {
        try { process.kill(-identity.pgid, 'SIGKILL'); } catch (error) {
          if (!isNoSuchProcess(error)) throw error;
        }
        await waitForGroupAbsent(identity.pgid);
      }
    }
  }, 20_000);

  test('uses the private custom database parent rather than only the data root', () => {
    const result = spawnSync('node', ['--import', 'tsx', privateDatabaseScenarioPath], {
      encoding: 'utf8', timeout: 20_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ created: true, unsafeParentRejected: true });
  }, 20_000);
});

async function readJsonLine(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  let value = '';
  for await (const chunk of stream) {
    value += String(chunk);
    const newline = value.indexOf('\n');
    if (newline >= 0) return JSON.parse(value.slice(0, newline)) as Record<string, unknown>;
  }
  throw new Error('Scenario closed stdout before its result');
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  watchdogMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, stderr });
      return;
    }
    const timer = setTimeout(() => reject(new Error('Scenario exit watchdog expired')), watchdogMs);
    timer.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForGroupAbsent(pgid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await inspectProcessGroup(pgid)).status !== 'absent') {
    if (Date.now() >= deadline) throw new Error('Fixture group cleanup timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.pgid === right.pgid
    && left.processStartTime === right.processStartTime
    && left.commandFingerprint === right.commandFingerprint;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

/**
 * The paths the daemon writes to, now read off `PlatformRuntime.paths` rather than spelled out.
 *
 * The macOS case is pinned to literal strings on purpose. Every other test in this file would
 * still pass if the derivation moved the state database, because they all supply their own roots;
 * an installed daemon does not, and a relocated `dataRoot` is an empty workspace with no
 * explanation rather than an error. So these five strings are the contract, and they are the exact
 * ones the daemon used before the platform seam existed.
 */
describe('default production runtime paths', () => {
  const macHome = '/Users/somebody';
  const macDataRoot = '/Users/somebody/Library/Application Support/WTM';

  test('macOS resolves the roots byte-identically to the pre-seam daemon', () => {
    expect(defaultProductionRuntimePaths(macHome, { platform: 'darwin', env: {} })).toEqual({
      dataRoot: macDataRoot,
      databasePath: `${macDataRoot}/state.db`,
      socketPath: `${macDataRoot}/wtmd.sock`,
      logRoot: '/Users/somebody/Library/Logs/WTM',
      globalConfigPath: `${macDataRoot}/config.toml`,
    });
  });

  test('macOS ignores XDG variables a user exported for some other tool', () => {
    expect(defaultProductionRuntimePaths(macHome, {
      platform: 'darwin',
      env: {
        XDG_STATE_HOME: '/xdg/state',
        XDG_CONFIG_HOME: '/xdg/config',
        XDG_RUNTIME_DIR: '/run/user/501',
        XDG_CACHE_HOME: '/xdg/cache',
      },
    })).toEqual(defaultProductionRuntimePaths(macHome, { platform: 'darwin', env: {} }));
  });

  test('Linux follows the XDG defaults when nothing is exported', () => {
    expect(defaultProductionRuntimePaths('/home/somebody', { platform: 'linux', env: {} })).toEqual({
      dataRoot: '/home/somebody/.local/state/wtm',
      databasePath: '/home/somebody/.local/state/wtm/state.db',
      socketPath: '/home/somebody/.local/state/wtm/wtmd.sock',
      logRoot: '/home/somebody/.local/state/wtm/logs',
      globalConfigPath: '/home/somebody/.config/wtm/config.toml',
    });
  });

  /**
   * The reason `socketPath` had to stop being `join(dataRoot, …)`: on Linux the two are different
   * directories, chosen by different variables. A derivation from the data root would have put the
   * socket in `$XDG_STATE_HOME` — persistent, not cleaned at logout, and long enough to run into
   * the very address limit `$XDG_RUNTIME_DIR` avoids.
   */
  test('the Linux socket path comes from the runtime directory, not the data root', () => {
    const paths = defaultProductionRuntimePaths('/home/somebody', {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    });

    expect(paths.socketPath).toBe('/run/user/1000/wtm/wtmd.sock');
    expect(paths.dataRoot).toBe('/home/somebody/.local/state/wtm');
    expect(paths.socketPath.startsWith(paths.dataRoot)).toBe(false);
  });

  test('a platform with no backend is refused with a coded error, not a bare string', () => {
    const failure = ((): unknown => {
      try { return defaultProductionRuntimePaths(macHome, { platform: 'win32', env: {} }); }
      catch (error) { return error; }
    })();

    expect(failure).toBeInstanceOf(UnsupportedPlatformError);
    expect((failure as UnsupportedPlatformError).code).toBe('WTM_PLATFORM_UNSUPPORTED');
  });
});

/**
 * The socket limit reaching the preflight is the platform runtime's, not macOS's constant.
 *
 * `assertDaemonSocketPathFits` takes the limit as a required argument precisely so that a call
 * site which forgot to ask the runtime is a type error. These tests are the other half: they show
 * the number actually in force changes with the runtime rather than being 104 forever.
 */
describe('the production factory measures against the selected platform', () => {
  const linuxRuntime = selectPlatformRuntime({
    platform: 'linux', home: '/home/somebody', env: {},
  });
  const darwinRuntime = selectPlatformRuntime({
    platform: 'darwin', home: '/Users/somebody', env: {},
  });
  // 106 bytes: past macOS's 104-byte `sun_path` and inside Linux's 108. The directory is never
  // created — the refusal has to precede every side effect, which is what the third assertion
  // below checks.
  const socketPath = `/tmp/${'d'.repeat(91)}/${daemonSocketFileName}`;

  test('a path only macOS refuses is accepted under the Linux runtime', async () => {
    expect(Buffer.byteLength(socketPath)).toBe(106);
    const dataRoot = mkdtempSync('/tmp/wtm-limit-');
    try {
      const runtime = await createProductionDaemon({
        dataRoot,
        socketPath,
        logRoot: join(dataRoot, 'logs'),
        platformRuntime: linuxRuntime,
        // An in-memory store, because the point here is the preflight rather than the database:
        // `bun test` cannot open the SQLite store this factory would otherwise build, which is why
        // every other test in this file runs the factory in a spawned `node` instead.
        stateStore: new MemoryManagedProcessStore() as unknown as DaemonStateStore,
      });
      await runtime.close();
      expect(runtime.paths.socketPath).toBe(socketPath);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test('the same path under the macOS runtime is refused, naming the macOS limit', async () => {
    const dataRoot = join(mkdtempSync('/tmp/wtm-limit-'), 'nested');
    const failure = await createProductionDaemon({
      dataRoot, socketPath, platformRuntime: darwinRuntime,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonSocketPathTooLongError);
    expect((failure as DaemonSocketPathTooLongError).measurement.limitBytes).toBe(104);
    expect(existsSync(dataRoot)).toBe(false);
    rmSync(dirname(dataRoot), { recursive: true, force: true });
  });
});

/**
 * The supervisor's process readers come from the runtime the composition root selected.
 *
 * Nothing else in this repository can tell a macOS reader from a Linux one while running on macOS,
 * so this asks the question the only way that is decidable here: hand `createProductionDaemon` a
 * runtime whose process port is a fake, and check the supervisor asked *it* rather than the host's
 * `ps`. A supervisor still wired to a module-level macOS reader reports the fixture pid as absent
 * for the real reason instead of the injected one, and records nothing here.
 */
describe('the production factory supervises through the runtime process port', () => {
  test('recovery inspects through the injected platform runtime, not the host reader', async () => {
    const inspected: number[] = [];
    const inspectedGroups: number[] = [];
    const platformRuntime: PlatformRuntime = {
      ...selectPlatformRuntime({ platform: 'darwin', home: '/Users/somebody', env: {} }),
      process: {
        readStartTime: async () => null,
        inspectProcess: async (pid) => { inspected.push(pid); return { status: 'absent' }; },
        inspectProcessGroup: async (pgid) => { inspectedGroups.push(pgid); return { status: 'absent' }; },
      },
    };
    const dataRoot = mkdtempSync('/tmp/wtm-port-');
    const stateStore = new MemoryManagedProcessStore();
    stateStore.reserveManagedProcessStart('worktree-1', 'hold', 'token', new Date().toISOString());
    const record = stateStore.createManagedProcess({
      worktreeId: 'worktree-1', taskName: 'hold', pid: 4242, pgid: 4242,
      processStartTime: 'Mon Sep  1 12:00:00 2026', commandFingerprint: 'fingerprint',
      state: 'RUNNING', startedAt: new Date().toISOString(), stoppedAt: null,
      stdoutPath: join(dataRoot, 'out.log'), stderrPath: join(dataRoot, 'err.log'),
    }, { reservationToken: 'token' });
    try {
      const runtime = await createProductionDaemon({
        dataRoot,
        socketPath: join(dataRoot, 'wtmd.sock'),
        logRoot: join(dataRoot, 'logs'),
        platformRuntime,
        stateStore: stateStore as unknown as DaemonStateStore,
        gracePeriodMs: 20,
        pollIntervalMs: 5,
      });
      await runtime.supervisor.recover();
      await runtime.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }

    expect(inspected).toContain(4242);
    expect(inspectedGroups).toContain(4242);
    expect(stateStore.getManagedProcess(record.id)?.state).toBe('STOPPED');
  });
});
