import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DaemonSocketPathTooLongError,
  daemonSocketFileName,
  darwinSocketPathLimitBytes,
  linuxSocketPathLimitBytes,
  measureDaemonSocketPath,
  publishedDaemonSocketPath,
} from '@wtm/platform/socket';
import { selectPlatformRuntime } from '@wtm/platform';
import type { PlatformRuntime } from '@wtm/platform/ports';
import { jsonEnvelopeSchema } from '@wtm/protocol';
import { launchdPaths } from '@wtm/daemon/launchd';
import { servicePathsFor, type ServiceLifecycle } from '@wtm/daemon/service-lifecycle';
import {
  runDaemonLifecycleCommand,
  serveDaemon,
  type DaemonSignalSource,
} from '../daemon';
import { exitCodeForError } from '../../exit-codes';
import { createCli, runCli } from '../../main';
import { isolatedHomeEnvironment } from '../../../../testkit/src/isolated-home';
import { runScenario, scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const serveScenarioPath = fileURLToPath(new URL('./daemon-serve.scenario.ts', import.meta.url));
const serveFailureScenarioPath = fileURLToPath(new URL('./daemon-serve-failure.scenario.ts', import.meta.url));

/**
 * The macOS socket root, spelled out rather than read from `PlatformRuntime.paths.socketRoot`.
 *
 * That is the point of it. Deriving it from the same resolver the code under test uses would make
 * this suite agree with any answer that resolver gave; spelling it literally is what pins macOS to
 * the exact path every installed daemon is already listening on across the move onto the platform
 * seam.
 */
function darwinSocketRoot(home: string): string {
  return join(home, 'Library', 'Application Support', 'WTM');
}

/** This macOS host, and a linux one constructed on it — the seam is what makes the second possible. */
const darwinHost = selectPlatformRuntime({ platform: 'darwin', home: '/Users/x', env: {} });
const linuxHost = selectPlatformRuntime({
  platform: 'linux',
  home: '/home/x',
  env: { XDG_RUNTIME_DIR: '/run/user/501' },
});

/** A lifecycle that fails with one of the internal `LAUNCHD_*` codes. */
function failingWith(code: string): ServiceLifecycle {
  const manager = fakeManager();
  manager.status = async () => {
    const error = new Error('raw internal detail');
    Object.assign(error, { code });
    throw error;
  };
  return manager;
}

async function messageFor(code: string, platform: PlatformRuntime): Promise<string | undefined> {
  const envelope = await runDaemonLifecycleCommand('status', failingWith(code), undefined, undefined, platform);
  return envelope.errors[0]?.message;
}

/**
 * `sizeof(sun_path)` for the machine this file runs on: 104 bytes on macOS, 108 on Linux.
 *
 * Every fixture below that reaches a *host* measurement is sized from this. Written as
 * `darwinSocketPathLimitBytes + 1` they were 105 bytes — past macOS's limit and three inside
 * Linux's — so on a Linux runner the refusals these tests are named for never happened.
 */
const hostLimitBytes = selectPlatformRuntime().socket.limitBytes;

/**
 * A socket path of exactly `bytes` bytes, ending in the name the daemon actually publishes.
 *
 * The refusal is a property of the address's length, so a fixture for it has to hit a length.
 * `boundDaemonSocketPath` substitutes the file name's first character rather than prefixing it,
 * which is what keeps the measured path exactly this long.
 */
function socketPathOfBytes(bytes: number): string {
  const segment = bytes - daemonSocketFileName.length - 2;
  if (segment < 1) throw new Error(`${bytes} bytes cannot hold a socket path`);
  const path = `/${'h'.repeat(segment)}/${daemonSocketFileName}`;
  if (Buffer.byteLength(path) !== bytes) throw new Error('fixture did not hit the requested length');
  return path;
}

/** One byte past what a Unix socket address holds on this host: 105 on macOS, 109 on Linux. */
const overLimitOnHost = socketPathOfBytes(hostLimitBytes + 1);

/**
 * One byte past *macOS's* limit, for the tests that name macOS's limit alongside it.
 *
 * Those tests hand the limit to `measureDaemonSocketPath` themselves, so nothing about them is a
 * question about this host: they are the platform half of D3 and stay written in darwin's numbers.
 */
const overLimitOnDarwin = publishedDaemonSocketPath(darwinSocketRoot(`/${'h'.repeat(62)}`));

/**
 * The daemon address this host publishes for `home`, under the isolation the child is given.
 *
 * Both halves matter. `paths.socketRoot` is macOS's `~/Library/Application Support/WTM` and
 * Linux's `$XDG_RUNTIME_DIR/wtm`, and `isolatedHomeEnvironment` is what makes the second of those
 * a directory under `home` rather than the runner's shared `/run/user/<uid>` — which is both why
 * a fixture can size it and why two tests cannot collide on it.
 */
function hostSocketPathFor(home: string): string {
  return publishedDaemonSocketPath(
    selectPlatformRuntime({ home, env: isolatedHomeEnvironment(home) }).paths.socketRoot,
  );
}

/**
 * Where this host's daemon appends its error log for `home`.
 *
 * The same derivation `createDaemonErrorReporter` writes through (`daemon.ts:271`), rather than
 * `launchdPaths(home).stderrPath`: `~/Library/Logs/WTM` is not a directory on Linux, and the log
 * this test reads is the one the daemon actually wrote.
 */
function hostDaemonErrorLogFor(home: string): string {
  const env = isolatedHomeEnvironment(home);
  return servicePathsFor(selectPlatformRuntime({ home, env }).service, { home, env }).stderrPath;
}

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

    // `darwinHost`, because the message below names launchd. Left to select the host, this pinned
    // macOS's wording to whatever machine ran it — the `service manager wording` block further
    // down already proves the same code reads "The systemd user domain is unavailable." on Linux,
    // so on a Linux runner this assertion was simply the other platform's sentence. What is being
    // pinned here is the envelope's shape: one error, the public code, the filtered context, and
    // no trace of `raw secret`.
    const envelope = await runDaemonLifecycleCommand('status', manager, undefined, undefined, darwinHost);

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

    // No `platform` argument: `runDaemonLifecycleCommand` selects the host and measures against
    // its limit, so the address has to be one byte past *that* limit rather than past macOS's.
    const envelope = await runDaemonLifecycleCommand('install', manager, reachable, overLimitOnHost);

    // Nothing was published, and the readiness poll — which would have spent its whole deadline
    // waiting for a socket that cannot exist — was never entered.
    expect(installed).toBe(false);
    expect(probed).toBe(0);
    expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(envelope.errors[0]?.message).toContain(String(hostLimitBytes));
    expect(envelope.errors[0]?.message).toContain(String(hostLimitBytes + 1));
    expect(envelope.errors[0]?.message).toContain(overLimitOnHost);
    expect(envelope.errors[0]?.context).toMatchObject({
      action: 'install',
      byteLength: hostLimitBytes + 1,
      limitBytes: hostLimitBytes,
    });
    expect(envelope.errors[0]?.remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);
  });

  test('a socket path that fits is installed and polled as before', async () => {
    const manager = fakeManager();

    // The address this host would really publish for that home, not macOS's spelling of it: this
    // preflight runs against the host's limit, so its fitting fixture is the host's too.
    const envelope = await runDaemonLifecycleCommand(
      'install',
      manager,
      async () => true,
      publishedDaemonSocketPath(selectPlatformRuntime({ home: '/Users/x' }).paths.socketRoot),
    );

    expect(envelope).toMatchObject({ ok: true, command: 'daemon install', data: { reachable: true } });
  });

  test('the install preflight measures against the limit of the host it is running on', async () => {
    // 105 bytes: past macOS's `sun_path` and inside Linux's. The same address, the same code, two
    // answers — which is the whole reason the limit stopped being a constant.
    const between = `/${'d'.repeat(darwinSocketPathLimitBytes - 1)}`;
    expect(Buffer.byteLength(between)).toBe(darwinSocketPathLimitBytes);
    expect(Buffer.byteLength(between)).toBeLessThan(linuxSocketPathLimitBytes);
    const overOnDarwin = `${between}xy`;

    const onDarwin = await runDaemonLifecycleCommand('install', fakeManager(), async () => true, overOnDarwin, darwinHost);
    const onLinux = await runDaemonLifecycleCommand('install', fakeManager(), async () => true, overOnDarwin, linuxHost);

    expect(onDarwin.ok).toBe(false);
    expect(onDarwin.errors[0]?.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(onDarwin.errors[0]?.context).toMatchObject({ limitBytes: darwinSocketPathLimitBytes });
    expect(onLinux.ok).toBe(true);
  });

  test('the socket path defaults to the root the selected platform publishes on', async () => {
    // No explicit address: `install` must preflight the path the installed service will actually
    // bind, and on Linux that is `$XDG_RUNTIME_DIR/wtm`, not `~/Library/Application Support/WTM`.
    const refusal = await runDaemonLifecycleCommand(
      'install',
      fakeManager(),
      async () => true,
      undefined,
      selectPlatformRuntime({ platform: 'linux', home: '/home/x', env: { XDG_RUNTIME_DIR: `/${'r'.repeat(120)}` } }),
    );

    expect(refusal.ok).toBe(false);
    expect(refusal.errors[0]?.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(refusal.errors[0]?.context).toMatchObject({ limitBytes: linuxSocketPathLimitBytes });
    expect(String(refusal.errors[0]?.context?.path)).toContain('/wtm/wtmd.sock');
  });
});

