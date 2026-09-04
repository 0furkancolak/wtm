import { describe, expect, test } from 'bun:test';
import type { PlatformPathsInput } from '../../ports';
import { darwinPlatformPaths, linuxPlatformPaths, platformPathsFor, windowsPlatformPaths } from '../platform-paths';

const macHome = '/Users/ada';
const linuxHome = '/home/ada';
const windowsHome = 'C:\\Users\\ada';

/** Every XDG variable this increment knows about, set to a plausible absolute value. */
const allXdgSet = {
  XDG_STATE_HOME: '/xdg/state',
  XDG_CONFIG_HOME: '/xdg/config',
  XDG_RUNTIME_DIR: '/run/user/501',
  XDG_CACHE_HOME: '/xdg/cache',
} as const satisfies PlatformPathsInput['env'];

describe('macOS paths', () => {
  test('keeps the state database, the socket and the global config under Application Support', () => {
    const paths = darwinPlatformPaths({ home: macHome, env: {} });

    expect(paths.dataRoot).toBe('/Users/ada/Library/Application Support/WTM');
    expect(paths.socketRoot).toBe('/Users/ada/Library/Application Support/WTM');
    expect(paths.configPath).toBe('/Users/ada/Library/Application Support/WTM/config.toml');
  });

  test('logs to ~/Library/Logs/WTM and publishes its service into ~/Library/LaunchAgents', () => {
    const paths = darwinPlatformPaths({ home: macHome, env: {} });

    expect(paths.logRoot).toBe('/Users/ada/Library/Logs/WTM');
    expect(paths.serviceRoot).toBe('/Users/ada/Library/LaunchAgents');
  });

  test('ignores every XDG variable, even when each one is an absolute path', () => {
    // A macOS user who exports XDG_CONFIG_HOME for some other tool must not discover that WTM's
    // state, socket and launch agent have silently moved with it.
    expect(darwinPlatformPaths({ home: macHome, env: allXdgSet }))
      .toEqual(darwinPlatformPaths({ home: macHome, env: {} }));
  });
});

describe('Linux paths', () => {
  test('falls back to the XDG basedir defaults when nothing is set', () => {
    const paths = linuxPlatformPaths({ home: linuxHome, env: {} });

    expect(paths).toEqual({
      dataRoot: '/home/ada/.local/state/wtm',
      configPath: '/home/ada/.config/wtm/config.toml',
      logRoot: '/home/ada/.local/state/wtm/logs',
      socketRoot: '/home/ada/.local/state/wtm',
      serviceRoot: '/home/ada/.config/systemd/user',
    });
  });

  test('honours XDG_STATE_HOME, XDG_CONFIG_HOME and XDG_RUNTIME_DIR when they are absolute', () => {
    const paths = linuxPlatformPaths({ home: linuxHome, env: allXdgSet });

    expect(paths).toEqual({
      dataRoot: '/xdg/state/wtm',
      configPath: '/xdg/config/wtm/config.toml',
      logRoot: '/xdg/state/wtm/logs',
      socketRoot: '/run/user/501/wtm',
      serviceRoot: '/xdg/config/systemd/user',
    });
  });

  test('ignores a relative XDG value in favour of the default', () => {
    // The basedir spec calls a relative value invalid, and XDG_RUNTIME_DIR=tmp would otherwise
    // bind the socket somewhere relative to the daemon's working directory.
    const paths = linuxPlatformPaths({
      home: linuxHome,
      env: { XDG_STATE_HOME: 'state', XDG_CONFIG_HOME: '../config', XDG_RUNTIME_DIR: 'tmp' },
    });

    expect(paths).toEqual(linuxPlatformPaths({ home: linuxHome, env: {} }));
  });

  test('ignores an empty XDG value, which the basedir spec treats as unset', () => {
    const paths = linuxPlatformPaths({
      home: linuxHome,
      env: { XDG_STATE_HOME: '', XDG_CONFIG_HOME: '', XDG_RUNTIME_DIR: '' },
    });

    expect(paths).toEqual(linuxPlatformPaths({ home: linuxHome, env: {} }));
  });

  test('puts the logs under whichever data root won, rather than under a second lookup', () => {
    const paths = linuxPlatformPaths({ home: linuxHome, env: { XDG_STATE_HOME: '/xdg/state' } });

    expect(paths.logRoot).toBe('/xdg/state/wtm/logs');
    expect(paths.logRoot.startsWith(`${paths.dataRoot}/`)).toBe(true);
  });

  test('falls the socket root back to the data root when XDG_RUNTIME_DIR is unset', () => {
    // $XDG_RUNTIME_DIR is absent in containers and over `su`. A daemon that refused to start
    // there would be worse than one with a long socket path, which the preflight measures anyway.
    const unset = linuxPlatformPaths({ home: linuxHome, env: { XDG_STATE_HOME: '/xdg/state' } });
    const relative = linuxPlatformPaths({
      home: linuxHome,
      env: { XDG_STATE_HOME: '/xdg/state', XDG_RUNTIME_DIR: 'run/user/501' },
    });

    expect(unset.socketRoot).toBe('/xdg/state/wtm');
    expect(relative.socketRoot).toBe('/xdg/state/wtm');
  });

  test('takes the runtime directory over the data root once it is absolute, and does not move the state with it', () => {
    const paths = linuxPlatformPaths({ home: linuxHome, env: { XDG_RUNTIME_DIR: '/run/user/501' } });

    expect(paths.socketRoot).toBe('/run/user/501/wtm');
    expect(paths.dataRoot).toBe('/home/ada/.local/state/wtm');
  });
});

