import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonStateStore } from '@wtm/core';
import { UnsupportedPlatformError, selectPlatformRuntime } from '@wtm/platform';
import type { PlatformRuntime } from '@wtm/platform/ports';
import { DaemonSocketPathTooLongError, daemonSocketFileName } from '@wtm/platform/socket';
import { isolatedHomeEnvironment } from '../../../testkit/src/isolated-home';
import { MemoryManagedProcessStore } from '../../../testkit/src/managed-process-store';
import { runScenario } from '../../../testkit/src/scenario-child';
import {
  inspectProcessGroup,
  inspectProcessIdentity,
  type ProcessIdentity,
} from '../process-supervisor';
import {
  createProductionDaemon,
  defaultProductionRuntimePaths,
  type ProductionRuntimePaths,
} from '../runtime-factory';

const scenarioPath = fileURLToPath(new URL('./runtime-factory.scenario.ts', import.meta.url));
const privateDatabaseScenarioPath = fileURLToPath(new URL('./private-database.scenario.ts', import.meta.url));

describe('production daemon composition', () => {
  test('runs CLI start, ps, and stop through a real temporary socket and SQLite store', () => {
    const isolated = isolatedHome();
    try {
      const result = runScenario('node', ['--import', 'tsx', scenarioPath], {
        timeoutMs: 20_000,
        env: isolated.env,
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
      isolated.cleanup();
    }
  }, 20_000);

  /**
   * The one test here that lets the daemon and the client find each other by derivation instead of
   * by injection, which is why it is also the one that would have gone green while losing all its
   * isolation: on Linux, client and daemon read the same ambient `XDG_RUNTIME_DIR` and agree about
   * the runner's real socket — a shared address, outside the directory this test deletes. So the
   * scenario reports where it actually bound and the address is checked against the fixture, rather
   * than the agreement between two processes being taken as evidence that either was confined.
   */
  test('default CLI client reaches the documented HOME socket without runtime injection', () => {
    const isolated = isolatedHome();
    try {
      const result = runScenario('node', ['--import', 'tsx', scenarioPath, 'default-client'], {
        timeoutMs: 20_000,
        env: isolated.env,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toEqual({
        startExit: 0,
        startState: 'RUNNING',
        psRunning: true,
        stopExit: 0,
        stopState: 'STOPPED',
        socketPath: expect.any(String),
      });
      expect(output['socketPath']).toStartWith(`${isolated.path}/`);
    } finally {
      isolated.cleanup();
    }
  }, 20_000);

  test('closing the daemon releases control handles while a detached task remains live', async () => {
    const isolated = isolatedHome();
    const child = spawn('node', ['--import', 'tsx', scenarioPath, 'close-live'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: isolated.env,
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
      // After the group, not before: the detached task outlives the daemon by design here, and
      // removing the home it was started from while it is still running is how a cleanup turns
      // into the thing it was cleaning up after.
      isolated.cleanup();
    }
  }, 20_000);

  test('uses the private custom database parent rather than only the data root', () => {
    const isolated = isolatedHome();
    try {
      const result = runScenario('node', ['--import', 'tsx', privateDatabaseScenarioPath], {
        timeoutMs: 20_000, env: isolated.env,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ created: true, unsafeParentRejected: true });
    } finally {
      isolated.cleanup();
    }
  }, 20_000);
});

/**
 * A home directory of this run's own, and the rest of the environment that makes it one.
 *
 * `HOME` alone is that guarantee on macOS only, where every path WTM writes derives from
 * `~/Library`. On Linux `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` are read from the
 * ambient environment and override what `HOME` implies (`platform-paths.ts:58-72`), and a GitHub
 * runner exports the first of them — so a child spawned with `{ ...process.env, HOME: temp }` binds
 * its socket at the runner's real `/run/user/<uid>/wtm/wtmd.sock`, an address every other scenario
 * in the run resolves to as well and one no fixture here deletes. `isolatedHomeEnvironment` is the
 * whole set; its doc comment says why it also names variables WTM does not read today.
 *
 * `describe('an isolated home confines WTM to it')` below is the evidence that this environment
 * does what its name says, on both platforms rather than only the one CI happens to be on.
 */
function isolatedHome(): { path: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const path = mkdtempSync('/tmp/wtm-scenario-home-');
  return {
    path,
    env: { ...process.env, ...isolatedHomeEnvironment(path) },
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

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
 * The evidence for `isolatedHome()` above, run through WTM's own derivations.
 *
 * The scenarios in this file are spawned with that environment and the claim made of it is that
 * everything the child writes lands under one temporary directory. Asserting that on macOS proves
 * nothing about Linux, and asserting it on Linux is not possible from here — so it is asked of the
 * functions the children resolve their paths through, once per platform: the daemon's five from
 * `defaultProductionRuntimePaths`, and the sixth, `serviceRoot`, from the platform runtime, since
 * a service definition is the one thing WTM writes outside the daemon's own roots.
 *
 * `hostile` is what a GitHub Linux runner actually exports. It is spread *first*, so the helper has
 * to win rather than merely be present: an `isolatedHomeEnvironment` that forgot a variable would
 * leave that path pointing at the runner and fail here rather than in CI.
 */
describe('an isolated home confines WTM to it', () => {
  // Not a `mkdtemp`: nothing is created or read, and a fixed string makes the expected paths below
  // legible as the layout each platform actually produces.
  const home = '/tmp/wtm-fixture-home';
  const hostile = {
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_STATE_HOME: '/var/lib/somebody/state',
    XDG_CONFIG_HOME: '/etc/xdg/somebody',
  };
  const resolve = (
    platform: 'darwin' | 'linux',
    env: Readonly<Record<string, string>>,
  ): ProductionRuntimePaths & { serviceRoot: string } => ({
    ...defaultProductionRuntimePaths(home, { platform, env }),
    serviceRoot: selectPlatformRuntime({ platform, home, env }).paths.serviceRoot,
  });
  const confined = (platform: 'darwin' | 'linux') =>
    resolve(platform, { ...hostile, ...isolatedHomeEnvironment(home) });

  test('macOS writes every path under the fixture home', () => {
    expect(confined('darwin')).toEqual({
      dataRoot: `${home}/Library/Application Support/WTM`,
      databasePath: `${home}/Library/Application Support/WTM/state.db`,
      socketPath: `${home}/Library/Application Support/WTM/wtmd.sock`,
      logRoot: `${home}/Library/Logs/WTM`,
      globalConfigPath: `${home}/Library/Application Support/WTM/config.toml`,
      serviceRoot: `${home}/Library/LaunchAgents`,
    });
  });

  test('Linux writes every path under the fixture home, socket and service root included', () => {
    expect(confined('linux')).toEqual({
      dataRoot: `${home}/.local/state/wtm`,
      databasePath: `${home}/.local/state/wtm/state.db`,
      socketPath: `${home}/run/wtm/wtmd.sock`,
      logRoot: `${home}/.local/state/wtm/logs`,
      globalConfigPath: `${home}/.config/wtm/config.toml`,
      serviceRoot: `${home}/.config/systemd/user`,
    });
  });

  /**
   * The same fixture with only `HOME` overridden — what every test in this file did until now.
   * macOS is unmoved, which is exactly why this survived unnoticed for an increment; Linux keeps
   * the runner's state root and its shared socket address, so two such tests would contend for one
   * socket and neither would delete what it wrote.
   */
  test('HOME alone confines macOS and does not confine Linux', () => {
    expect(resolve('darwin', hostile)).toEqual(confined('darwin'));
    expect(resolve('linux', hostile)).toMatchObject({
      dataRoot: '/var/lib/somebody/state/wtm',
      socketPath: '/run/user/1000/wtm/wtmd.sock',
      globalConfigPath: '/etc/xdg/somebody/wtm/config.toml',
      serviceRoot: '/etc/xdg/somebody/systemd/user',
    });
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
        signalProcessGroup: () => {},
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