describe('the published definition path', () => {
  test('macOS carries both names, with the same value', async () => {
    // Additive, not a rename. `plistPath` is a documented field of `wtm daemon status`, and the
    // program map makes JSON output a contract that may only grow — a script reading `plistPath`
    // must keep finding it. `definitionPath` is the name that stays true on both platforms, so it
    // is added beside it rather than in place of it.
    for (const action of ['install', 'uninstall', 'status'] as const) {
      const envelope = await runDaemonLifecycleCommand(action, fakeManager(), undefined, undefined, darwinHost);
      const data = envelope.data as { definitionPath?: string; plistPath?: string };

      expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(data.definitionPath).toBe('/tmp/agent.plist');
      expect(data.plistPath).toBe('/tmp/agent.plist');
      expect(data.plistPath).toBe(data.definitionPath);
    }
  });

  test('linux carries only the neutral name, because there is no plist to point at', async () => {
    for (const action of ['install', 'uninstall', 'status'] as const) {
      const envelope = await runDaemonLifecycleCommand(action, fakeManager(), undefined, undefined, linuxHost);
      const data = envelope.data as object;

      expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(data).toMatchObject({ definitionPath: '/tmp/agent.plist' });
      // Not merely undefined: the key must be absent, or a reader that checks `'plistPath' in data`
      // is told a systemd unit is a plist.
      expect(Object.hasOwn(data, 'plistPath')).toBe(false);
      expect(JSON.stringify(envelope)).not.toContain('plistPath');
    }
  });

  test('the CLI drives the selected backend rather than a hard-wired launchd one', async () => {
    // No injected lifecycle: this is the only test that exercises the construction `main.ts`
    // actually performs. It used to be `createLaunchdLifecycle`, which hardcodes
    // `darwinServiceBackend` — so the Linux service backend was unreachable from the CLI no
    // matter what platform the runtime selected, and `wtm daemon install` on Linux would have
    // driven `launchctl` argument vectors at a host with no `launchctl`.
    let stdout = '';
    const exitCode = await runCli(['daemon', 'status', '--json'], {
      daemonProgramArguments: ['/usr/bin/true'],
      stdout: (value) => { stdout += value; },
      stderr: () => {},
    });
    const envelope = jsonEnvelopeSchema.parse(JSON.parse(stdout));
    const data = envelope.data as Record<string, unknown>;

    expect(envelope.command).toBe('daemon status');
    // What this host answered, spelled out instead of collapsed into a boolean.
    //
    // The first Linux CI run (33648234137) failed the line below with `Expected: true, Received:
    // false` and the log then said nothing whatsoever about *which* code came back — the one fact
    // needed to act on it. This is the only assertion in the file that reads a real service
    // manager rather than an injected one, so it is the one that cannot afford to throw the
    // envelope away. Compared as a string, the failure names the code, the message and the command
    // context the lifecycle attached (`operation`, `exitCode`, `stderr`).
    const answer = envelope.ok
      ? 'ok'
      : `${envelope.errors[0]?.code}: ${envelope.errors[0]?.message} ${JSON.stringify(envelope.errors[0]?.context ?? {})}`;
    // Two outcomes are legitimate against a real host, and neither of them is a macOS fact:
    //
    // - the manager answered about the service published for this HOME, or
    // - the *user* manager was not reachable at all — no GUI session on macOS, no user bus on
    //   Linux (a container, an `ssh` session without lingering, a CI runner with no logind
    //   session).
    //
    // The second is a condition users hit on both platforms and WTM already has a name for it:
    // `LAUNCHD_DOMAIN_UNAVAILABLE` inside the lifecycle, `WTM_DAEMON_UNAVAILABLE` and exit 4 in
    // the envelope. Accepting a third answer here would mean accepting that on Linux the same
    // condition arrives as an unclassified `WTM_DAEMON_REQUEST_FAILED` at exit 1, which is the
    // asymmetry this seam exists to remove — so the pattern stays at two.
    expect(answer).toMatch(/^(?:ok|WTM_DAEMON_UNAVAILABLE: )/);
    if (envelope.ok) {
      expect(exitCode).toBe(0);
      // The definition the *selected* backend names — a plist under `~/Library/LaunchAgents` on
      // macOS, a unit under `$XDG_CONFIG_HOME/systemd/user` on Linux — built the way `main.ts:346`
      // builds it, from `hostPlatformRuntime().service` with the process's own home and
      // environment. Reading `launchdPaths()` here asked a macOS resolver about a host that may
      // not be macOS, which is the same defect one level up from the one this test exists for.
      // Whether `plistPath` rides beside it is a platform question, and the two tests above
      // answer it by injection on both platforms rather than by whichever host ran this one.
      expect(data.definitionPath)
        .toBe(servicePathsFor(selectPlatformRuntime().service, { home: homedir(), env: process.env }).definitionPath);
    } else {
      // The other legitimate answer is only diagnosable if the shell hears it too: exit 4 is what
      // `docs/04-cli-reference.md` documents for "the daemon is unavailable for an operation that
      // requires it", and a script that reads statuses rather than JSON is the reader that cannot
      // tell it from a generic failure otherwise. Written as the literal the table promises, not
      // as `exitCodeForError(...)`, which would agree with whatever that table said.
      expect(exitCode).toBe(4);
    }
  });

  test('the readiness answer still rides beside both names', async () => {
    const envelope = await runDaemonLifecycleCommand('install', fakeManager(), async () => true, undefined, darwinHost);

    expect(envelope.data).toMatchObject({
      action: 'install',
      state: 'installed',
      definitionPath: '/tmp/agent.plist',
      plistPath: '/tmp/agent.plist',
      reachable: true,
    });
  });
});

