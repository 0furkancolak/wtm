import { describe, expect, test } from 'bun:test';
import { launchdLabelFor } from '../darwin';
import { linuxPlatformPaths } from '../../paths';
import {
  linuxServiceBackend,
  renderSystemdUnit,
  runSystemctl,
  systemctlCommands,
  systemdUnitLabelFor,
} from '../linux';
import type { ServiceCommandResult } from '../types';

const home = '/home/test';
const label = systemdUnitLabelFor(home);

function show(properties: Record<string, string>): ServiceCommandResult {
  return {
    outcome: 'success',
    exitCode: 0,
    stdout: `${Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    stderr: '',
  };
}

describe('systemd unit naming', () => {
  test('derives the unit from HOME with the digest launchd derives its label from', () => {
    // The symmetry is the point: one derivation stated once. A Linux unit name that merely
    // resembled the macOS label would be a second rule to keep true, and the first time the two
    // drifted nothing would notice until a user had two agents under two names.
    const digest = launchdLabelFor(home).slice('dev.wtm.daemon.'.length);
    expect(label).toBe(`wtm-daemon-${digest}`);
    expect(label).toMatch(/^wtm-daemon-[0-9a-f]{32}$/);
    expect(systemdUnitLabelFor(`${home}/`)).toBe(label);
    expect(systemdUnitLabelFor('/home/other')).not.toBe(label);
    expect(() => systemdUnitLabelFor('relative/home')).toThrow('must be absolute');
  });

  test('publishes into the XDG user unit directory', () => {
    const paths = linuxPlatformPaths({ home, env: {} });
    expect(paths.serviceRoot).toBe('/home/test/.config/systemd/user');
    expect(linuxServiceBackend.definitionPath({ serviceRoot: paths.serviceRoot, label }))
      .toBe(`/home/test/.config/systemd/user/${label}.service`);
  });
});

describe('systemctl commands', () => {
  test('names the unit after the file it is given, not a fixed name', () => {
    const commands = systemctlCommands({ uid: 1000, definitionPath: `/units/${label}.service` });
    expect(commands.enable).toEqual(['/usr/bin/systemctl', '--user', 'enable', `${label}.service`]);
    expect(() => systemctlCommands({ uid: 1000, definitionPath: '/units/agent.txt' }))
      .toThrow('must name a systemd unit');
  });

  test('drives the user manager and nothing else', () => {
    expect(systemctlCommands({ uid: 1000, definitionPath: '/units/wtm-daemon-a.service' })).toEqual({
      print: [
        '/usr/bin/systemctl', '--user', 'show',
        '--property=LoadState', '--property=ActiveState', '--property=SubState',
        'wtm-daemon-a.service',
      ],
      printDomain: ['/usr/bin/systemctl', '--user', 'show', '--property=Version'],
      reload: ['/usr/bin/systemctl', '--user', 'daemon-reload'],
      enable: ['/usr/bin/systemctl', '--user', 'enable', 'wtm-daemon-a.service'],
      disable: ['/usr/bin/systemctl', '--user', 'disable', 'wtm-daemon-a.service'],
      bootstrap: ['/usr/bin/systemctl', '--user', 'start', 'wtm-daemon-a.service'],
      bootout: ['/usr/bin/systemctl', '--user', 'stop', 'wtm-daemon-a.service'],
      kickstart: ['/usr/bin/systemctl', '--user', 'restart', 'wtm-daemon-a.service'],
    });
  });

  test('refuses to run an argv that is not systemctl', async () => {
    await expect(runSystemctl(['/bin/sh', '-c', 'true'])).rejects.toMatchObject({
      code: 'INVALID_LAUNCHD_CONFIGURATION',
    });
  });
});

describe('systemd unit body', () => {
  test('renders a deterministic unit and escapes every value systemd would expand', () => {
    expect(renderSystemdUnit({
      label: 'wtm-daemon-abc',
      programArguments: ['/opt/node bin/node', '/opt/wtm/cli.js', 'daemon', 'serve', 'q"$HOME\\100%'],
      home: '/home/a b',
      workingDirectory: '/home/a b',
      stdoutPath: '/home/a b/.local/state/wtm/logs/daemon.log',
      stderrPath: '/home/a b/.local/state/wtm/logs/daemon.error.log',
      pathEnvironment: '/usr/bin:/bin',
    })).toBe(`[Unit]
Description=WTM daemon for /home/a b
Documentation=https://github.com/0furkancolak/wtm

[Service]
Type=exec
ExecStart="/opt/node bin/node" "/opt/wtm/cli.js" "daemon" "serve" "q\\"$$HOME\\\\100%%"
WorkingDirectory=/home/a b
Environment="HOME=/home/a b" "PATH=/usr/bin:/bin"
StandardOutput=append:/home/a b/.local/state/wtm/logs/daemon.log
StandardError=append:/home/a b/.local/state/wtm/logs/daemon.error.log
Restart=on-failure
RestartSec=1
TimeoutStopSec=5
UMask=0077

[Install]
WantedBy=default.target
`);
  });

  test('refuses an argv, a path or a value a unit file cannot carry', () => {
    const base = {
      label: 'wtm-daemon-abc',
      programArguments: ['/opt/wtm/bin/wtm', 'daemon', 'serve'],
      home: '/home/a',
      workingDirectory: '/home/a',
      stdoutPath: '/home/a/out.log',
      stderrPath: '/home/a/err.log',
      pathEnvironment: '/usr/bin',
    };
    expect(() => renderSystemdUnit({ ...base, programArguments: [] })).toThrow('argv must not be empty');
    expect(() => renderSystemdUnit({ ...base, programArguments: ['node', 'serve'] }))
      .toThrow('executable must be absolute');
    // A newline is ordinary text in a plist and a new directive in a unit file. Nothing WTM
    // passes legitimately contains one, so it is refused rather than escaped.
    expect(() => renderSystemdUnit({ ...base, home: '/home/a\nExecStart=/bin/sh' }))
      .toThrow('systemd home is invalid');
    expect(() => renderSystemdUnit({ ...base, programArguments: ['/bin/sh', 'a\rb'] }))
      .toThrow('systemd argument is invalid');
  });
});

describe('systemd status interpretation', () => {
  test('reads absence out of a command that succeeded', () => {
    // systemd reports an unknown unit through an exit code of 0 and a property, which is the
    // whole reason this hook exists: launchctl says the same thing with exit 113.
    expect(linuxServiceBackend.interpretStatus(show({
      LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead',
    }))).toBe('absent');
    expect(linuxServiceBackend.interpretStatus(show({
      LoadState: 'masked', ActiveState: 'inactive', SubState: 'dead',
    }))).toBe('absent');
  });

  test('counts the states in which the manager is running the job as loaded', () => {
    for (const activeState of ['active', 'activating', 'reloading', 'deactivating']) {
      expect(linuxServiceBackend.interpretStatus(show({
        LoadState: 'loaded', ActiveState: activeState, SubState: 'running',
      }))).toBe('loaded');
    }
  });

  test('reports a stopped or failed unit the way a booted-out launchd job is reported', () => {
    // Neither is "installed": the manager is not running the job. The definition is still on
    // disk, so the lifecycle answers `installed-not-loaded` and `runState` carries the reason.
    for (const activeState of ['inactive', 'failed']) {
      const result = show({ LoadState: 'loaded', ActiveState: activeState, SubState: 'dead' });
      expect(linuxServiceBackend.interpretStatus(result)).toBe('absent');
    }
  });

  test('reports the manager own word for what the job is doing', () => {
    expect(linuxServiceBackend.runState(show({
      LoadState: 'loaded', ActiveState: 'active', SubState: 'running',
    }))).toBe('running');
    // A manager too old to report a substate still says whether the unit is active.
    expect(linuxServiceBackend.runState(show({ LoadState: 'loaded', ActiveState: 'failed' }))).toBe('failed');
    expect(linuxServiceBackend.runState({ outcome: 'not-found', exitCode: 5, stdout: '', stderr: '' })).toBeNull();
  });
});

describe('systemd managed directories', () => {
  test('walks every XDG chain from the home that contains it', () => {
    const paths = linuxPlatformPaths({ home, env: {} });
    const plan = linuxServiceBackend.directories({
      home, serviceRoot: paths.serviceRoot, dataRoot: paths.dataRoot, logRoot: paths.logRoot,
    });
    expect(plan.root).toBe(home);
    // The unit directory is not owner-only, and macOS's `LaunchAgents` still is. `~/.config` is
    // 0755 on every machine with the standard umask and `systemctl enable` creates
    // `~/.config/systemd/user` the same way, so requiring 0700 would refuse to install anywhere.
    // What defends the daemon is the group/other *write* check, which every entry gets regardless.
    expect(plan.definition).toEqual([
      { path: '/home/test/.config', ownerOnly: false },
      { path: '/home/test/.config/systemd', ownerOnly: false },
      { path: '/home/test/.config/systemd/user', ownerOnly: false },
    ]);
    expect(plan.install).toEqual([
      ...plan.definition,
      { path: '/home/test/.local', ownerOnly: false },
      { path: '/home/test/.local/state', ownerOnly: false },
      { path: '/home/test/.local/state/wtm', ownerOnly: true },
      { path: '/home/test/.local/state/wtm/logs', ownerOnly: true },
    ]);
  });

  test('roots a chain at the XDG base when the variable points outside the home', () => {
    // `$XDG_CONFIG_HOME=/srv/config` puts the unit outside HOME entirely. A chain rooted at HOME
    // would either escape it or refuse it, and neither is what the user asked for.
    const env = { XDG_CONFIG_HOME: '/srv/config', XDG_STATE_HOME: '/srv/state' };
    const paths = linuxPlatformPaths({ home, env });
    const plan = linuxServiceBackend.directories({
      home, serviceRoot: paths.serviceRoot, dataRoot: paths.dataRoot, logRoot: paths.logRoot,
    });
    expect(plan.root).toBe('/srv/config');
    expect(plan.definition).toEqual([
      { path: '/srv/config/systemd', ownerOnly: false },
      { path: '/srv/config/systemd/user', ownerOnly: false },
    ]);
    expect(plan.install.slice(plan.definition.length)).toEqual([
      { path: '/srv/state/wtm', ownerOnly: true },
      { path: '/srv/state/wtm/logs', ownerOnly: true },
    ]);
  });
});
