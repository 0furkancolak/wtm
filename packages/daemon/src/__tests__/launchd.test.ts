import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LaunchdLifecycleError,
  createLaunchdLifecycle,
  generateLaunchdPlist,
  launchdCommands,
  launchdLabel,
  launchdPaths,
  type LaunchdCommandResult,
  type LaunchdProcessInspector,
  type LaunchdTransactionPhase,
} from '../launchd';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'wtm-launchd-'));
  roots.push(home);
  return home;
}

describe('launchd plist', () => {
  test('renders a deterministic shell-free plist and XML-escapes every dynamic value', () => {
    expect(generateLaunchdPlist({
      label: 'dev.wtm.daemon<&',
      programArguments: ['/opt/Node & Tools/bin/node', '/opt/wtm<next>/cli.js', 'daemon', 'serve', `quote"'`],
      home: '/Users/A & B',
      stdoutPath: '/Users/A & B/Library/Logs/WTM/daemon.log',
      stderrPath: '/Users/A & B/Library/Logs/WTM/daemon.error.log',
      environment: { HOME: '/Users/A & B', PATH: '/opt/a:/usr/bin' },
    })).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.wtm.daemon&lt;&amp;</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/Node &amp; Tools/bin/node</string>
    <string>/opt/wtm&lt;next&gt;/cli.js</string>
    <string>daemon</string>
    <string>serve</string>
    <string>quote&quot;&apos;</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/A &amp; B</string>
    <key>PATH</key>
    <string>/opt/a:/usr/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/A &amp; B</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Adaptive</string>
  <key>ExitTimeOut</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>/Users/A &amp; B/Library/Logs/WTM/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/A &amp; B/Library/Logs/WTM/daemon.error.log</string>
</dict>
</plist>
`);
  });

  test('requires an absolute executable and absolute production paths', () => {
    expect(() => generateLaunchdPlist({
      label: launchdLabel,
      programArguments: ['node', '/opt/wtm/cli.js', 'daemon', 'serve'],
      home: '/Users/test',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
    })).toThrow('executable must be absolute');
  });

  test('produces a plist accepted by the macOS property-list validator', async () => {
    const home = await fakeHome();
    const path = join(home, 'agent.plist');
    await writeFile(path, generateLaunchdPlist({
      label: launchdLabel,
      programArguments: ['/opt/wtm/bin/wtm', 'daemon', 'serve'],
      home,
      stdoutPath: join(home, 'daemon.log'),
      stderrPath: join(home, 'daemon.error.log'),
    }));

    const result = spawnSync('/usr/bin/plutil', ['-lint', '--', path], { encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});

describe('launchd commands', () => {
  test('uses modern per-user launchctl domain and service targets', () => {
    const commands = launchdCommands({ uid: 501, plistPath: '/Users/test/Library/LaunchAgents/dev.wtm.daemon.plist' });
    expect(commands).toEqual({
      print: ['/bin/launchctl', 'print', 'gui/501/dev.wtm.daemon'],
      printDomain: ['/bin/launchctl', 'print', 'gui/501'],
      enable: ['/bin/launchctl', 'enable', 'gui/501/dev.wtm.daemon'],
      bootstrap: ['/bin/launchctl', 'bootstrap', 'gui/501', '/Users/test/Library/LaunchAgents/dev.wtm.daemon.plist'],
      bootout: ['/bin/launchctl', 'bootout', 'gui/501/dev.wtm.daemon'],
      kickstart: ['/bin/launchctl', 'kickstart', '-k', 'gui/501/dev.wtm.daemon'],
    });
  });
});

describe('launchd lifecycle', () => {
  test('installs atomically below an isolated home without invoking a real user agent', async () => {
    const home = await fakeHome();
    const calls: string[][] = [];
    const lifecycle = createLaunchdLifecycle({
      home, uid: 501, platform: 'darwin',
      programArguments: ['/opt/node/bin/node', '/opt/wtm/cli.js', 'daemon', 'serve'],
      pathEnvironment: '/opt/node/bin:/usr/bin:/bin',
      commandRunner: async (argv) => {
        calls.push([...argv]);
        return argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon') ? missingService() : success();
      },
    });

    const result = await lifecycle.install();
    const paths = launchdPaths(home);

    expect(result).toEqual({ action: 'install', state: 'installed', label: launchdLabel, plistPath: paths.plistPath });
    expect(calls).toEqual([
      ['/bin/launchctl', 'print', 'gui/501/dev.wtm.daemon'],
      ['/bin/launchctl', 'print', 'gui/501'],
      ['/bin/launchctl', 'enable', 'gui/501/dev.wtm.daemon'],
      ['/bin/launchctl', 'bootstrap', 'gui/501', paths.plistPath],
    ]);
    expect((await readFile(paths.plistPath, 'utf8')).includes('<string>/opt/wtm/cli.js</string>')).toBe(true);
    expect((await lstat(paths.plistPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.dataRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.logRoot)).mode & 0o777).toBe(0o700);
    expect((await readdir(paths.agentsDirectory)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('reloads an already-loaded service through bootout then bootstrap', async () => {
    const home = await fakeHome();
    const calls: string[][] = [];
    let loaded = true;
    const lifecycle = createLaunchdLifecycle({
      home, uid: 502, platform: 'darwin',
      programArguments: ['/opt/node/bin/node', '/opt/wtm/cli.js', 'daemon', 'serve'],
      commandRunner: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'bootout') { loaded = false; return success(); }
        if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) return loaded ? success() : missingService();
        return success();
      },
    });

    const result = await lifecycle.install();

    expect(result.state).toBe('reinstalled');
    expect(calls.map((argv) => argv[1])).toEqual(['print', 'bootout', 'print', 'enable', 'bootstrap']);
  });

  test('restarts a loaded service so a newly installed executable is the one running', async () => {
    const home = await fakeHome();
    const options = {
      home, uid: 506, platform: 'darwin' as const,
      programArguments: ['/opt/node/bin/node', '/opt/wtm/cli.js', 'daemon', 'serve'],
      commandRunner: async (argv: readonly string[]) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
    };
    const initial = createLaunchdLifecycle(options);
    await initial.install();
    const path = launchdPaths(home).plistPath;
    const before = await lstat(path);
    const calls: string[][] = [];
    const repeated = createLaunchdLifecycle({
      ...options,
      commandRunner: async (argv) => { calls.push([...argv]); return success(); },
    });

    // The plist names the executable by path, so a new build leaves it byte-identical: the
    // definition must not be rewritten, and the service must still be restarted, or launchd
    // goes on running the binary that was installed before this one.
    expect((await repeated.install()).state).toBe('restarted');
    const after = await lstat(path);
    expect({ dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
      dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs,
    });
    expect(calls.map((argv) => argv[1])).toEqual(['print', 'enable', 'kickstart']);
    expect(calls.at(-1)).toEqual(['/bin/launchctl', 'kickstart', '-k', 'gui/506/dev.wtm.daemon']);
  });

  test('does not report an unrestarted service as installed', async () => {
    const home = await fakeHome();
    const options = {
      home, uid: 507, platform: 'darwin' as const,
      programArguments: ['/opt/node/bin/node', '/opt/wtm/cli.js', 'daemon', 'serve'],
      commandRunner: async (argv: readonly string[]) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
    };
    await createLaunchdLifecycle(options).install();
    const repeated = createLaunchdLifecycle({
      ...options,
      commandRunner: async (argv) => argv[1] === 'kickstart' ? failure(3, 'Could not kickstart') : success(),
    });

    await expect(repeated.install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'kickstart', exitCode: 3 },
    });
  });

  test('does not report an identical loaded definition as installed when enable fails', async () => {
    const home = await fakeHome();
    const options = {
      home, uid: 506, platform: 'darwin' as const,
      programArguments: ['/opt/node/bin/node', '/opt/wtm/cli.js', 'daemon', 'serve'],
      commandRunner: async (argv: readonly string[]) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
    };
    await createLaunchdLifecycle(options).install();
    const calls: string[] = [];
    const repeated = createLaunchdLifecycle({
      ...options,
      commandRunner: async (argv) => {
        calls.push(argv[1] as string);
        return argv[1] === 'enable' ? failure(5, 'persisted disabled override') : success();
      },
    });

    await expect(repeated.install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'enable', exitCode: 5 },
    });
    expect(calls).toEqual(['print', 'enable']);
  });

  test('treats a concurrent bootstrap winner as already installed', async () => {
    const home = await fakeHome();
    let prints = 0;
    const lifecycle = createLaunchdLifecycle({
      home, uid: 503, platform: 'darwin',
      programArguments: ['/opt/node/bin/node', '/opt/wtm/cli.js', 'daemon', 'serve'],
      commandRunner: async (argv) => {
        if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) return ++prints === 1 ? missingService() : success();
        if (argv[1] === 'bootstrap') return failure(5, 'Bootstrap failed: 5');
        return success();
      },
    });

    expect((await lifecycle.install()).state).toBe('already-installed');
  });

  test('restores the prior plist and loaded service when reinstallation fails after bootout', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'previous-definition', { mode: 0o600 });
    let loaded = true;
    let enables = 0;
    const calls: string[][] = [];
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'replacement'],
      commandRunner: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) return loaded ? success() : missingService();
        if (argv[1] === 'bootout') { loaded = false; return success(); }
        if (argv[1] === 'enable' && ++enables === 1) return failure(5, 'enable failed');
        if (argv[1] === 'bootstrap') { loaded = true; return success(); }
        return success();
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'enable', exitCode: 5 },
    });
    expect(await readFile(paths.plistPath, 'utf8')).toBe('previous-definition');
    expect(loaded).toBe(true);
    expect(calls.map((argv) => argv[1])).toEqual([
      'print', 'bootout', 'print', 'enable', 'enable', 'bootstrap',
    ]);
  });

  for (const failedOperation of ['enable', 'bootstrap'] as const) {
    test(`preserves a concurrent winner instead of clobbering it during ${failedOperation} rollback`, async () => {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(paths.plistPath, 'previous-definition', { mode: 0o600 });
      let loaded = true;
      let firstEnable = true;
      const replaceWithWinner = async () => {
        await rm(paths.plistPath);
        await writeFile(paths.plistPath, `concurrent-winner-${failedOperation}`, { mode: 0o600 });
      };
      const lifecycle = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'replacement'],
        commandRunner: async (argv) => {
          if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) return loaded ? success() : missingService();
          if (argv[1] === 'bootout') { loaded = false; return success(); }
          if (argv[1] === 'enable') {
            if (firstEnable) {
              firstEnable = false;
              if (failedOperation === 'enable') {
                await replaceWithWinner();
                return failure(5, 'enable failed');
              }
            }
            return success();
          }
          if (argv[1] === 'bootstrap') {
            await replaceWithWinner();
            return failure(5, 'bootstrap failed');
          }
          return success();
        },
      });

      await expect(lifecycle.install()).rejects.toMatchObject({
        code: 'LAUNCHD_ROLLBACK_CONFLICT',
        context: { operation: failedOperation, rollback: 'conflict' },
      });
      expect(await readFile(paths.plistPath, 'utf8')).toBe(`concurrent-winner-${failedOperation}`);
    });
  }

  test('restores the prior loaded job when the post-bootout absence probe fails', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'previous-definition', { mode: 0o600 });
    let loaded = true;
    let servicePrints = 0;
    const calls: string[] = [];
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'replacement'],
      commandRunner: async (argv) => {
        calls.push(argv[1] as string);
        if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) {
          servicePrints += 1;
          return servicePrints === 1 ? success() : failure(5, 'probe failed');
        }
        if (argv[1] === 'bootout') { loaded = false; return success(); }
        if (argv[1] === 'bootstrap') { loaded = true; return success(); }
        return success();
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'print', exitCode: 5 },
    });
    expect(await readFile(paths.plistPath, 'utf8')).toBe('previous-definition');
    expect(loaded).toBe(true);
    expect(calls).toEqual(['print', 'bootout', 'print', 'enable', 'bootstrap']);
  });

  test('restores the prior loaded job when the post-bootout absence probe times out', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'previous-definition', { mode: 0o600 });
    let loaded = true;
    const calls: string[] = [];
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', absencePollAttempts: 2,
      programArguments: ['/bin/echo', 'replacement'],
      commandRunner: async (argv) => {
        calls.push(argv[1] as string);
        if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) return success();
        if (argv[1] === 'bootout') { loaded = false; return success(); }
        if (argv[1] === 'bootstrap') { loaded = true; return success(); }
        return success();
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'bootout', attempts: 2 },
    });
    expect(await readFile(paths.plistPath, 'utf8')).toBe('previous-definition');
    expect(loaded).toBe(true);
    expect(calls).toEqual(['print', 'bootout', 'print', 'print', 'enable', 'bootstrap']);
  });

  test('reports loaded, installed-not-loaded, and absent states without mutation', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'safe', { mode: 0o600 });
    const loaded = createLaunchdLifecycle({
      home, uid: 504, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async () => success(),
    });
    expect((await loaded.status()).state).toBe('loaded');

    const notLoaded = createLaunchdLifecycle({
      home, uid: 504, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[2]?.includes('/dev.wtm.daemon') ? missingService() : success(),
    });
    expect((await notLoaded.status()).state).toBe('installed-not-loaded');
    await rm(paths.plistPath);
    expect((await notLoaded.status()).state).toBe('absent');
  });

  test('never infers service absence from human launchctl output', async () => {
    const home = await fakeHome();
    const calls: string[] = [];
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => {
        calls.push(argv[1] as string);
        return failure(1, 'service not found');
      },
    });

    await expect(lifecycle.status()).rejects.toMatchObject({
      code: 'LAUNCHD_COMMAND_FAILED', context: { operation: 'print', exitCode: 1 },
    });
    expect(calls).toEqual(['print']);
  });

  test('uninstalls loaded and absent services idempotently', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'safe', { mode: 0o600 });
    let loaded = true;
    const calls: string[][] = [];
    const lifecycle = createLaunchdLifecycle({
      home, uid: 505, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) return loaded ? success() : missingService();
        if (argv[1] === 'bootout') { loaded = false; return success(); }
        return success();
      },
    });

    expect((await lifecycle.uninstall()).state).toBe('uninstalled');
    expect((await lifecycle.uninstall()).state).toBe('already-absent');
    expect(calls.map((argv) => argv[1])).toEqual(['print', 'bootout', 'print', 'print', 'print']);
  });

  test('does not remove a plist replaced after uninstall inspection', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'original', { mode: 0o600 });
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
      removalHook: async () => {
        await rm(paths.plistPath);
        await writeFile(paths.plistPath, 'replacement', { mode: 0o600 });
      },
    });

    await expect(lifecycle.uninstall()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(paths.plistPath, 'utf8')).toBe('replacement');
  });

  test('preserves a concurrent winner created at the final uninstall mutation boundary', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'original', { mode: 0o600 });
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
      removalHook: async (phase) => {
        if (phase !== 'before-quarantine') return;
        await rm(paths.plistPath);
        await writeFile(paths.plistPath, 'concurrent-winner', { mode: 0o600 });
      },
    });

    await expect(lifecycle.uninstall()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(paths.plistPath, 'utf8')).toBe('concurrent-winner');
  });

  test('preserves both trees when the LaunchAgents parent changes at the final removal boundary', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'original', { mode: 0o600 });
    const movedParent = `${paths.agentsDirectory}.moved`;
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
      removalHook: async (phase) => {
        if (phase !== 'before-quarantine') return;
        await rename(paths.agentsDirectory, movedParent);
        await mkdir(paths.agentsDirectory, { mode: 0o700 });
        await writeFile(paths.plistPath, 'new-parent-winner', { mode: 0o600 });
      },
    });

    await expect(lifecycle.uninstall()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(join(movedParent, `${launchdLabel}.plist`), 'utf8')).toBe('original');
    expect(await readFile(paths.plistPath, 'utf8')).toBe('new-parent-winner');
  });

  test('rejects symlinked directories and plist targets without touching their destinations', async () => {
    const home = await fakeHome();
    const outside = await fakeHome();
    await mkdir(join(home, 'Library'), { mode: 0o700 });
    await symlink(outside, join(home, 'Library', 'LaunchAgents'));
    const lifecycle = createLaunchdLifecycle({
      home, uid: process.getuid?.() ?? 0, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async () => { throw new Error('runner must not be called'); },
    });
    await expect(lifecycle.install()).rejects.toBeInstanceOf(LaunchdLifecycleError);
    expect(await readdir(outside)).toEqual([]);

    await rm(join(home, 'Library', 'LaunchAgents'));
    await mkdir(join(home, 'Library', 'LaunchAgents'), { mode: 0o700 });
    const destination = join(outside, 'destination');
    await writeFile(destination, 'preserve', { mode: 0o600 });
    await symlink(destination, launchdPaths(home).plistPath);
    await expect(lifecycle.install()).rejects.toBeInstanceOf(LaunchdLifecycleError);
    expect(await readFile(destination, 'utf8')).toBe('preserve');
  });

  test('rejects group-writable launch directories before publishing', async () => {
    const home = await fakeHome();
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 });
    await chmod(join(home, 'Library', 'LaunchAgents'), 0o770);
    const lifecycle = createLaunchdLifecycle({
      home, uid: process.getuid?.() ?? 0, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async () => { throw new Error('runner must not be called'); },
    });
    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
  });

  test('rejects a hardlinked plist target', async () => {
    const home = await fakeHome();
    const outside = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    const source = join(outside, 'source');
    await writeFile(source, 'preserve', { mode: 0o600 });
    await link(source, paths.plistPath);
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async () => { throw new Error('runner must not be called'); },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(source, 'utf8')).toBe('preserve');
  });

  test('rejects parent replacement and concurrent target creation without overwriting either target', async () => {
    const parentSwapHome = await fakeHome();
    const parentPaths = launchdPaths(parentSwapHome);
    let movedParent = '';
    const parentSwap = createLaunchdLifecycle({
      home: parentSwapHome, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[2]?.includes('/dev.wtm.daemon') ? missingService() : success(),
      publicationHook: async () => {
        movedParent = `${parentPaths.agentsDirectory}.moved`;
        await rename(parentPaths.agentsDirectory, movedParent);
        await mkdir(parentPaths.agentsDirectory, { mode: 0o700 });
      },
    });
    await expect(parentSwap.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readdir(parentPaths.agentsDirectory)).toEqual([]);
    expect((await readdir(movedParent)).some((name) => name === `${launchdLabel}.plist`)).toBe(false);

    const concurrentHome = await fakeHome();
    const concurrentPaths = launchdPaths(concurrentHome);
    const concurrent = createLaunchdLifecycle({
      home: concurrentHome, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[2]?.includes('/dev.wtm.daemon') ? missingService() : success(),
      publicationHook: async () => { await writeFile(concurrentPaths.plistPath, 'concurrent', { mode: 0o600 }); },
    });
    await expect(concurrent.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(concurrentPaths.plistPath, 'utf8')).toBe('concurrent');
  });

  test('uses atomic no-replace publication when a target appears at the final link boundary', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
      publicationHook: async (phase) => {
        if (phase === 'before-link') await writeFile(paths.plistPath, 'concurrent-winner', { mode: 0o600 });
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(paths.plistPath, 'utf8')).toBe('concurrent-winner');
  });

  test('preserves a replacement target created at the final changed-definition boundary', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'replacement'],
      commandRunner: async (argv) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
      publicationHook: async (phase) => {
        if (phase !== 'before-replace-move') return;
        await rm(paths.plistPath);
        await writeFile(paths.plistPath, 'concurrent-winner', { mode: 0o600 });
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(paths.plistPath, 'utf8')).toBe('concurrent-winner');
  });

  test('serializes cooperative installs with atomic owner metadata below the mode-0700 directory', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    let loaded = false;
    let servicePrints = 0;
    let releaseFirst!: () => void;
    let reachedFirst!: () => void;
    const firstGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });
    const firstReached = new Promise<void>((resolvePromise) => { reachedFirst = resolvePromise; });
    const runner = async (argv: readonly string[]): Promise<LaunchdCommandResult> => {
      if (argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')) {
        servicePrints += 1;
        return loaded ? success() : missingService();
      }
      if (argv[1] === 'bootout') { loaded = false; return success(); }
      if (argv[1] === 'bootstrap') { loaded = true; return success(); }
      return success();
    };
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'first'], commandRunner: runner,
      publicationHook: async (phase) => {
        if (phase !== 'before-link') return;
        const [lockName] = (await readdir(paths.agentsDirectory)).filter((name) => name.endsWith('operation-lock'));
        if (lockName === undefined) throw new Error('operation lock was not published');
        const lockStat = await lstat(join(paths.agentsDirectory, lockName));
        expect(lockStat.isFile()).toBe(true);
        expect(lockStat.uid).toBe(process.getuid?.() ?? 0);
        expect(lockStat.mode & 0o777).toBe(0o600);
        reachedFirst();
        await firstGate;
      },
    });
    const second = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'second'], commandRunner: runner,
    });

    const firstInstall = first.install();
    await firstReached;
    const secondInstall = second.install();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(servicePrints).toBe(1);
    releaseFirst();
    expect((await firstInstall).state).toBe('installed');
    expect((await secondInstall).state).toBe('reinstalled');
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>second</string>');
    expect((await readdir(paths.agentsDirectory)).some((name) => name.endsWith('operation-lock'))).toBe(false);
  });

  test('keeps a live or unknown owner busy and reclaims an exact dead or PID-reused owner', async () => {
    for (const state of ['live', 'unknown'] as const) {
      const home = await fakeHome();
      const owner = inspector('current-start', state, 'current-start');
      const interrupted = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'], processInspector: owner,
        commandRunner: absentRunner,
        transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
      });
      await expect(interrupted.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const contender = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'],
        processInspector: inspector('contender-start', state, 'current-start'),
        commandRunner: absentRunner, lockPollAttempts: 1,
      });
      await expect(contender.install()).rejects.toMatchObject({ code: 'LAUNCHD_OPERATION_BUSY' });
    }

    for (const [state, observedStart] of [['dead', null], ['live', 'reused-start']] as const) {
      const home = await fakeHome();
      const interrupted = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'],
        processInspector: inspector('old-start', 'live', 'old-start'), commandRunner: absentRunner,
        transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
      });
      await expect(interrupted.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const recovered = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'],
        processInspector: inspector('new-start', state, observedStart), commandRunner: absentRunner,
        lockPollAttempts: 1,
      });
      expect((await recovered.install()).state).toBe('installed');
    }
  });

  test('recovers the atomic owner hard-link prefix without accepting forged extra links', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-linked' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId: string };
    const candidate = `${lockPath}.owner-${owner.transactionId}`;
    expect((await lstat(lockPath)).nlink).toBe(2);
    expect((await lstat(candidate)).ino).toBe((await lstat(lockPath)).ino);

    const live = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('new-start', 'live', 'old-start'), lockPollAttempts: 1,
    });
    await expect(live.install()).rejects.toMatchObject({ code: 'LAUNCHD_OPERATION_BUSY' });
    expect((await lstat(lockPath)).nlink).toBe(2);

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect((await recovered.install()).state).toBe('installed');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('fails closed when the owner hard-link candidate is missing or renamed', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-linked' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId: string };
    const candidate = `${lockPath}.owner-${owner.transactionId}`;
    const forged = `${lockPath}.owner-forged`;
    await rename(candidate, forged);
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
    });
    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect((await lstat(lockPath)).nlink).toBe(2);
    expect((await lstat(forged)).ino).toBe((await lstat(lockPath)).ino);
  });

  test('publishes the successor owner with bounded predecessor lineage before recovery', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const firstOwner = JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId: string };
    const takeover = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => phase === 'stale-lock-moved' ? 'interrupt' : 'continue',
    });
    await expect(takeover.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const successorOwner = JSON.parse(await readFile(lockPath, 'utf8')) as {
      transactionId: string;
      predecessorTransactionIds: string[];
    };
    expect(successorOwner.predecessorTransactionIds).toEqual([firstOwner.transactionId]);
    expect((await readdir(paths.agentsDirectory)).some((name) => name === `.${launchdLabel}.takeover`)).toBe(false);
    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('third-start', 'dead', null), lockPollAttempts: 1,
    });
    await recovered.install();
    await recovered.install();
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
    expect((await lstat(paths.plistPath)).nlink).toBe(1);
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('recovers the stale journal when an obsolete takeover record was linked before its owner move', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
      version: 1;
      pid: number;
      startIdentity: string;
      transactionId: string;
    };
    const lockStat = await lstat(lockPath);
    const successorTransactionId = crypto.randomUUID();
    const takeoverPath = join(paths.agentsDirectory, `.${launchdLabel}.takeover`);
    const obsoleteRecord = `${JSON.stringify({
      version: 1,
      successorTransactionId,
      staleBasename: `.${launchdLabel}.operation-lock.stale-${successorTransactionId}`,
      owner,
      identity: {
        dev: Number(lockStat.dev), ino: Number(lockStat.ino), uid: lockStat.uid,
        mode: Number(lockStat.mode), nlink: Number(lockStat.nlink),
      },
    })}\n`;
    await writeFile(takeoverPath, obsoleteRecord, { mode: 0o600 });

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect(await readFile(takeoverPath, 'utf8')).toBe(obsoleteRecord);
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
  });

  test('allows only the exact successor owner to recover and mutate when two contenders race takeover', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });

    let releaseLoser!: () => void;
    let reachedLoser!: () => void;
    const loserGate = new Promise<void>((resolvePromise) => { releaseLoser = resolvePromise; });
    const loserReached = new Promise<void>((resolvePromise) => { reachedLoser = resolvePromise; });
    let bootstrapCalls = 0;
    const runner = async (argv: readonly string[]): Promise<LaunchdCommandResult> => {
      if (argv[1] === 'bootstrap') bootstrapCalls += 1;
      return await absentRunner(argv);
    };
    const loser = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: runner,
      processInspector: inspector('loser-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase !== 'stale-lock-moved') return 'continue';
        reachedLoser();
        await loserGate;
        return 'continue' as const;
      },
    });
    const winner = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: runner,
      processInspector: inspector('winner-start', 'dead', null), lockPollAttempts: 1,
    });

    const loserInstall = loser.install();
    await loserReached;
    const separateTakeoverRecordPublished = (await readdir(paths.agentsDirectory))
      .includes(`.${launchdLabel}.takeover`);
    expect((await winner.install()).state).toBe('installed');
    releaseLoser();
    await expect(loserInstall).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(bootstrapCalls).toBe(1);
    expect(separateTakeoverRecordPublished).toBe(false);
  });

  test('elects one successor before either contender may replace the observed stale owner', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });

    let releaseFirstClaim!: () => void;
    let releaseSecondClaim!: () => void;
    let releaseFirstOwner!: () => void;
    let firstClaimReached!: () => void;
    let secondClaimReached!: () => void;
    let firstOwnerReached!: () => void;
    const firstClaimGate = new Promise<void>((resolvePromise) => { releaseFirstClaim = resolvePromise; });
    const secondClaimGate = new Promise<void>((resolvePromise) => { releaseSecondClaim = resolvePromise; });
    const firstOwnerGate = new Promise<void>((resolvePromise) => { releaseFirstOwner = resolvePromise; });
    const firstAtClaim = new Promise<void>((resolvePromise) => { firstClaimReached = resolvePromise; });
    const secondAtClaim = new Promise<void>((resolvePromise) => { secondClaimReached = resolvePromise; });
    const firstAtOwner = new Promise<void>((resolvePromise) => { firstOwnerReached = resolvePromise; });
    let bootstrapCalls = 0;
    const runner = async (argv: readonly string[]): Promise<LaunchdCommandResult> => {
      if (argv[1] === 'bootstrap') bootstrapCalls += 1;
      return await absentRunner(argv);
    };
    const firstContender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: runner,
      processInspector: inspector('first-contender', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase === 'before-stale-lock-claim') {
          firstClaimReached();
          await firstClaimGate;
        }
        if (phase === 'stale-lock-moved') {
          firstOwnerReached();
          await firstOwnerGate;
        }
        return 'continue' as const;
      },
    });
    const secondContender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: runner,
      processInspector: inspector('second-contender', 'live', 'first-contender'), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase === 'before-stale-lock-claim') {
          secondClaimReached();
          await secondClaimGate;
        }
        return 'continue' as const;
      },
    });

    const firstInstall = firstContender.install();
    const secondInstall = secondContender.install();
    await Promise.all([firstAtClaim, secondAtClaim]);
    releaseFirstClaim();
    await firstAtOwner;
    releaseSecondClaim();
    const secondError = await secondInstall.then(() => null, (error: unknown) => error as { code?: string });
    expect(secondError?.code === 'LAUNCHD_OPERATION_BUSY' || secondError?.code === 'UNSAFE_LAUNCHD_PATH').toBe(true);
    releaseFirstOwner();
    expect((await firstInstall).state).toBe('installed');
    expect(bootstrapCalls).toBe(1);
  });

  for (const takeoverPhase of ['takeover-claim-linked', 'takeover-claim-owned'] as const) {
    test(`recovers an interrupted successor claim at ${takeoverPhase}`, async () => {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
      const first = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector('old-start', 'live', 'old-start'),
        transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
      });
      await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const claimCrash = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector('claim-start', 'dead', null), lockPollAttempts: 1,
        transactionHook: async (phase) => phase === takeoverPhase ? 'interrupt' : 'continue',
      });
      await expect(claimCrash.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const recovered = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector('recovery-start', 'dead', null), lockPollAttempts: 1,
      });
      expect((await recovered.install()).state).toBe('installed');
      expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
      expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
    });
  }

  test('does not replace the stale owner from a successor candidate swapped after claim validation', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const predecessorContent = await readFile(lockPath, 'utf8');
    let swappedCandidate = '';
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase !== 'takeover-claim-owned') return 'continue' as const;
        const candidate = (await readdir(paths.agentsDirectory)).find((name) => name.includes('.operation-lock.owner-'));
        if (candidate === undefined) throw new Error('successor candidate is missing');
        swappedCandidate = join(paths.agentsDirectory, candidate);
        await rm(swappedCandidate);
        await writeFile(swappedCandidate, 'foreign-candidate', { mode: 0o600 });
        return 'continue' as const;
      },
    });

    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(lockPath, 'utf8')).toBe(predecessorContent);
    expect(await readFile(swappedCandidate, 'utf8')).toBe('foreign-candidate');
  });

  test('rebinds the successor candidate last when it changes during predecessor validation', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const predecessorContent = await readFile(lockPath, 'utf8');
    let armed = false;
    let swappedCandidate = '';
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase === 'takeover-claim-owned') armed = true;
        return 'continue' as const;
      },
      metadataReadHook: async (path) => {
        if (!armed || path !== lockPath) return;
        armed = false;
        const candidate = (await readdir(paths.agentsDirectory)).find((name) => name.includes('.operation-lock.owner-'));
        if (candidate === undefined) throw new Error('successor candidate is missing');
        swappedCandidate = join(paths.agentsDirectory, candidate);
        await rm(swappedCandidate);
        await writeFile(swappedCandidate, 'foreign-late-candidate', { mode: 0o600 });
      },
    });

    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(lockPath, 'utf8')).toBe(predecessorContent);
    expect(await readFile(swappedCandidate, 'utf8')).toBe('foreign-late-candidate');
  });

  test('rebinds a successor candidate before publishing its claim hard link', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const predecessorContent = await readFile(lockPath, 'utf8');
    let swappedCandidate = '';
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase !== 'before-stale-lock-claim') return 'continue' as const;
        const candidate = (await readdir(paths.agentsDirectory)).find((name) => name.includes('.operation-lock.owner-'));
        if (candidate === undefined) throw new Error('successor candidate is missing');
        swappedCandidate = join(paths.agentsDirectory, candidate);
        await rm(swappedCandidate);
        await writeFile(swappedCandidate, 'foreign-pre-claim', { mode: 0o600 });
        return 'continue' as const;
      },
    });

    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(lockPath, 'utf8')).toBe(predecessorContent);
    expect(await readFile(swappedCandidate, 'utf8')).toBe('foreign-pre-claim');
    expect((await readdir(paths.agentsDirectory)).some((name) => name.includes('.operation-lock.successor-'))).toBe(false);
  });

  test('does not recover a successor claim from a candidate swapped at the move boundary', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const predecessorContent = await readFile(lockPath, 'utf8');
    const claimCrash = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('claim-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => phase === 'takeover-claim-linked' ? 'interrupt' : 'continue',
    });
    await expect(claimCrash.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    let swappedCandidate = '';
    const recovery = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('recovery-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase !== 'before-claim-recovery-move') return 'continue' as const;
        const candidate = (await readdir(paths.agentsDirectory)).find((name) => name.includes('.operation-lock.owner-'));
        if (candidate === undefined) throw new Error('claim candidate is missing');
        swappedCandidate = join(paths.agentsDirectory, candidate);
        await rm(swappedCandidate);
        await writeFile(swappedCandidate, 'foreign-recovery-candidate', { mode: 0o600 });
        return 'continue' as const;
      },
    });

    await expect(recovery.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(lockPath, 'utf8')).toBe(predecessorContent);
    expect(await readFile(swappedCandidate, 'utf8')).toBe('foreign-recovery-candidate');
  });

  test('rebinds a recovered claim candidate last after predecessor validation', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const predecessorContent = await readFile(lockPath, 'utf8');
    const claimCrash = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('claim-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => phase === 'takeover-claim-linked' ? 'interrupt' : 'continue',
    });
    await expect(claimCrash.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    let armed = false;
    let swappedCandidate = '';
    const recovery = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('recovery-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase === 'before-claim-recovery-move') armed = true;
        return 'continue' as const;
      },
      metadataReadHook: async (path) => {
        if (!armed || path !== lockPath) return;
        armed = false;
        const candidate = (await readdir(paths.agentsDirectory)).find((name) => name.includes('.operation-lock.owner-'));
        if (candidate === undefined) throw new Error('claim candidate is missing');
        swappedCandidate = join(paths.agentsDirectory, candidate);
        await rm(swappedCandidate);
        await writeFile(swappedCandidate, 'foreign-late-recovery', { mode: 0o600 });
      },
    });

    await expect(recovery.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(lockPath, 'utf8')).toBe(predecessorContent);
    expect(await readFile(swappedCandidate, 'utf8')).toBe('foreign-late-recovery');
  });

  test('inherits a repeated takeover chain so the last owner can recover the original journal', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const firstOwner = JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId: string };

    const second = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => phase === 'stale-lock-moved' ? 'interrupt' : 'continue',
    });
    await expect(second.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const secondOwner = JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId: string };

    const third = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('third-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => phase === 'stale-lock-moved' ? 'interrupt' : 'continue',
    });
    await expect(third.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const thirdOwner = JSON.parse(await readFile(lockPath, 'utf8')) as { predecessorTransactionIds: string[] };
    expect(thirdOwner.predecessorTransactionIds).toEqual([secondOwner.transactionId, firstOwner.transactionId]);

    const fourth = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('fourth-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await fourth.install()).state).toBe('installed');
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
  });

  test('keeps the active journal owner while bounding more than eight repeated takeovers', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('owner-0', 'live', 'owner-0'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const journalOwner = (JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId: string }).transactionId;

    for (let index = 1; index <= 9; index += 1) {
      const takeover = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector(`owner-${index}`, 'dead', null), lockPollAttempts: 1,
        transactionHook: async (phase) => phase === 'stale-lock-moved' ? 'interrupt' : 'continue',
      });
      await expect(takeover.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    }
    const boundedOwner = JSON.parse(await readFile(lockPath, 'utf8')) as { predecessorTransactionIds: string[] };
    expect(boundedOwner.predecessorTransactionIds.length).toBeLessThanOrEqual(8);
    expect(boundedOwner.predecessorTransactionIds).toContain(journalOwner);

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('owner-final', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
  });

  test('rejects cyclic, duplicate, overlong, and forged predecessor transaction IDs', async () => {
    for (const invalidPredecessors of [
      (transactionId: string) => [transactionId],
      () => { const duplicate = crypto.randomUUID(); return [duplicate, duplicate]; },
      () => Array.from({ length: 9 }, () => crypto.randomUUID()),
      () => ['not-a-transaction-id'],
      () => null,
    ]) {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      const crashed = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
        processInspector: inspector('old-start', 'live', 'old-start'),
        transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
      });
      await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown> & { transactionId: string };
      owner.predecessorTransactionIds = invalidPredecessors(owner.transactionId);
      await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      let runnerCalled = false;
      const contender = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'], lockPollAttempts: 1,
        processInspector: inspector('new-start', 'dead', null),
        commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
      });
      await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
      expect(runnerCalled).toBe(false);
    }
  });

  test('stabilizes a crash during quarantine restore on the next recovery attempt', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'old-quarantined' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const second = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => phase === 'restore-linked' ? 'interrupt' : 'continue',
    });
    await expect(second.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const third = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('third-start', 'dead', null), lockPollAttempts: 1,
    });
    await third.install();
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
    expect((await lstat(paths.plistPath)).nlink).toBe(1);
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  for (const rollbackPhase of ['temporary-created', 'old-quarantined', 'new-linked', 'temporary-unlinked'] as const) {
    test(`recovers a crash during rollback publication at ${rollbackPhase}`, async () => {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
      let enableCalls = 0;
      let phaseCalls = 0;
      const crashed = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'],
        processInspector: inspector('first-start', 'live', 'first-start'),
        commandRunner: async (argv) => argv[1] === 'enable' && ++enableCalls === 1
          ? failure(5, 'enable failed') : await absentRunner(argv),
        transactionHook: async (phase) => {
          if (phase !== rollbackPhase) return 'continue';
          phaseCalls += 1;
          return phaseCalls === 2 ? 'interrupt' : 'continue';
        },
      });
      await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const journal = JSON.parse(await readFile(join(paths.agentsDirectory, `.${launchdLabel}.transaction`), 'utf8')) as {
        failure: { operation: string; exitCode: number };
      };
      expect(journal.failure).toMatchObject({ operation: 'enable', exitCode: 5 });
      const recovered = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      });
      await recovered.install();
      expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
      expect((await lstat(paths.plistPath)).nlink).toBe(1);
      expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
    });
  }

  test('recovers rollback temp creation from durable pre-intent, including a crash while adopting it', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    let enableCalls = 0;
    let temporaryWrites = 0;
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'],
      processInspector: inspector('first-start', 'live', 'first-start'),
      commandRunner: async (argv) => argv[1] === 'enable' && ++enableCalls === 1
        ? failure(5, 'enable failed') : await absentRunner(argv),
      transactionHook: async (phase) => {
        if ((phase as string) !== 'temporary-written') return 'continue';
        temporaryWrites += 1;
        return temporaryWrites === 2 ? 'interrupt' : 'continue';
      },
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const journalPath = join(paths.agentsDirectory, `.${launchdLabel}.transaction`);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      phase: string;
      temporary: string;
      replacement: unknown;
      expected: { byteLength: number; sha256: string };
    };
    expect(journal).toMatchObject({
      phase: 'preparing',
      replacement: null,
      expected: {
        byteLength: 14,
        sha256: '20ca9b7ca18d45e594d28ae9793c8f443dd71796a3f5850bb2ba8324be9eaa65',
      },
    });
    expect(JSON.stringify(journal)).not.toContain('old-definition');
    expect(await readFile(join(paths.agentsDirectory, journal.temporary), 'utf8')).toBe('old-definition');

    const adoptionCrash = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => (phase as string) === 'temporary-adopted' ? 'interrupt' : 'continue',
    });
    await expect(adoptionCrash.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('third-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
    expect((await lstat(paths.plistPath)).nlink).toBe(1);
  });

  test('normalizes a publish pre-intent crash before temporary creation', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'publish-prepared' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const journal = JSON.parse(await readFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
      'utf8',
    )) as { phase: string; temporary: string };
    expect(journal.phase).toBe('preparing');
    expect((await readdir(paths.agentsDirectory)).includes(journal.temporary)).toBe(false);

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
  });

  test('fails closed and preserves a pre-intent temporary whose bytes do not match its digest', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'temporary-written' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const journal = JSON.parse(await readFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
      'utf8',
    )) as { temporary: string };
    const temporaryPath = join(paths.agentsDirectory, journal.temporary);
    await writeFile(temporaryPath, 'forged-content', { mode: 0o600 });
    let runnerCalled = false;
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('second-start', 'dead', null),
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
    });
    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(runnerCalled).toBe(false);
    expect(await readFile(temporaryPath, 'utf8')).toBe('forged-content');
  });

  test('preserves a foreign deterministic temp that appears after publish pre-intent', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    let foreignTemporary = '';
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      transactionHook: async (phase) => {
        if (phase !== 'publish-prepared') return 'continue' as const;
        const journal = JSON.parse(await readFile(
          join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
          'utf8',
        )) as { temporary: string };
        foreignTemporary = join(paths.agentsDirectory, journal.temporary);
        await writeFile(foreignTemporary, 'foreign-temp', { mode: 0o600 });
        return 'continue' as const;
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(foreignTemporary, 'utf8')).toBe('foreign-temp');
  });

  test('recovers a durable predecessor journal temp left before its fixed-journal rename', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const orphan = await leaveDurableJournalTemporary(home, 'first-start', 'live', 'first-start');
    expect((await readdir(paths.agentsDirectory)).includes(orphan.basename)).toBe(true);

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('recovers every durable journal temp in a bounded predecessor lineage', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const transactionIds: string[] = [];
    for (const [index, phase] of ['lock-owned', 'stale-lock-moved', 'stale-lock-moved'].entries()) {
      const crashed = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector(`owner-${index}`, index === 0 ? 'live' : 'dead', index === 0 ? 'owner-0' : null),
        lockPollAttempts: 1,
        transactionHook: async (currentPhase) => currentPhase === phase ? 'interrupt' : 'continue',
      });
      await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      transactionIds.push((JSON.parse(await readFile(
        join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`),
        'utf8',
      )) as { transactionId: string }).transactionId);
    }
    for (const transactionId of transactionIds) {
      await writeFile(
        join(paths.agentsDirectory, `.${launchdLabel}.transaction.tmp-${transactionId}`),
        preparingJournalContent(transactionId),
        { mode: 0o600 },
      );
    }

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('owner-final', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('fails closed before takeover when eight pending temps also require the immediate predecessor', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const transactionIds: string[] = [];
    transactionIds.push((await leaveInterruptedLockOwner(home, 'owner-0', 'live', 'owner-0', 'lock-owned')).transactionId);
    for (let index = 1; index <= 8; index += 1) {
      transactionIds.push((await leaveInterruptedLockOwner(
        home,
        `owner-${index}`,
        'dead',
        null,
        'stale-lock-moved',
      )).transactionId);
    }
    for (const transactionId of transactionIds.slice(0, -1)) {
      await writeFile(
        join(paths.agentsDirectory, `.${launchdLabel}.transaction.tmp-${transactionId}`),
        preparingJournalContent(transactionId),
        { mode: 0o600 },
      );
    }
    let publishedSuccessor = false;
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('owner-final', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => {
        if (phase === 'stale-lock-moved') publishedSuccessor = true;
        return phase === 'stale-lock-moved' ? 'interrupt' : 'continue';
      },
    });
    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(publishedSuccessor).toBe(false);
    expect((JSON.parse(await readFile(
      join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`),
      'utf8',
    )) as { transactionId: string }).transactionId).toBe(transactionIds.at(-1) as string);
    expect((await readdir(paths.agentsDirectory)).filter((name) => name.includes('.transaction.tmp-')).length).toBe(8);
  });

  test('removes an exact predecessor journal temp when the same snapshot is already fixed', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const owner = await leaveInterruptedLockOwner(home, 'first-start', 'live', 'first-start', 'lock-owned');
    const content = preparingJournalContent(owner.transactionId);
    await writeFile(join(paths.agentsDirectory, `.${launchdLabel}.transaction`), content, { mode: 0o600 });
    await writeFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction.tmp-${owner.transactionId}`),
      content,
      { mode: 0o600 },
    );

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('recovers an authorized fixed journal before adopting another predecessor temp', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const firstOwner = await leaveInterruptedLockOwner(home, 'owner-a', 'live', 'owner-a', 'lock-owned');
    const secondOwner = await leaveInterruptedLockOwner(home, 'owner-b', 'dead', null, 'stale-lock-moved');
    await writeFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction.tmp-${firstOwner.transactionId}`),
      preparingJournalContent(firstOwner.transactionId),
      { mode: 0o600 },
    );
    await writeFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
      preparingJournalContent(secondOwner.transactionId),
      { mode: 0o600 },
    );

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('owner-c', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('fails closed and preserves a swapped predecessor journal temp before runner calls', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const owner = await leaveInterruptedLockOwner(home, 'first-start', 'live', 'first-start', 'lock-owned');
    const temporary = join(paths.agentsDirectory, `.${launchdLabel}.transaction.tmp-${owner.transactionId}`);
    await writeFile(temporary, preparingJournalContent(owner.transactionId), { mode: 0o600 });
    await rm(temporary);
    await writeFile(temporary, 'foreign-journal-temporary', { mode: 0o600 });
    let runnerCalled = false;

    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('second-start', 'dead', null),
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
    });
    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(runnerCalled).toBe(false);
    expect(await readFile(temporary, 'utf8')).toBe('foreign-journal-temporary');
  });

  test('retries a crash after predecessor journal-temp adoption', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const owner = await leaveInterruptedLockOwner(home, 'first-start', 'live', 'first-start', 'lock-owned');
    await writeFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction.tmp-${owner.transactionId}`),
      preparingJournalContent(owner.transactionId),
      { mode: 0o600 },
    );
    const adoptionCrash = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => (phase as string) === 'journal-temporary-adopted' ? 'interrupt' : 'continue',
    });
    await expect(adoptionCrash.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('third-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('recovers a predecessor journal after a successor crashes while publishing its recovery snapshot', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const first = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'temporary-written' ? 'interrupt' : 'continue',
    });
    await expect(first.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });

    const journalPath = join(paths.agentsDirectory, `.${launchdLabel}.transaction`);
    let interruptedRecoveryTemporary = '';
    const second = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      metadataReadHook: async (path) => {
        if (!path.startsWith(`${journalPath}.tmp-`) || interruptedRecoveryTemporary !== '') return;
        interruptedRecoveryTemporary = path;
        throw new Error('simulated recovery snapshot crash');
      },
    });
    await expect(second.install()).rejects.toThrow('simulated recovery snapshot crash');
    expect(interruptedRecoveryTemporary).not.toBe('');

    const third = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('third-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await third.install()).state).toBe('installed');
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('retries a crash after removing a duplicate predecessor journal temp', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const owner = await leaveInterruptedLockOwner(home, 'first-start', 'live', 'first-start', 'lock-owned');
    const content = preparingJournalContent(owner.transactionId);
    await writeFile(join(paths.agentsDirectory, `.${launchdLabel}.transaction`), content, { mode: 0o600 });
    await writeFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction.tmp-${owner.transactionId}`),
      content,
      { mode: 0o600 },
    );
    const removalCrash = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
      transactionHook: async (phase) => (phase as string) === 'journal-temporary-removed' ? 'interrupt' : 'continue',
    });
    await expect(removalCrash.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });

    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('third-start', 'dead', null), lockPollAttempts: 1,
    });
    expect((await recovered.install()).state).toBe('installed');
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('does not link a prepared temporary swapped at the final publication boundary', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    let foreignTemporary = '';
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      publicationHook: async (phase) => {
        if (phase !== 'before-link') return;
        const journal = JSON.parse(await readFile(
          join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
          'utf8',
        )) as { temporary: string };
        foreignTemporary = join(paths.agentsDirectory, journal.temporary);
        await rm(foreignTemporary);
        await writeFile(foreignTemporary, 'foreign-final-temp', { mode: 0o600 });
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    await expect(readFile(paths.plistPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(foreignTemporary, 'utf8')).toBe('foreign-final-temp');
  });

  test('preserves a foreign deterministic journal temp instead of pre-deleting it', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    let foreignJournalTemporary = '';
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      transactionHook: async (phase) => {
        if (phase !== 'lock-owned') return 'continue' as const;
        const owner = JSON.parse(await readFile(
          join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`),
          'utf8',
        )) as { transactionId: string };
        foreignJournalTemporary = join(
          paths.agentsDirectory,
          `.${launchdLabel}.transaction.tmp-${owner.transactionId}`,
        );
        await writeFile(foreignJournalTemporary, 'foreign-journal-temp', { mode: 0o600 });
        return 'continue' as const;
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(foreignJournalTemporary, 'utf8')).toBe('foreign-journal-temp');
  });

  for (const journalSwap of ['temporary', 'fixed-target'] as const) {
    test(`does not publish a ${journalSwap} journal inode introduced during owner verification`, async () => {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
      const journalPath = join(paths.agentsDirectory, `.${launchdLabel}.transaction`);
      let swappedPath = '';
      let swapped = false;
      const lifecycle = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        transactionHook: async (phase) => phase === 'publish-prepared' ? 'interrupt' : 'continue',
        metadataReadHook: async (path) => {
          if (swapped || path !== lockPath) return;
          const temporary = (await readdir(paths.agentsDirectory)).find((name) => name.includes('.transaction.tmp-'));
          if (temporary === undefined) return;
          swapped = true;
          swappedPath = journalSwap === 'temporary' ? join(paths.agentsDirectory, temporary) : journalPath;
          if (journalSwap === 'temporary') await rm(swappedPath);
          await writeFile(swappedPath, `foreign-journal-${journalSwap}`, { mode: 0o600 });
        },
      });

      await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
      if (journalSwap === 'temporary') {
        await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(await readFile(journalPath, 'utf8')).toBe('foreign-journal-fixed-target');
      }
      expect(await readFile(swappedPath, 'utf8')).toBe(`foreign-journal-${journalSwap}`);
    });
  }

  test('preserves a swapped prepared temporary instead of deleting an unjournaled inode', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'temporary-created' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const journal = JSON.parse(await readFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
      'utf8',
    )) as { temporary: string };
    const temporaryPath = join(paths.agentsDirectory, journal.temporary);
    await rm(temporaryPath);
    await writeFile(temporaryPath, 'foreign-replacement', { mode: 0o600 });
    let runnerCalled = false;
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('new-start', 'dead', null),
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
    });

    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(runnerCalled).toBe(false);
    expect(await readFile(temporaryPath, 'utf8')).toBe('foreign-replacement');
  });

  test('fails closed when a pre-intent has an impossible source quarantine hard link', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('first-start', 'live', 'first-start'),
      transactionHook: async (phase) => phase === 'temporary-written' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const journal = JSON.parse(await readFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
      'utf8',
    )) as { quarantine: string };
    const quarantinePath = join(paths.agentsDirectory, journal.quarantine);
    await link(paths.plistPath, quarantinePath);
    let runnerCalled = false;
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('second-start', 'dead', null),
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
    });

    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(runnerCalled).toBe(false);
    expect((await lstat(quarantinePath)).ino).toBe((await lstat(paths.plistPath)).ino);
  });

  test('does not restore from a quarantine swapped after journal validation', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'old-quarantined' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const journal = JSON.parse(await readFile(
      join(paths.agentsDirectory, `.${launchdLabel}.transaction`),
      'utf8',
    )) as { quarantine: string };
    const quarantinePath = join(paths.agentsDirectory, journal.quarantine);
    let runnerCalled = false;
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('new-start', 'dead', null),
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
      transactionHook: async (phase) => {
        if (phase !== 'before-restore-link') return 'continue' as const;
        await rm(quarantinePath);
        await writeFile(quarantinePath, 'foreign-quarantine', { mode: 0o600 });
        return 'continue' as const;
      },
    });

    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(runnerCalled).toBe(false);
    await expect(readFile(paths.plistPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(quarantinePath, 'utf8')).toBe('foreign-quarantine');
  });

  test('recovers a crash during rollback removal of a newly installed definition', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    let enableCalls = 0;
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'],
      processInspector: inspector('first-start', 'live', 'first-start'),
      commandRunner: async (argv) => argv[1] === 'enable' && ++enableCalls === 1
        ? failure(5, 'enable failed') : await absentRunner(argv),
      transactionHook: async (phase) => phase === 'removal-quarantined' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const recovered = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('second-start', 'dead', null), lockPollAttempts: 1,
    });
    await recovered.install();
    expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
    expect((await lstat(paths.plistPath)).nlink).toBe(1);
    expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
  });

  test('never steals a metadata-less directory lock because its liveness is unknowable', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`), { mode: 0o700 });
    let runnerCalled = false;
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: async (argv) => {
        runnerCalled = true;
        return await absentRunner(argv);
      },
      processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
    });

    await expect(lifecycle.install()).rejects.toMatchObject({
      code: 'LAUNCHD_OPERATION_BUSY', context: { operation: 'lock', owner: 'unknown-metadata' },
    });
    expect(runnerCalled).toBe(false);
    expect((await lstat(join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`))).isDirectory()).toBe(true);
  });

  for (const crashPhase of [
    'temporary-created',
    'old-quarantined',
    'new-linked',
    'temporary-unlinked',
    'before-enable',
    'after-enable',
    'after-bootstrap',
    'final-cleanup',
  ] as const satisfies readonly LaunchdTransactionPhase[]) {
    test(`recovers an interrupted install at ${crashPhase} idempotently`, async () => {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
      const crashed = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector('old-start', 'live', 'old-start'),
        transactionHook: async (phase) => phase === crashPhase ? 'interrupt' : 'continue',
      });
      await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      if (!['temporary-created', 'old-quarantined'].includes(crashPhase)) {
        expect(await readFile(paths.plistPath, 'utf8')).toContain('<string>desired</string>');
      }

      const recovered = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
      });
      await recovered.install();
      const firstBytes = await readFile(paths.plistPath, 'utf8');
      expect(firstBytes).toContain('<string>desired</string>');
      expect((await lstat(paths.plistPath)).nlink).toBe(1);
      await recovered.install();
      expect(await readFile(paths.plistPath, 'utf8')).toBe(firstBytes);
      expect((await readdir(paths.agentsDirectory)).filter((name) => name !== `${launchdLabel}.plist`)).toEqual([]);
    });
  }

  for (const crashPhase of ['removal-prepared', 'removal-quarantined', 'removal-cleaned'] as const satisfies readonly LaunchdTransactionPhase[]) {
    test(`recovers an interrupted removal at ${crashPhase} without touching unrelated files`, async () => {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(paths.plistPath, 'remove-me', { mode: 0o600 });
      await writeFile(join(paths.agentsDirectory, '.unrelated'), 'preserve', { mode: 0o600 });
      const crashed = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
        processInspector: inspector('old-start', 'live', 'old-start'),
        transactionHook: async (phase) => phase === crashPhase ? 'interrupt' : 'continue',
      });
      await expect(crashed.uninstall()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const recovered = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
        processInspector: inspector('new-start', 'dead', null), lockPollAttempts: 1,
      });
      expect((await recovered.uninstall()).state).toBe(crashPhase === 'removal-prepared' ? 'uninstalled' : 'already-absent');
      expect(await readFile(join(paths.agentsDirectory, '.unrelated'), 'utf8')).toBe('preserve');
      expect((await readdir(paths.agentsDirectory)).sort()).toEqual(['.unrelated']);
    });
  }

  test('never cleans a guessed temporary path after its parent identity changes', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    let replacementSentinel = '';
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async (argv) => argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon')
        ? missingService() : success(),
      publicationHook: async () => {
        const moved = `${paths.agentsDirectory}.moved`;
        await rename(paths.agentsDirectory, moved);
        const [temporary] = (await readdir(moved)).filter((name) => name.includes('.tmp-'));
        if (temporary === undefined) throw new Error('temporary file was not created');
        await mkdir(paths.agentsDirectory, { mode: 0o700 });
        replacementSentinel = join(paths.agentsDirectory, temporary);
        await writeFile(replacementSentinel, 'preserve', { mode: 0o600 });
      },
    });

    await expect(lifecycle.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(replacementSentinel, 'utf8')).toBe('preserve');
  });

  test('rejects oversized sparse owner metadata before process inspection or runner calls', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const handle = await open(lockPath, 'r+');
    await handle.truncate(128 * 1024);
    await handle.close();
    let inspected = false;
    let runnerCalled = false;
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], lockPollAttempts: 1,
      processInspector: {
        current: async () => ({ pid: process.pid, startIdentity: 'new-start' }),
        inspect: async () => { inspected = true; return { state: 'dead', startIdentity: null }; },
      },
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
    });

    await expect(contender.install()).rejects.toMatchObject({
      code: 'UNSAFE_LAUNCHD_PATH', context: { artifact: 'transaction-metadata', reason: 'too-large' },
    });
    expect(inspected).toBe(false);
    expect(runnerCalled).toBe(false);
  });

  test('returns typed unsafe errors for nonregular fixed owner and journal metadata', async () => {
    const ownerHome = await fakeHome();
    const ownerPaths = launchdPaths(ownerHome);
    await mkdir(ownerPaths.agentsDirectory, { recursive: true, mode: 0o700 });
    const ownerSentinel = join(ownerPaths.agentsDirectory, '.owner-sentinel');
    await writeFile(ownerSentinel, 'preserve', { mode: 0o600 });
    await symlink(ownerSentinel, join(ownerPaths.agentsDirectory, `.${launchdLabel}.operation-lock`));
    const ownerContender = createLaunchdLifecycle({
      home: ownerHome, platform: 'darwin', programArguments: ['/bin/echo'], lockPollAttempts: 1,
      processInspector: inspector('new-start', 'dead', null),
      commandRunner: async () => { throw new Error('runner must not be called'); },
    });
    await expect(ownerContender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(ownerSentinel, 'utf8')).toBe('preserve');

    const journalHome = await fakeHome();
    const journalPaths = launchdPaths(journalHome);
    await mkdir(journalPaths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(journalPaths.plistPath, 'old-definition', { mode: 0o600 });
    const crashed = createLaunchdLifecycle({
      home: journalHome, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    const journalPath = join(journalPaths.agentsDirectory, `.${launchdLabel}.transaction`);
    const journalSentinel = join(journalPaths.agentsDirectory, '.journal-sentinel');
    await rm(journalPath);
    await writeFile(journalSentinel, 'preserve', { mode: 0o600 });
    await symlink(journalSentinel, journalPath);
    const journalContender = createLaunchdLifecycle({
      home: journalHome, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('new-start', 'dead', null),
      commandRunner: async () => { throw new Error('runner must not be called'); },
    });
    await expect(journalContender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(await readFile(journalSentinel, 'utf8')).toBe('preserve');
  });

  test('opens a fixed metadata FIFO nonblocking and rejects it as unsafe', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
    const created = spawnSync('/usr/bin/mkfifo', [lockPath], { encoding: 'utf8' });
    expect(created.status).toBe(0);
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'], lockPollAttempts: 1,
      processInspector: inspector('new-start', 'dead', null),
      commandRunner: async () => { throw new Error('runner must not be called'); },
    });
    const install = lifecycle.install().then(
      () => ({ kind: 'resolved' as const, error: null }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    const outcome = await Promise.race([
      install,
      new Promise<{ kind: 'blocked'; error: null }>((resolvePromise) => {
        setTimeout(() => resolvePromise({ kind: 'blocked', error: null }), 50);
      }),
    ]);
    if (outcome.kind === 'blocked') {
      const writer = await open(lockPath, constants.O_WRONLY | constants.O_NONBLOCK);
      await writer.close();
      await install;
    }
    expect(outcome).toMatchObject({ kind: 'rejected', error: { code: 'UNSAFE_LAUNCHD_PATH' } });
  });

  test('rejects non-0600 fixed owner and journal metadata without runner calls', async () => {
    for (const artifact of ['owner', 'journal'] as const) {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
      if (artifact === 'journal') await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
      const crashed = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
        processInspector: inspector('old-start', 'live', 'old-start'),
        transactionHook: async (phase) => phase === (artifact === 'owner' ? 'lock-owned' : 'new-linked')
          ? 'interrupt' : 'continue',
      });
      await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const artifactPath = join(
        paths.agentsDirectory,
        artifact === 'owner' ? `.${launchdLabel}.operation-lock` : `.${launchdLabel}.transaction`,
      );
      await chmod(artifactPath, 0o400);
      let runnerCalled = false;
      const contender = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
        processInspector: inspector('new-start', 'dead', null),
        commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
      });
      await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
      expect(runnerCalled).toBe(false);
    }
  });

  test('rejects under-cap metadata growth and link-count changes during a bounded read', async () => {
    for (const mutation of ['grow', 'hardlink'] as const) {
      const home = await fakeHome();
      const paths = launchdPaths(home);
      const crashed = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'], commandRunner: absentRunner,
        processInspector: inspector('old-start', 'live', 'old-start'),
        transactionHook: async (phase) => phase === 'lock-owned' ? 'interrupt' : 'continue',
      });
      await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
      const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
      const extraLink = join(paths.agentsDirectory, '.metadata-extra-link');
      let mutated = false;
      const contender = createLaunchdLifecycle({
        home, platform: 'darwin', programArguments: ['/bin/echo'], lockPollAttempts: 1,
        processInspector: inspector('new-start', 'dead', null),
        commandRunner: async () => { throw new Error('runner must not be called'); },
        metadataReadHook: async (path) => {
          if (path !== lockPath || mutated) return;
          mutated = true;
          if (mutation === 'grow') await writeFile(path, ' ', { flag: 'a' });
          else await link(path, extraLink);
        },
      });
      await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
      if (mutation === 'hardlink') {
        expect((await lstat(extraLink)).ino).toBe((await lstat(lockPath)).ino);
      }
    }
  });

  test('caps a transaction journal that grows after its initial metadata stat', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    let runnerCalled = false;
    const journalPath = join(paths.agentsDirectory, `.${launchdLabel}.transaction`);
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('new-start', 'dead', null),
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
      metadataReadHook: async (path: string) => {
        if (path === journalPath) await writeFile(path, ' '.repeat(32 * 1024), { flag: 'a' });
      },
    });

    await expect(contender.install()).rejects.toMatchObject({
      code: 'UNSAFE_LAUNCHD_PATH', context: { artifact: 'transaction-metadata', reason: 'too-large' },
    });
    expect(runnerCalled).toBe(false);
  });

  test('rejects malformed fixed journal metadata without invoking launchctl', async () => {
    const home = await fakeHome();
    const paths = launchdPaths(home);
    await mkdir(paths.agentsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.plistPath, 'old-definition', { mode: 0o600 });
    const crashed = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
      processInspector: inspector('old-start', 'live', 'old-start'),
      transactionHook: async (phase) => phase === 'new-linked' ? 'interrupt' : 'continue',
    });
    await expect(crashed.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
    await writeFile(join(paths.agentsDirectory, `.${launchdLabel}.transaction`), '{malformed\n', { mode: 0o600 });
    let runnerCalled = false;
    const contender = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], lockPollAttempts: 1,
      processInspector: inspector('new-start', 'dead', null),
      commandRunner: async (argv) => { runnerCalled = true; return await absentRunner(argv); },
    });
    await expect(contender.install()).rejects.toMatchObject({ code: 'UNSAFE_LAUNCHD_PATH' });
    expect(runnerCalled).toBe(false);
  });

  test('distinguishes an unavailable GUI domain from an absent service', async () => {
    const home = await fakeHome();
    const lifecycle = createLaunchdLifecycle({
      home, platform: 'darwin', programArguments: ['/bin/echo'],
      commandRunner: async () => missingService(),
    });
    await expect(lifecycle.status()).rejects.toMatchObject({ code: 'LAUNCHD_DOMAIN_UNAVAILABLE' });
  });
});

