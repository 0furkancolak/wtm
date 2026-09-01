/**
 * The systemd half of the service lifecycle, against an injected fake `systemctl`.
 *
 * This is the same evidence the launchd tests provide, and it is worth being exact about what
 * that is: it establishes the argument vectors, the order they are issued in, and the state
 * machine that decides which of them to issue. It establishes nothing whatever about whether
 * systemd accepts the unit this publishes, because no systemd runs here. C2 owns that, and a
 * green run of this file is not a substitute for it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxServiceBackend } from '@wtm/platform/service';
import type { ServiceCommandResult } from '@wtm/platform/service';
import { createServiceLifecycle, servicePathsFor } from '../service-lifecycle';
import type { ServiceLifecycleOptions } from '../service-lifecycle';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'wtm-systemd-'));
  roots.push(home);
  return home;
}

function paths(home: string) {
  return servicePathsFor(linuxServiceBackend, { home, env: {} });
}

function lifecycle(home: string, manager: FakeSystemd, overrides: Partial<ServiceLifecycleOptions> = {}) {
  return createServiceLifecycle({
    backend: linuxServiceBackend,
    home,
    // The ambient environment is never read: a developer with `XDG_STATE_HOME` exported would
    // otherwise move this test's database out of its temporary home.
    env: {},
    uid: 1000,
    platform: 'linux',
    programArguments: ['/opt/node/bin/node', '/opt/wtm/cli.js', 'daemon', 'serve'],
    pathEnvironment: '/usr/bin:/bin',
    commandRunner: manager.runner,
    processInspector: {
      current: async () => ({ pid: process.pid, startIdentity: '17:4242' }),
      inspect: async () => ({ state: 'dead', startIdentity: null }),
    },
    lockPollAttempts: 1,
    ...overrides,
  });
}

describe('systemd lifecycle', () => {
  test('publishes a user unit, reloads, enables and starts it', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    const unit = `${paths(home).label}.service`;

    const result = await lifecycle(home, manager).install();

    expect(result).toEqual({
      action: 'install',
      state: 'installed',
      label: paths(home).label,
      definitionPath: paths(home).definitionPath,
    });
    expect(manager.calls.map((argv) => argv[2])).toEqual([
      'show', 'show', 'daemon-reload', 'enable', 'start',
    ]);
    // The definition has to be on disk and reloaded before `enable` can resolve the unit name.
    expect(manager.calls[3]).toEqual(['/usr/bin/systemctl', '--user', 'enable', unit]);
    expect(manager.units.get(unit)).toEqual({ enabled: true, active: true });
    const definition = await readFile(paths(home).definitionPath, 'utf8');
    expect(definition).toContain('ExecStart="/opt/node/bin/node" "/opt/wtm/cli.js" "daemon" "serve"');
    expect(definition).toContain(`Environment="HOME=${home}" "PATH=/usr/bin:/bin"`);
    expect((await lstat(paths(home).definitionPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths(home).dataRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths(home).logRoot)).mode & 0o777).toBe(0o700);
  });

  test('has no legacy label to migrate, and issues no command looking for one', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);

    await lifecycle(home, manager).install();

    // The launchd install spends two extra `print`s establishing whether an old-label agent is
    // this HOME's. Linux has never published a unit under another name, so the descriptor omits
    // the migration entirely rather than carrying a hook that can only ever answer "no".
    expect(paths(home).legacyDefinitionPath).toBeNull();
    expect(manager.calls.filter((argv) => argv[2] === 'show')).toHaveLength(2);
  });

  test('reports loaded, installed-not-loaded and absent without mutating anything', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    await lifecycle(home, manager).install();

    const loaded = await lifecycle(home, manager).status();
    expect(loaded.state).toBe('loaded');
    expect(loaded.runState).toBe('running');

    // A stopped unit is still known to systemd, and its definition is still on disk. That is the
    // same condition a booted-out launchd job is in, and it gets the same answer.
    manager.units.get(`${paths(home).label}.service`)!.active = false;
    const stopped = await lifecycle(home, manager).status();
    expect(stopped.state).toBe('installed-not-loaded');
    expect(stopped.runState).toBeNull();

    await rm(paths(home).definitionPath);
    manager.units.clear();
    expect((await lifecycle(home, manager).status()).state).toBe('absent');
  });

  test('restarts an unchanged definition instead of republishing it', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    await lifecycle(home, manager).install();
    const before = await lstat(paths(home).definitionPath);
    manager.calls.length = 0;

    expect((await lifecycle(home, manager).install()).state).toBe('restarted');

    const after = await lstat(paths(home).definitionPath);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
    expect(manager.calls.map((argv) => argv[2])).toEqual(['show', 'enable', 'restart']);
  });

  test('stops, disables, removes and reloads, then reports the second uninstall as absent', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    await lifecycle(home, manager).install();
    manager.calls.length = 0;

    expect((await lifecycle(home, manager).uninstall()).state).toBe('uninstalled');

    // `disable` runs while the unit file is still there: systemd cannot undo a registration for a
    // definition that has already been deleted, and skipping it would strand the
    // `default.target.wants` symlink `enable` created.
    // One `show` establishes that systemd is running the unit; the second is the absence probe
    // after `stop`. The domain is never consulted, because the first answer was not an absence.
    expect(manager.calls.map((argv) => argv[2])).toEqual([
      'show', 'stop', 'show', 'disable', 'daemon-reload',
    ]);
    expect(await readdir(paths(home).serviceDirectory)).toEqual([]);
    expect(manager.units.size).toBe(0);

    expect((await lifecycle(home, manager).uninstall()).state).toBe('already-absent');
  });

  test('installs below the 0755 unit directory every Linux machine actually has', async () => {
    const home = await fakeHome();
    const unitDirectory = paths(home).serviceDirectory;
    // What `systemctl enable` and the standard umask leave behind. Requiring 0700 here would mean
    // refusing to install on essentially every host -- and it would mean tightening a directory
    // that belongs to systemd's own tooling and to every other user unit sitting in it.
    await mkdir(unitDirectory, { recursive: true, mode: 0o755 });
    await chmod(join(home, '.config'), 0o755);
    await chmod(join(home, '.config', 'systemd'), 0o755);
    await chmod(unitDirectory, 0o755);
    const manager = fakeSystemd(unitDirectory);

    expect((await lifecycle(home, manager).install()).state).toBe('installed');

    expect((await lstat(unitDirectory)).mode & 0o777).toBe(0o755);
    // The directory is readable by others; the definition inside it is not. That is the property
    // the owner-only bits were protecting, and it is enforced on the file, on both platforms.
    expect((await lstat(paths(home).definitionPath)).mode & 0o777).toBe(0o600);
    // The state and log roots stay owner-only: those are directories WTM does own.
    expect((await lstat(paths(home).dataRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths(home).logRoot)).mode & 0o777).toBe(0o700);
  });

  test('still refuses a unit directory anyone else can write to', async () => {
    // This is the half that must not regress. Group- or other-write means another user can plant
    // a unit file that systemd would then run as this user, which no directory mode relaxation is
    // allowed to permit.
    for (const mode of [0o775, 0o757]) {
      const home = await fakeHome();
      const unitDirectory = paths(home).serviceDirectory;
      await mkdir(unitDirectory, { recursive: true, mode: 0o755 });
      await chmod(unitDirectory, mode);
      const manager = fakeSystemd(unitDirectory);

      await expect(lifecycle(home, manager).install()).rejects.toMatchObject({
        code: 'UNSAFE_LAUNCHD_PATH',
      });
      expect(manager.calls).toEqual([]);
      expect(await readdir(unitDirectory)).toEqual([]);
    }
  });

  test('reports a failed command with the operation that failed', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    manager.failures.set('enable', failure(1, 'Failed to enable unit'));

    await expect(lifecycle(home, manager).install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED',
      message: 'systemctl enable failed.',
      context: { operation: 'enable', exitCode: 1 },
    });
  });

  test('rolls the published unit back off disk when the reload it needs fails', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    manager.failures.set('daemon-reload', failure(1, 'Failed to reload daemon'));

    await expect(lifecycle(home, manager).install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'reload' },
    });

    // A unit systemd was never told about is a unit that will never run. Leaving the file behind
    // would make the next `status` report `installed-not-loaded` for a daemon that does not exist.
    expect(await readdir(paths(home).serviceDirectory)).toEqual([]);
  });

  test('restores the previous unit and its running service when the restart fails', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    await lifecycle(home, manager).install();
    const published = await readFile(paths(home).definitionPath, 'utf8');
    manager.failures.set('start', failure(1, 'Job failed'));

    await expect(lifecycle(home, manager, {
      programArguments: ['/opt/node/bin/node', '/opt/wtm/next/cli.js', 'daemon', 'serve'],
    }).install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'bootstrap' },
    });

    // The definition that is on disk afterwards is the one that was running before, not the one
    // whose service could not be started.
    expect(await readFile(paths(home).definitionPath, 'utf8')).toBe(published);
  });

  test('distinguishes an unavailable user manager from an absent unit', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);
    manager.failures.set('show', failure(1, 'Failed to connect to bus: No such file or directory'));

    await expect(lifecycle(home, manager).status()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'print', exitCode: 1 },
    });

    manager.failures.clear();
    manager.domainAvailable = false;
    await expect(lifecycle(home, manager).status()).rejects.toMatchObject({
      code: 'LAUNCHD_DOMAIN_UNAVAILABLE',
      message: 'The systemd user manager is unavailable.',
    });
  });

  test('refuses to touch a host that is not running systemd', async () => {
    const home = await fakeHome();
    const manager = fakeSystemd(paths(home).serviceDirectory);

    await expect(lifecycle(home, manager, { platform: 'darwin' }).install()).rejects.toMatchObject({
      code: 'LAUNCHD_UNSUPPORTED_PLATFORM',
      message: 'systemd is only available on Linux',
    });
    expect(manager.calls).toEqual([]);
  });

  test('publishes below the XDG directories the environment names', async () => {
    const home = await fakeHome();
    const state = await fakeHome();
    const config = await fakeHome();
    const env = { XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };
    const resolved = servicePathsFor(linuxServiceBackend, { home, env });
    const manager = fakeSystemd(resolved.serviceDirectory);

    const result = await createServiceLifecycle({
      backend: linuxServiceBackend,
      home,
      env,
      uid: 1000,
      platform: 'linux',
      programArguments: ['/opt/wtm/bin/wtm', 'daemon', 'serve'],
      commandRunner: manager.runner,
      processInspector: {
        current: async () => ({ pid: process.pid, startIdentity: '17:4242' }),
        inspect: async () => ({ state: 'dead', startIdentity: null }),
      },
      lockPollAttempts: 1,
    }).install();

    expect(result.definitionPath).toBe(join(config, 'systemd', 'user', `${resolved.label}.service`));
    expect(await readFile(result.definitionPath, 'utf8')).toContain(`StandardOutput=append:${state}`);
    expect((await lstat(join(state, 'wtm', 'logs'))).mode & 0o777).toBe(0o700);
  });
});

interface FakeSystemd {
  units: Map<string, { enabled: boolean; active: boolean }>;
  calls: string[][];
  failures: Map<string, ServiceCommandResult>;
  domainAvailable: boolean;
  runner: (argv: readonly string[]) => Promise<ServiceCommandResult>;
}

/**
 * A systemd user manager that behaves like the real one in the respects this lifecycle depends
 * on: it knows a unit only after a `daemon-reload` has seen its file, it forgets one whose file
 * has gone, and it answers for a unit it does not know with exit 5 rather than with a failure.
 */