describe('service manager wording', () => {
  test('macOS says exactly what it has always said', async () => {
    // Every one of these strings is the pre-existing wording, byte for byte. Templating the
    // manager's name into them is only allowed to be invisible on macOS.
    expect(await messageFor('LAUNCHD_DOMAIN_UNAVAILABLE', darwinHost))
      .toBe('The launchd user domain is unavailable.');
    expect(await messageFor('UNSAFE_LAUNCHD_PATH', darwinHost))
      .toBe('The launchd installation path is unsafe.');
    expect(await messageFor('INVALID_LAUNCHD_CONFIGURATION', darwinHost))
      .toBe('The launchd configuration is invalid.');
    expect(await messageFor('LAUNCHD_COMMAND_FAILED', darwinHost))
      .toBe('The launchd operation failed.');
  });

  test('a linux host is told about systemd, not about launchd', async () => {
    for (const code of [
      'LAUNCHD_DOMAIN_UNAVAILABLE',
      'UNSAFE_LAUNCHD_PATH',
      'INVALID_LAUNCHD_CONFIGURATION',
      'LAUNCHD_COMMAND_FAILED',
    ]) {
      const message = await messageFor(code, linuxHost);
      expect(message).toContain('systemd');
      expect(message).not.toContain('launchd');
    }
    expect(await messageFor('LAUNCHD_DOMAIN_UNAVAILABLE', linuxHost))
      .toBe('The systemd user domain is unavailable.');
  });

  test('the platform refusal stops claiming launchd is a macOS-only fact', async () => {
    // `launchd is only available on macOS.` was wrong twice: WTM has a Linux backend now, and
    // which host WTM is on is `UnsupportedPlatformError`'s statement to make, not this one's.
    for (const host of [darwinHost, linuxHost]) {
      const message = await messageFor('LAUNCHD_UNSUPPORTED_PLATFORM', host);
      expect(message).toBe('WTM has no service manager for this host. `wtm doctor` reports the platform it detected.');
      expect(message).not.toContain('macOS');
    }
  });

  test('a backend that does not match the host is a platform refusal, and still exits 2', async () => {
    // It used to report `WTM_CONFIG_INVALID`: nothing about the user's configuration is wrong.
    // The only reason to leave it there was that `WTM_PLATFORM_UNSUPPORTED` had no row in
    // `exitCodeForError` and the remap would have quietly dropped the condition to exit 1.
    const envelope = await runDaemonLifecycleCommand(
      'status',
      failingWith('LAUNCHD_UNSUPPORTED_PLATFORM'),
      undefined,
      undefined,
      darwinHost,
    );

    expect(envelope.errors[0]?.code).toBe('WTM_PLATFORM_UNSUPPORTED');
    expect(exitCodeForError('WTM_PLATFORM_UNSUPPORTED')).toBe(2);
  });

  test('the internal codes keep their names and still map onto the same public codes', async () => {
    // Spec D12: the `LAUNCHD_*` codes are internal, never reach an envelope, and are what
    // `launchd.test.ts` names 99 times. Only the wording above them is platform-aware.
    const mapped = await Promise.all(([
      ['LAUNCHD_DOMAIN_UNAVAILABLE', 'WTM_DAEMON_UNAVAILABLE'],
      ['UNSAFE_LAUNCHD_PATH', 'RESOURCE_PATH_DENIED'],
      ['INVALID_LAUNCHD_CONFIGURATION', 'WTM_CONFIG_INVALID'],
      ['LAUNCHD_UNSUPPORTED_PLATFORM', 'WTM_PLATFORM_UNSUPPORTED'],
      ['LAUNCHD_COMMAND_FAILED', 'WTM_DAEMON_REQUEST_FAILED'],
    ] as const).map(async ([internal, expected]) => {
      const envelope = await runDaemonLifecycleCommand('status', failingWith(internal), undefined, undefined, linuxHost);
      expect(JSON.stringify(envelope)).not.toContain(internal);
      expect(JSON.stringify(envelope)).not.toContain('raw internal detail');
      return [internal, envelope.errors[0]?.code, expected] as const;
    }));

    for (const [, actual, expected] of mapped) expect(actual).toBe(expected);
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
    const failure = new DaemonSocketPathTooLongError(measureDaemonSocketPath(overLimitOnDarwin, darwinSocketPathLimitBytes));

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
        path: overLimitOnDarwin,
        byteLength: darwinSocketPathLimitBytes + 1,
        limitBytes: darwinSocketPathLimitBytes,
        exceededBy: 1,
        publishedPath: overLimitOnDarwin,
        boundPath: measureDaemonSocketPath(overLimitOnDarwin, darwinSocketPathLimitBytes).boundPath,
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
      const result = runScenario('node', ['--import', 'tsx', serveFailureScenarioPath], {
        // `HOME` alone is not isolation: on Linux the ambient `XDG_*` variables survive the spread
        // and send the child's state, config and socket back out to the runner's own directories.
        env: { ...process.env, ...isolatedHomeEnvironment(home) },
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
      const log = await readFile(hostDaemonErrorLogFor(home), 'utf8');
      expect(log).toContain('at createProductionDaemon (/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, scenarioTimeoutMs);

  test('an over-long HOME refuses serve with one coded line naming the length and the limit', async () => {
    const fixture = await overLongHome();
    const measurement = measureDaemonSocketPath(hostSocketPathFor(fixture.home), hostLimitBytes);
    try {
      const result = runScenario('node', ['--import', 'tsx', serveScenarioPath], {
        env: { ...process.env, ...isolatedHomeEnvironment(fixture.home) },
      });

      // Exit 2, not 1: the daemon cannot run here until the user changes something.
      expect(result.status, result.stderr).toBe(2);
      const envelope = JSON.parse(result.stdout);
      expect(jsonEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(envelope).toMatchObject({ ok: false, command: 'daemon serve', data: null });
      expect(envelope.errors[0].code).toBe('WTM_SOCKET_PATH_TOO_LONG');
      expect(envelope.errors[0].message).toContain(String(measurement.byteLength));
      expect(envelope.errors[0].message).toContain(String(hostLimitBytes));
      expect(envelope.errors[0].context).toMatchObject({
        action: 'serve',
        byteLength: measurement.byteLength,
        limitBytes: hostLimitBytes,
      });
      expect(envelope.errors[0].remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }]);

      // One actionable line on stderr, and still no frames on either stream.
      const reported = result.stderr.trimEnd().split('\n');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain(String(measurement.byteLength));
      expect(reported[0]).toContain(String(hostLimitBytes));
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
 * A real HOME whose published socket path lands one byte past *this host's* limit.
 *
 * The refusal is a property of the address's length, so the fixture has to hit a length rather
 * than merely be deep — and the directory is created for real, because a refusal that only
 * happened because `HOME` did not exist would prove nothing about the measurement.
 *
 * The padding used to be computed from `~/Library/Application Support/WTM/wtmd.sock`, which is 33
 * bytes longer than the address the same home yields on Linux. A home padded for macOS therefore
 * produced a Linux socket path nowhere near 109 bytes, and the serve the test expects to be
 * refused would have started. Both platforms grow their socket path byte for byte with the home
 * — macOS because the socket sits under it, Linux because `isolatedHomeEnvironment` puts
 * `$XDG_RUNTIME_DIR` under it — so the padding is arithmetic, and the result is checked rather
 * than assumed.
 */
async function overLongHome(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp('/tmp/wtm-daemon-long-home-');
  const padding = hostLimitBytes + 1 - Buffer.byteLength(hostSocketPathFor(root)) - 1;
  if (padding < 1) throw new Error('the temporary root is already past the socket path limit');
  const home = join(root, 'h'.repeat(padding));
  if (Buffer.byteLength(hostSocketPathFor(home)) !== hostLimitBytes + 1) {
    throw new Error('fixture did not land one byte past the socket path limit');
  }
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
    // The address this host publishes under that home. Spelled as `Library/Application Support`
    // the wait below could only ever time out on Linux, ten seconds at a time, while the daemon
    // was in fact listening perfectly well one directory away.
    const socketPath = hostSocketPathFor(home);
    const child = spawn('node', ['--import', 'tsx', serveScenarioPath], {
      env: { ...process.env, ...isolatedHomeEnvironment(home) },
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

/**
 * The lifecycle result now carries `definitionPath`, not `plistPath`.
 *
 * The CLI builds its lifecycle from the *selected* backend rather than from launchd, so what
 * reaches `runDaemonLifecycleCommand` is a `ServiceLifecycle` and its field has the neutral name.
 * `plistPath` did not disappear from the envelope — the command adds it back on macOS — which is
 * the difference between an additive contract change and a rename, and is pinned below.
 */
function fakeManager(): ServiceLifecycle {
  // The label is derived per HOME, so a stub that pins the bare one would stop resembling
  // anything the lifecycle can return.
  const label = launchdPaths('/tmp/fake-home').label;
  return {
    install: async () => ({ action: 'install', state: 'installed', label, definitionPath: '/tmp/agent.plist' }),
    uninstall: async () => ({ action: 'uninstall', state: 'uninstalled', label, definitionPath: '/tmp/agent.plist' }),
    status: async () => ({ action: 'status', state: 'loaded', label, definitionPath: '/tmp/agent.plist', runState: 'running' }),
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
