import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { join as posixJoin } from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import type { DaemonStateStore } from '@wtm/core';
import {
  UnsupportedPlatformError, createDarwinProcessPlatform, observedCommandFingerprint, selectPlatformRuntime,
} from '@wtm/platform';
import type { PlatformRuntime } from '@wtm/platform/ports';
import { DaemonSocketPathTooLongError, daemonSocketFileName } from '@wtm/platform/socket';
import { isolatedHomeEnvironment } from '../../../testkit/src/isolated-home';
import { MemoryManagedProcessStore } from '../../../testkit/src/managed-process-store';
import { shortTmpRoot } from '../../../testkit/src/platform';
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
const psScopeScenarioPath = fileURLToPath(new URL('./ps-scope.scenario.ts', import.meta.url));

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
  test('default CLI client reaches the isolated production IPC address without runtime injection', () => {
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
        paths: {
          dataRoot: expect.any(String), databasePath: expect.any(String), socketPath: expect.any(String),
          logRoot: expect.any(String), globalConfigPath: expect.any(String),
        },
      });
      const paths = output['paths'] as ProductionRuntimePaths;
      expect(output['socketPath']).toBe(defaultProductionRuntimePaths(isolated.path, { env: isolated.env }).socketPath);
      expect(paths.socketPath).toBe(output['socketPath'] as string);
      // `databasePath` comes back canonical (its parent went through `ensurePrivateDirectory`), and
      // on macOS `/tmp` is a symlink to `/private/tmp`, so confinement is judged against both
      // spellings of the fixture root rather than the one `mkdtemp` happened to return.
      const roots = [isolated.path, realpathSync(isolated.path)];
      for (const path of [paths.dataRoot, paths.databasePath, paths.logRoot, paths.globalConfigPath]) {
        const confined = roots.some((root) => {
          const within = relative(root, path);
          return !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`);
        });
        expect(confined, path).toBe(true);
      }
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

  /**
   * `ci.unwatch` is routed to `CiWatcher` before it ever reaches the generic "unknown command"
   * fallback, the same way `jobs.*` is routed to `HeavyJobQueue`. Nothing is registered under the
   * fixture root, so `CiWatcher` itself refuses the request with `WTM_WORKSPACE_NOT_FOUND` — proof
   * the request reached the watcher rather than being swallowed by the daemon's own dispatch. No
   * real `gh` runs: this refusal happens before the watcher would ever call the provider.
   */
  test('a ci.unwatch request for an unregistered cwd reaches the watcher rather than the unknown-command fallback', () => {
    const isolated = isolatedHome();
    try {
      const result = runScenario('node', ['--import', 'tsx', scenarioPath, 'ci-unwatch'], {
        timeoutMs: 20_000,
        env: isolated.env,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, code: 'WTM_WORKSPACE_NOT_FOUND' });
    } finally {
      isolated.cleanup();
    }
  }, 20_000);

  test('refuses `start` against a worktree already marked CLEANING by a removal in progress', () => {
    // `findRegistration` (task-resolution.ts) resolves purely by path containment and never
    // looked at `worktree.state`, so `wtm start` racing the window between `wtm remove`'s
    // `release-endpoints` stage (which marks the worktree CLEANING before its `git worktree
    // remove` subprocess runs) and the removal's own `reconcile` stage could still launch a
    // brand-new managed process against a worktree about to disappear. This pins the fix:
    // `ProductionRuntimeResolver`'s `resolveTask`/`resolveExec` now refuse any of the
    // `deadWorktreeStates` (`CLEANING`/`ORPHANED`/`REMOVED`/`DEGRADED_CLEANUP`) the same way an
    // unregistered directory already does.
    const isolated = isolatedHome();
    try {
      const result = runScenario('node', ['--import', 'tsx', scenarioPath, 'dead-worktree'], {
        timeoutMs: 20_000,
        env: isolated.env,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ startExit: 2, ok: false, code: 'WTM_WORKSPACE_NOT_FOUND' });
    } finally {
      isolated.cleanup();
    }
  }, 20_000);

  test('`ps`\'s workspace-wide scope excludes a sibling worktree already marked CLEANING', () => {
    // `ProductionRuntimeResolver.resolveWorktree` computed `workspaceWorktreeIds` from repository
    // membership alone, with no state filter -- unlike `featureGroup`, which already excludes
    // `deadWorktreeStates` for the same "every worktree this repository has ever held, forever"
    // reason. Since worktree rows are soft-deleted and never purged, `wtm ps` from any live
    // sibling accumulated every worktree the repository ever held, including ones mid-removal or
    // removed long ago, and kept reporting their (never-pruned) historical processes. This pins
    // the fix: the sibling's own residual process is no longer in scope from elsewhere, while a
    // caller resolving *against* the dead worktree itself would still see it (not exercised here;
    // see the CLEANING-refusal test above for that half of `deadWorktreeStates`' two call sites).
    const isolated = isolatedHome();
    try {
      const result = runScenario('node', ['--import', 'tsx', psScopeScenarioPath], {
        timeoutMs: 20_000,
        env: isolated.env,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ psOk: true, siblingProcessListed: false });
    } finally {
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
  const path = mkdtempSync(join(shortTmpRoot(), 'wtm-scenario-home-'));
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
      // 'aix' stands in for "anywhere WTM has no backend" — darwin, linux and win32 are all
      // supported now, so the refusal path needs a platform that genuinely is not.
      try { return defaultProductionRuntimePaths(macHome, { platform: 'aix', env: {} }); }
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
  // Not `isolatedHomeEnvironment(home)`: that helper's own `join` is correct for the real,
  // host-native `home` every other call site hands it, and wrong for the POSIX literal this
  // describe block injects on purpose to test darwin/linux path derivation from any host --
  // exactly the mismatch a real windows-latest leg surfaced (a backslash-joined XDG_RUNTIME_DIR
  // failing `linuxPlatformPaths`'s own posix `isAbsolute`, silently falling back to the data root).
  const confined = (platform: 'darwin' | 'linux') => resolve(platform, {
    ...hostile,
    HOME: home,
    XDG_CONFIG_HOME: posixJoin(home, '.config'),
    XDG_STATE_HOME: posixJoin(home, '.local', 'state'),
    XDG_DATA_HOME: posixJoin(home, '.local', 'share'),
    XDG_CACHE_HOME: posixJoin(home, '.cache'),
    XDG_RUNTIME_DIR: posixJoin(home, 'run'),
  });

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
    const dataRoot = mkdtempSync(join(shortTmpRoot(), 'wtm-limit-'));
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
    const dataRoot = join(mkdtempSync(join(shortTmpRoot(), 'wtm-limit-')), 'nested');
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
    const dataRoot = mkdtempSync(join(shortTmpRoot(), 'wtm-port-'));
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

  /**
   * The flake behind the two `production daemon composition` tests that drive
   * `runtime-factory.scenario.ts`, replayed through the real macOS reader rather than a stub,
   * because the bug was in the reader.
   *
   * macOS `ps` reads the process table once (`KERN_PROC`) and then asks `KERN_PROCARGS2` per
   * process. A task that begins exiting between those two reads is still in the snapshot with a
   * live state while `KERN_PROCARGS2` already refuses, and Apple's `getproclline()` then
   * substitutes `(<p_comm>)` for the whole argument buffer — so both the `comm` and the `command`
   * column come out as the same short name. A fingerprint of `(node) (node)` is not the recorded
   * fingerprint, and reading it as an identity is how `stop` came to answer
   * `RUNTIME_PROCESS_IDENTITY_STALE` for the very process it had just stopped.
   *
   * CI run 34896095080 (`Validate darwin x64`, head `c8eaf5b`) caught one, and its `firstMismatch`
   * entry is what these two tests replay: `state: "R<s"` — live, no `E`, no `Z`, so the reader's
   * zombie check never fired — with `commHash` and `commandHash` both
   * `sha256("(node)")` and `commandBytes: 6`, against `238` and the correct fingerprint in the
   * three readings before it. `processStartTime` and `pgid` are byte-identical in every reading
   * including the bad one, which is what rules out start-time granularity, clock resolution and
   * pgid drift; the anchor's `completion` record puts the bad reading 17 ms after it took SIGTERM,
   * which is far too little for PID reuse to reproduce the same `lstart` and pgid.
   *
   * Neither test waits on wall-clock time for its *outcome*: the `ps` answers are a state machine
   * the supervisor's own bounded polls drive, so the assertions hold on any host.
   */
  describe('a ps reading whose arguments the kernel would not hand over', () => {
    const pid = 69874;
    const start = 'Mon Sep 14 21:04:18 2026';
    const node = '/Users/runner/hostedtoolcache/node/24.18.0/x64/bin/node';
    const command = `${node} --import tsx anchor.ts ${'a'.repeat(64)}`;
    /** The three good readings: `commandBytes: 238`-shaped, fingerprint intact. */
    const liveLine = `${String(pid)} S<s  ${start} ${node} ${command}\n`;
    /** The bad reading, in the shape and state the runner reported. */
    const unreadableLine = `${String(pid)} R<s  ${start} (node) (node)\n`;
    const listing = (present: boolean) =>
      present ? `    1     1 Ss\n${String(pid)} ${String(pid)} R<s\n` : '    1     1 Ss\n';
    const psAbsent = () => Object.assign(new Error('ps'), { code: 1, stdout: '', stderr: '' });
    const delay = (milliseconds: number) =>
      new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

    interface StopReplay {
      readonly state: string;
      readonly recordState: string | undefined;
      readonly signals: readonly { pgid: number; signal: NodeJS.Signals }[];
    }

    /**
     * One real `createProductionDaemon` over one real `createDarwinProcessPlatform`, reading the
     * `ps` answers the caller's state machine serves. Only the answers differ between the two
     * tests; everything the supervisor does with them is production code.
     */
    async function stopThroughDarwinReader(options: {
      gracePeriodMs: number;
      pollIntervalMs: number;
      runCommand: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
      onSignal: (pgid: number, signal: NodeJS.Signals) => void;
    }): Promise<StopReplay> {
      const signals: { pgid: number; signal: NodeJS.Signals }[] = [];
      const darwinProcess = createDarwinProcessPlatform({
        runCommand: async (file, args) => await options.runCommand(file, args),
      });
      const platformRuntime: PlatformRuntime = {
        ...selectPlatformRuntime({ platform: 'darwin', home: '/Users/somebody', env: {} }),
        process: {
          ...darwinProcess,
          // Recorded rather than asserted here: an `expect` thrown inside the supervisor's own
          // try/catch comes back as RUNTIME_STOP_FAILED instead of a readable assertion.
          signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); options.onSignal(pgid, signal); },
        },
      };
      const dataRoot = mkdtempSync(join(shortTmpRoot(), 'wtm-exiting-'));
      const stateStore = new MemoryManagedProcessStore();
      stateStore.reserveManagedProcessStart('worktree-1', 'hold', 'token', new Date().toISOString());
      const record = stateStore.createManagedProcess({
        worktreeId: 'worktree-1', taskName: 'hold', pid, pgid: pid, processStartTime: start,
        commandFingerprint: observedCommandFingerprint(node, command),
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
          gracePeriodMs: options.gracePeriodMs,
          pollIntervalMs: options.pollIntervalMs,
        });
        try {
          const stopped = await runtime.supervisor.stop({ worktreeId: 'worktree-1', taskName: 'hold' });
          return {
            state: stopped.state,
            recordState: stateStore.getManagedProcess(record.id)?.state,
            signals,
          };
        } finally { await runtime.close(); }
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }

    /**
     * The path CI actually took, per the run-34896095080 trace: the task outlived the grace budget,
     * so `waitForOwnedGroupChange` ran out its deadline with the identity present and answered
     * `alive` (`process-supervisor.ts:758`), and the bad reading landed on the pre-SIGKILL
     * `inspectWithRetry` at `:583`, which turned it into `STALE_IDENTITY` at `:596`.
     *
     * Reproducing that needs the wait loop to turn exactly once, and nothing here is allowed to
     * *guess* when it has: an earlier version opened the exit window at
     * `Date.now() >= sigtermAt + gracePeriodMs`, which is a different clock from the loop's own
     * `Date.now() + timeoutMs` taken at `:742`, and on a loaded CI runner the window opened while
     * the loop was still turning — `waitForOwnedGroupChange` answered `failed` at `:745-746` and
     * the stop died with `PROCESS_INSPECTION_FAILED` (PR #18, `Validate linux x64`).
     *
     * So the loop's exit is made structural instead. The group listing takes a real timer longer
     * than the whole grace budget, and `waitForOwnedGroupChange` serves that listing *after* the
     * inspect of the same turn and then checks its deadline — which the listing has therefore
     * already blown. One turn, and load can only make the margin larger, because a timer never
     * fires early. The stub then keys its answers off *how many listings it has served*, never off
     * a clock: everything before the first listing is inside the loop, everything after it is the
     * `:583` retry.
     *
     * The trace is asserted first, and in order, because that is how the branch was identified in
     * CI: the `mismatch` branch at `:576` lists the group at `:577` before it transitions at
     * `:579`, and no group listing follows the bad reading — in the log, or here. Asserting it
     * ahead of the state keeps a regression's *reported* failure branch-specific rather than the
     * `STOPPED`/`STALE_IDENTITY` line both cases would print.
     */
    test('a stop past its grace budget retries the unreadable reading instead of calling the task stale', async () => {
      const gracePeriodMs = 150;
      /** Longer than the whole grace budget, so the listing that ends a turn also ends the loop. */
      const listingDelayMs = gracePeriodMs * 2;
      let phase: 'running' | 'gone' = 'running';
      let listingsServed = 0;
      let unreadableServed = false;
      const trace: string[] = [];
      const replay = await stopThroughDarwinReader({
        gracePeriodMs,
        pollIntervalMs: 5,
        onSignal: () => {},
        runCommand: async (_file, args) => {
          if (args.includes('-axo')) {
            trace.push('group');
            listingsServed += 1;
            const stdout = listing(phase !== 'gone');
            await delay(listingDelayMs);
            return { stdout };
          }
          // Before the first listing the reader is either `#stopLocked`'s pre-SIGTERM inspect or
          // the wait loop's own — both must see a live, matching task. After it the loop is over,
          // so the next inspect is the pre-SIGKILL `inspectWithRetry` at `:583`.
          if (listingsServed === 0) { trace.push('inspect:live'); return { stdout: liveLine }; }
          // One `(node) (node)` answer, then the zombie is reaped. Until the pid itself has been
          // seen gone the group listing still shows the anchor, exactly as it did in CI — so the
          // outcome cannot come from the group having quietly emptied.
          if (!unreadableServed) {
            unreadableServed = true;
            trace.push('inspect:unreadable');
            return { stdout: unreadableLine };
          }
          phase = 'gone';
          trace.push('inspect:absent');
          throw psAbsent();
        },
      });

      expect(replay.signals).toEqual([{ pgid: pid, signal: 'SIGTERM' }]);
      // First, because it is the assertion that names the branch: the bad reading really was
      // served, and the absent retry follows it with no listing in between. `:576`'s `mismatch`
      // would have listed the group at `:577` before transitioning, so a regression that goes that
      // way reports this line rather than a bare `STOPPED`/`STALE_IDENTITY`.
      expect(trace.slice(trace.indexOf('inspect:unreadable')))
        .toEqual(['inspect:unreadable', 'inspect:absent', 'group']);
      // Exactly two listings: the wait loop's single turn, and the one `:591` takes once the retry
      // has seen the task gone. A third would mean the loop turned again and the bad reading landed
      // inside it — the flake this shape exists to rule out.
      expect(trace.filter((entry) => entry === 'group')).toHaveLength(2);
      expect(replay.state).toBe('STOPPED');
      expect(replay.recordState).toBe('STOPPED');
    });

    /**
     * The same unreadable reading one branch earlier: here the task dies inside the grace budget,
     * so the bad answer arrives while `waitForOwnedGroupChange` is still polling and the group is
     * still listed. Before the fix that is the `mismatch` branch at `process-supervisor.ts:576` —
     * `#inspectGroup` at `:577` says the group is present, and `:579` answers `STALE_IDENTITY`. CI
     * did not take this path, but the reader cannot tell the two apart and neither should the
     * outcome.
     */
    test('a stop inside its grace budget retries the unreadable reading instead of calling the task stale', async () => {
      let phase: 'running' | 'exiting' | 'gone' = 'running';
      let unreadableServed = false;
      const trace: string[] = [];
      const replay = await stopThroughDarwinReader({
        gracePeriodMs: 1_000,
        pollIntervalMs: 5,
        onSignal: () => { phase = 'exiting'; },
        runCommand: async (_file, args) => {
          if (args.includes('-axo')) {
            trace.push('group');
            return { stdout: listing(phase !== 'gone') };
          }
          if (phase === 'running') { trace.push('inspect:live'); return { stdout: liveLine }; }
          // One `(node) (node)` answer, then the zombie is reaped. Until the pid itself has been
          // seen gone the group listing still shows the anchor, exactly as it did in CI — which is
          // what makes the pre-fix answer `STALE_IDENTITY` rather than `STOPPED`.
          if (!unreadableServed) {
            unreadableServed = true;
            trace.push('inspect:unreadable');
            return { stdout: unreadableLine };
          }
          phase = 'gone';
          trace.push('inspect:absent');
          throw psAbsent();
        },
      });

      expect(replay.signals).toEqual([{ pgid: pid, signal: 'SIGTERM' }]);
      expect(trace).toContain('inspect:unreadable');
      expect(replay.state).toBe('STOPPED');
      expect(replay.recordState).toBe('STOPPED');
    });
  });
});