describe('Windows paths', () => {
  test('keeps data, config, logs and the service root under one WTM-owned root, the way macOS does', () => {
    const paths = windowsPlatformPaths({ home: windowsHome, env: {} });

    expect(paths.dataRoot).toBe('C:\\Users\\ada\\AppData\\Local\\WTM');
    expect(paths.configPath).toBe('C:\\Users\\ada\\AppData\\Local\\WTM\\config.toml');
    expect(paths.logRoot).toBe('C:\\Users\\ada\\AppData\\Local\\WTM\\logs');
    expect(paths.serviceRoot).toBe('C:\\Users\\ada\\AppData\\Local\\WTM\\service');
  });

  test('the socket root is a named-pipe namespace address, not the data directory', () => {
    // Unlike macOS, `dataRoot` cannot double as `socketRoot`: `net.Server.listen({ path })`
    // requires the `\\.\pipe\` prefix on Windows, which a plain directory never carries.
    const paths = windowsPlatformPaths({ home: windowsHome, env: {} });

    expect(paths.socketRoot.startsWith('\\\\.\\pipe\\wtm-')).toBe(true);
    expect(paths.socketRoot).not.toBe(paths.dataRoot);
  });

  test('the pipe name is deterministic per data root, and differs when the data root does', () => {
    const first = windowsPlatformPaths({ home: windowsHome, env: {} });
    const again = windowsPlatformPaths({ home: windowsHome, env: {} });
    const otherUser = windowsPlatformPaths({ home: 'C:\\Users\\bea', env: {} });

    expect(again.socketRoot).toBe(first.socketRoot);
    expect(otherUser.socketRoot).not.toBe(first.socketRoot);
  });

  test('honours LOCALAPPDATA when it is an absolute Windows path', () => {
    const paths = windowsPlatformPaths({ home: windowsHome, env: { LOCALAPPDATA: 'D:\\Local' } });

    expect(paths.dataRoot).toBe('D:\\Local\\WTM');
  });

  test('ignores a relative LOCALAPPDATA in favour of the default', () => {
    const paths = windowsPlatformPaths({ home: windowsHome, env: { LOCALAPPDATA: 'Local' } });

    expect(paths).toEqual(windowsPlatformPaths({ home: windowsHome, env: {} }));
  });

  test('ignores an empty LOCALAPPDATA, the same as an unset one', () => {
    const paths = windowsPlatformPaths({ home: windowsHome, env: { LOCALAPPDATA: '' } });

    expect(paths).toEqual(windowsPlatformPaths({ home: windowsHome, env: {} }));
  });

  test('reads only its arguments, never the ambient process environment', () => {
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\ambient';
    try {
      expect(windowsPlatformPaths({ home: windowsHome, env: {} }).dataRoot)
        .toBe('C:\\Users\\ada\\AppData\\Local\\WTM');
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    }
  });

  test('platformPathsFor dispatches win32 to the Windows resolver', () => {
    const input = { home: windowsHome, env: {} };

    expect(platformPathsFor('win32', input)).toEqual(windowsPlatformPaths(input));
  });
});

describe('both platforms', () => {
  test('configPath names the file, not the directory holding it', () => {
    for (const paths of [
      darwinPlatformPaths({ home: macHome, env: allXdgSet }),
      linuxPlatformPaths({ home: linuxHome, env: allXdgSet }),
      linuxPlatformPaths({ home: linuxHome, env: {} }),
    ]) {
      expect(paths.configPath.endsWith('/config.toml')).toBe(true);
    }
  });

  test('XDG_CACHE_HOME moves nothing, because no path in this port derives from it', () => {
    const cacheOnly = { XDG_CACHE_HOME: '/xdg/cache' };

    expect(linuxPlatformPaths({ home: linuxHome, env: cacheOnly }))
      .toEqual(linuxPlatformPaths({ home: linuxHome, env: {} }));
    expect(darwinPlatformPaths({ home: macHome, env: cacheOnly }))
      .toEqual(darwinPlatformPaths({ home: macHome, env: {} }));
  });

  test('reads only its arguments, never the ambient process environment', () => {
    // The Linux resolver has to be constructible from this macOS host, which is impossible the
    // moment it consults `process.env` or `os.homedir()` for anything.
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '/ambient/state';
    try {
      expect(linuxPlatformPaths({ home: linuxHome, env: {} }).dataRoot)
        .toBe('/home/ada/.local/state/wtm');
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });

  test('platformPathsFor dispatches on the platform id', () => {
    const input: PlatformPathsInput = { home: linuxHome, env: allXdgSet };

    expect(platformPathsFor('linux', input)).toEqual(linuxPlatformPaths(input));
    expect(platformPathsFor('darwin', input)).toEqual(darwinPlatformPaths(input));
  });
});