function success(): LaunchdCommandResult {
  return { outcome: 'success', exitCode: 0, stdout: '', stderr: '' } as LaunchdCommandResult;
}

function missingService(): LaunchdCommandResult {
  return { outcome: 'not-found', exitCode: 113, stdout: '', stderr: 'Could not find service' } as LaunchdCommandResult;
}

function failure(exitCode: number, stderr: string): LaunchdCommandResult {
  return { outcome: 'failure', exitCode, stdout: '', stderr } as LaunchdCommandResult;
}

async function absentRunner(argv: readonly string[]): Promise<LaunchdCommandResult> {
  return argv[1] === 'print' && argv[2]?.includes('/dev.wtm.daemon') ? missingService() : success();
}

function inspector(
  currentStartIdentity: string,
  state: 'live' | 'dead' | 'unknown',
  observedStartIdentity: string | null,
): LaunchdProcessInspector {
  return {
    current: async () => ({ pid: process.pid, startIdentity: currentStartIdentity }),
    inspect: async () => ({ state, startIdentity: observedStartIdentity }),
  };
}

async function leaveDurableJournalTemporary(
  home: string,
  currentStartIdentity: string,
  state: 'live' | 'dead' | 'unknown',
  observedStartIdentity: string | null,
): Promise<{ basename: string; transactionId: string }> {
  const paths = launchdPaths(home);
  const lockPath = join(paths.agentsDirectory, `.${launchdLabel}.operation-lock`);
  let interrupted: { basename: string; transactionId: string } | undefined;
  const lifecycle = createLaunchdLifecycle({
    home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
    processInspector: inspector(currentStartIdentity, state, observedStartIdentity), lockPollAttempts: 1,
    metadataReadHook: async (path) => {
      if (path !== lockPath || interrupted !== undefined) return;
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { transactionId: string };
      const basename = `.${launchdLabel}.transaction.tmp-${owner.transactionId}`;
      try { await lstat(join(paths.agentsDirectory, basename)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      interrupted = { basename, transactionId: owner.transactionId };
      throw new LaunchdLifecycleError(
        'LAUNCHD_TRANSACTION_INTERRUPTED',
        'Injected interruption after the durable journal temporary write.',
        { phase: 'journal-temporary-written' },
      );
    },
  });
  await expect(lifecycle.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
  if (interrupted === undefined) throw new Error('journal temporary interruption was not reached');
  return interrupted;
}

async function leaveInterruptedLockOwner(
  home: string,
  currentStartIdentity: string,
  state: 'live' | 'dead' | 'unknown',
  observedStartIdentity: string | null,
  phase: 'lock-owned' | 'stale-lock-moved',
): Promise<{ transactionId: string }> {
  const lifecycle = createLaunchdLifecycle({
    home, platform: 'darwin', programArguments: ['/bin/echo', 'desired'], commandRunner: absentRunner,
    processInspector: inspector(currentStartIdentity, state, observedStartIdentity), lockPollAttempts: 1,
    transactionHook: async (currentPhase) => currentPhase === phase ? 'interrupt' : 'continue',
  });
  await expect(lifecycle.install()).rejects.toMatchObject({ code: 'LAUNCHD_TRANSACTION_INTERRUPTED' });
  return JSON.parse(await readFile(
    join(launchdPaths(home).agentsDirectory, `.${launchdLabel}.operation-lock`),
    'utf8',
  )) as { transactionId: string };
}

function preparingJournalContent(transactionId: string): string {
  return `${JSON.stringify({
    version: 1,
    transactionId,
    operation: 'publish',
    phase: 'preparing',
    temporary: `${launchdLabel}.plist.tmp-${transactionId}`,
    quarantine: `${launchdLabel}.plist.replaced-${transactionId}`,
    original: null,
    replacement: null,
    expected: {
      byteLength: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    failure: null,
  })}\n`;
}