function fakeSystemd(unitDirectory: string): FakeSystemd {
  const manager: FakeSystemd = {
    units: new Map(),
    calls: [],
    failures: new Map(),
    domainAvailable: true,
    runner: async (argv) => {
      manager.calls.push([...argv]);
      const verb = argv[2] as string;
      const forced = manager.failures.get(verb);
      // A forced failure fires once. A command that fails for ever also fails during the
      // rollback that follows it, which reports `LAUNCHD_ROLLBACK_FAILED` and hides the
      // original cause -- the same thing the launchd tests avoid by failing only the first
      // `enable`.
      if (forced !== undefined) {
        manager.failures.delete(verb);
        return forced;
      }
      if (verb === 'show') {
        if (argv[3] === '--property=Version') {
          return manager.domainAvailable
            ? success('Version=255\n')
            : failure(1, 'Failed to connect to bus: No such file or directory');
        }
        const state = manager.units.get(argv.at(-1) as string);
        return success(state === undefined
          ? 'LoadState=not-found\nActiveState=inactive\nSubState=dead\n'
          : `LoadState=loaded\nActiveState=${state.active ? 'active' : 'inactive'}\nSubState=${state.active ? 'running' : 'dead'}\n`);
      }
      if (verb === 'daemon-reload') {
        const names = await readdir(unitDirectory).catch(() => [] as string[]);
        for (const name of names.filter((name) => name.endsWith('.service'))) {
          if (!manager.units.has(name)) manager.units.set(name, { enabled: false, active: false });
        }
        for (const name of [...manager.units.keys()]) {
          if (!names.includes(name)) manager.units.delete(name);
        }
        return success('');
      }
      const unit = argv[3] as string;
      const state = manager.units.get(unit);
      if (state === undefined) return notFound();
      if (verb === 'enable') state.enabled = true;
      if (verb === 'disable') state.enabled = false;
      if (verb === 'start' || verb === 'restart') state.active = true;
      if (verb === 'stop') state.active = false;
      return success('');
    },
  };
  return manager;
}

function success(stdout: string): ServiceCommandResult {
  return { outcome: 'success', exitCode: 0, stdout, stderr: '' };
}

function notFound(): ServiceCommandResult {
  return { outcome: 'not-found', exitCode: 5, stdout: '', stderr: 'Unit not found.' };
}

function failure(exitCode: number, stderr: string): ServiceCommandResult {
  return { outcome: 'failure', exitCode, stdout: '', stderr };
}
