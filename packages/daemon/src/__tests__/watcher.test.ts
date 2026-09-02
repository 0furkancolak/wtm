import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { wtmErrorSchema } from '@wtm/protocol';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watcherModule = await import('../watcher').catch(() => null);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

interface CapturedWatch {
  root: string;
  options: { recursive?: boolean };
  listener: (eventType: string, filename: string | Buffer | null) => void;
  closed: boolean;
}

describe('StructuralWatcher', () => {
  test('watches only registered roots and ignores ordinary source edits', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const watches: CapturedWatch[] = [];
    const signals: unknown[] = [];
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{
        workspaceRoot: '/registered',
        repositories: [{
          mainRoot: '/registered/repo',
          commonGitDir: '/registered/repo/.git',
          worktreePaths: ['/outside/linked'],
        }],
      }],
      schedule: (signal) => { signals.push(signal); },
      watchFactory: (root, options, listener) => {
        const captured = { root, options, listener, closed: false };
        watches.push(captured);
        return { close: () => { captured.closed = true; }, onError: () => () => {} };
      },
      fingerprint: async () => 'initial',
    });
    await watcher.start();

    expect(watches.map(({ root }) => root).sort()).toEqual([
      '/outside/linked',
      '/registered',
      '/registered/repo',
      '/registered/repo/.git',
    ]);
    expect(watches.every(({ options }) => options.recursive === true)).toBe(true);
    watches.find(({ root }) => root === '/registered/repo')?.listener('change', 'src/index.ts');
    expect(signals).toEqual([]);

    watches.find(({ root }) => root === '/registered/repo')?.listener('change', 'package.json');
    watches.find(({ root }) => root === '/registered/repo/.git')?.listener('rename', 'worktrees/new/HEAD');
    expect(signals).toEqual([
      { root: '/registered/repo', kind: 'manifest' },
      { root: '/registered/repo/.git', kind: 'git-topology' },
    ]);
    await watcher.close();
    expect(watches.every(({ closed }) => closed)).toBe(true);
  });

  test('an ordinary thousand-file source edit storm schedules zero adapter discovery work', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    let listener!: CapturedWatch['listener'];
    let scheduled = 0;
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{ workspaceRoot: '/registered', repositories: [{
        mainRoot: '/registered/repo', commonGitDir: '/registered/repo/.git', worktreePaths: [],
      }] }],
      schedule: () => { scheduled += 1; },
      fingerprint: async () => 'stable',
      watchFactory: (root, _options, captured) => {
        if (root === '/registered/repo') listener = captured;
        return { close() {}, onError: () => () => {} };
      },
    });
    await watcher.start();
    for (let index = 0; index < 1_000; index += 1) listener('change', `src/module-${index}.ts`);
    await watcher.whenIdle();
    await watcher.close();

    expect(scheduled).toBe(0);
  });

  test('uses a lightweight fingerprint when filename is absent', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    let listener!: CapturedWatch['listener'];
    const fingerprints = ['same', 'same', 'changed'];
    const signals: unknown[] = [];
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{ workspaceRoot: '/registered', repositories: [] }],
      schedule: (signal) => { signals.push(signal); },
      watchFactory: (_root, _options, captured) => {
        listener = captured;
        return { close: () => {}, onError: () => () => {} };
      },
      fingerprint: async () => fingerprints.shift() ?? 'changed',
    });
    await watcher.start();

    listener('change', null);
    await watcher.whenIdle();
    expect(signals).toEqual([]);
    listener('change', null);
    await watcher.whenIdle();
    expect(signals).toEqual([{ root: '/registered', kind: 'fingerprint' }]);
    await watcher.close();
  });

  test('never opens a handle after close begins during initial fingerprinting', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    let releaseFingerprint!: () => void;
    const fingerprintBlocked = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
    let opened = 0;
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{ workspaceRoot: '/registered', repositories: [] }],
      schedule: () => {},
      fingerprint: async () => { await fingerprintBlocked; return 'initial'; },
      watchFactory: () => {
        opened += 1;
        return { close: () => {}, onError: () => () => {} };
      },
    });

    const starting = watcher.start();
    const closing = watcher.close();
    releaseFingerprint();
    await Promise.all([starting, closing]);

    expect(opened).toBe(0);
  });

  test('coalesces concurrent start calls into exactly one opened and closed handle', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    let opened = 0;
    let closed = 0;
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{ workspaceRoot: '/registered', repositories: [] }],
      schedule: () => {},
      fingerprint: async () => 'initial',
      watchFactory: () => {
        opened += 1;
        return { close: () => { closed += 1; }, onError: () => () => {} };
      },
    });

    await Promise.all([watcher.start(), watcher.start()]);
    await watcher.close();

    expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
  });

  test('closes every opened handle in reverse order when error subscription fails during start', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const closed: string[] = [];
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [
        { workspaceRoot: '/a', repositories: [] },
        { workspaceRoot: '/b', repositories: [] },
      ],
      schedule: () => {},
      fingerprint: async () => 'initial',
      watchFactory: (root) => ({
        close: () => { closed.push(root); },
        onError: () => {
          if (root === '/b') throw new Error('subscription failed');
          return () => {};
        },
      }),
    });

    await expect(watcher.start()).rejects.toThrow('subscription failed');
    expect(closed).toEqual(['/b', '/a']);
  });

  test('attempts every unsubscribe and close once when reverse-order cleanup throws', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const events: string[] = [];
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [
        { workspaceRoot: '/a', repositories: [] },
        { workspaceRoot: '/b', repositories: [] },
        { workspaceRoot: '/c', repositories: [] },
      ],
      schedule: () => {},
      fingerprint: async () => 'initial',
      watchFactory: (root) => ({
        close: () => {
          events.push(`close:${root}`);
          if (root === '/c') throw new Error('close c failed');
        },
        onError: () => () => {
          events.push(`unsubscribe:${root}`);
          if (root === '/b') throw new Error('unsubscribe b failed');
        },
      }),
    });
    await watcher.start();

    const closing = watcher.close();
    expect(watcher.close()).toBe(closing);
    await expect(closing).rejects.toThrow('close c failed');
    expect(events).toEqual([
      'unsubscribe:/c', 'close:/c',
      'unsubscribe:/b', 'close:/b',
      'unsubscribe:/a', 'close:/a',
    ]);
    await expect(watcher.close()).resolves.toBeUndefined();
    expect(events).toHaveLength(6);
  });

  test('handles FSWatcher errors and schedules deterministic fingerprint recovery', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    let emitError!: (error: Error) => void;
    const errors: unknown[] = [];
    const signals: unknown[] = [];
    let closes = 0;
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{ workspaceRoot: '/registered', repositories: [] }],
      schedule: (signal) => { signals.push(signal); },
      fingerprint: async () => 'initial',
      onError: (error) => { errors.push(error); },
      watchFactory: () => ({
        close: () => { closes += 1; },
        onError: (listener) => {
          emitError = listener;
          return () => {};
        },
      }),
    });
    await watcher.start();

    const failure = new Error('watch failed');
    emitError(failure);

    // The raw error is kept as the cause, not reported in place of the named condition: what
    // reaches the daemon log is the sentence a person can act on, and the original is still
    // there for whoever is reading frames.
    expect(errors).toHaveLength(1);
    const reported = errors[0] as Error & { code?: string };
    expect(reported.code).toBe('WTM_WATCH_UNAVAILABLE');
    expect(reported.message).toContain('/registered');
    expect(reported.cause).toBe(failure);
    expect(signals).toEqual([{ root: '/registered', kind: 'watch-error' }]);
    expect(closes).toBe(1);
    await watcher.close();
  });

  test('coalesces missing-filename storms to one fingerprint at a time with one dirty rerun', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    let listener!: CapturedWatch['listener'];
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{ workspaceRoot: '/registered', repositories: [] }],
      schedule: () => {},
      fingerprint: async () => {
        calls += 1;
        if (calls === 1) return 'initial';
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 3) secondStarted();
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return `fingerprint-${calls}`;
      },
      watchFactory: (_root, _options, captured) => {
        listener = captured;
        return { close: () => {}, onError: () => () => {} };
      },
    });
    await watcher.start();

    for (let index = 0; index < 20; index += 1) listener('change', null);
    expect(calls).toBe(2);
    gates.shift()?.();
    await second;
    gates.shift()?.();
    await watcher.whenIdle();

    expect({ calls, maxActive }).toEqual({ calls: 3, maxActive: 1 });
    await watcher.close();
  });

  test('fingerprints bounded loose refs and linked-worktree administrative metadata', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const root = await mkdtemp(join(tmpdir(), 'wtm-fingerprint-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'refs', 'heads'), { recursive: true });
    await mkdir(join(root, 'worktrees', 'linked'), { recursive: true });
    await writeFile(join(root, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(root, 'refs', 'heads', 'main'), 'first\n');
    await writeFile(join(root, 'worktrees', 'linked', 'HEAD'), 'first\n');
    await writeFile(join(root, 'worktrees', 'linked', 'gitdir'), '/outside/linked/.git\n');
    let listener!: CapturedWatch['listener'];
    const signals: unknown[] = [];
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [{
        workspaceRoot: root,
        repositories: [{ mainRoot: root, commonGitDir: root, worktreePaths: [] }],
      }],
      schedule: (signal) => { signals.push(signal); },
      watchFactory: (_root, _options, captured) => {
        listener = captured;
        return { close: () => {}, onError: () => () => {} };
      },
    });
    await watcher.start();

    await writeFile(join(root, 'refs', 'heads', 'main'), 'second\n');
    listener('change', null);
    await watcher.whenIdle();
    await writeFile(join(root, 'worktrees', 'linked', 'locked'), 'maintenance\n');
    listener('change', null);
    await watcher.whenIdle();

    expect(signals).toEqual([
      { root, kind: 'fingerprint' },
      { root, kind: 'fingerprint' },
    ]);
    await watcher.close();
  });

  test('stops incremental Git directory iteration at each configured cap and closes iterators', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const root = await mkdtemp(join(tmpdir(), 'wtm-fingerprint-cap-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const heads = join(root, 'refs', 'heads');
    const worktrees = join(root, 'worktrees');
    await mkdir(heads, { recursive: true });
    await mkdir(worktrees, { recursive: true });
    for (let offset = 0; offset < 1_030; offset += 50) {
      await Promise.all(Array.from({ length: Math.min(50, 1_030 - offset) }, (_, index) =>
        writeFile(join(heads, `ref-${String(offset + index).padStart(4, '0')}`), 'value\n')));
    }
    for (let offset = 0; offset < 270; offset += 50) {
      await Promise.all(Array.from({ length: Math.min(50, 270 - offset) }, (_, index) =>
        mkdir(join(worktrees, `worktree-${String(offset + index).padStart(3, '0')}`))));
    }
    const reads = new Map<string, number>();
    const closes = new Map<string, number>();
    const fingerprint = await watcherModule.structuralFingerprint(root, new Set(['git-admin']), {
      directoryFactory: async (path) => {
        const directory = await opendir(path);
        return {
          read: async () => {
            reads.set(path, (reads.get(path) ?? 0) + 1);
            return await directory.read();
          },
          close: async () => {
            closes.set(path, (closes.get(path) ?? 0) + 1);
            await directory.close();
          },
        };
      },
    });

    expect(reads.get(heads)).toBeLessThanOrEqual(1_025);
    expect(reads.get(worktrees)).toBeLessThanOrEqual(257);
    expect(closes.get(heads)).toBe(1);
    expect(closes.get(worktrees)).toBe(1);
    expect(fingerprint).toContain('refs:truncated');
    expect(fingerprint).toContain('worktrees:truncated');
  });
});

/**
 * A watch that cannot be opened used to reach the user as whatever libuv threw -- `ENOSPC: no
 * space left on device, watch '/Users/...'` -- repeated for as long as the condition lasted. On
 * Linux that sentence is actively misleading: the disk is not full, the kernel is out of inotify
 * watches, and the fix is one sysctl the message never named. These tests pin the named condition
 * and the remedy, and pin that the remedy is the *host's* -- a macOS user must never be sent to
 * change a Linux kernel parameter.
 */
describe('WatchUnavailableError', () => {
  function refuse(code: string, message: string): (root: string) => never {
    return (root) => {
      throw Object.assign(new Error(`${code}: ${message}, watch '${root}'`), { code, errno: -28 });
    };
  }

  function watcherRefusing(
    module: NonNullable<typeof watcherModule>,
    platform: NodeJS.Platform,
    refusal: (root: string) => never,
  ) {
    return new module.StructuralWatcher({
      registrations: [{ workspaceRoot: '/registered', repositories: [] }],
      schedule: () => {},
      fingerprint: async () => 'initial',
      platform,
      watchFactory: (root) => refusal(root),
    });
  }

  async function refusalFrom(watcher: { start(): Promise<void> }): Promise<Error & {
    code?: string;
    severity?: string;
    context?: Record<string, unknown>;
    remediation?: readonly { kind: string; argv: string[] }[];
  }> {
    try {
      await watcher.start();
    } catch (error) {
      return error as Error & { code?: string };
    }
    throw new Error('the watcher started when the watch was refused');
  }

  test('names the inotify budget and the sysctl that raises it on Linux', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const watcher = watcherRefusing(watcherModule, 'linux', refuse('ENOSPC', 'no space left on device'));

    const error = await refusalFrom(watcher);

    expect(error.code).toBe('WTM_WATCH_UNAVAILABLE');
    expect(error.severity).toBe('error');
    expect(error.message).toContain('/registered');
    expect(error.message).toContain('ENOSPC');
    expect(error.message).toContain('fs.inotify.max_user_watches');
    expect(error.context).toMatchObject({ root: '/registered', errno: 'ENOSPC', platform: 'linux' });
    expect(error.remediation?.[0]?.argv.join(' ')).toContain('fs.inotify.max_user_watches');
    // `daemon serve` rebuilds a coded failure into the JSON envelope structurally, from these
    // four fields. Parsing them here is what says the remedy survives that trip instead of being
    // flattened to `WTM_DAEMON_REQUEST_FAILED` and exit 1.
    expect(wtmErrorSchema.safeParse({
      code: error.code,
      message: error.message,
      severity: error.severity,
      context: error.context,
      remediation: error.remediation,
    }).success).toBe(true);
  });

  test('reports one line, because the daemon log records one line per condition', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const watcher = watcherRefusing(watcherModule, 'linux', refuse('ENOSPC', 'no space left on device'));

    // `createDaemonErrorReporter` truncates at the first line break and marks it `[...]`, so a
    // remedy on a second line is a remedy the user never reads.
    expect((await refusalFrom(watcher)).message).not.toContain('\n');
  });

  test('sends a macOS user to the file-descriptor limit, never to a Linux sysctl', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const watcher = watcherRefusing(watcherModule, 'darwin', refuse('EMFILE', 'too many open files'));

    const error = await refusalFrom(watcher);

    expect(error.message).toContain('EMFILE');
    expect(error.message).not.toContain('fs.inotify');
    expect(error.context).toMatchObject({ platform: 'darwin' });
  });

  test('names the inotify instance limit for a Linux descriptor exhaustion', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const watcher = watcherRefusing(watcherModule, 'linux', refuse('EMFILE', 'too many open files'));

    expect((await refusalFrom(watcher)).message).toContain('fs.inotify.max_user_instances');
  });

  test('keeps a condition it has no remedy for readable, and invents no remedy for it', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const watcher = watcherRefusing(watcherModule, 'linux', refuse('EACCES', 'permission denied'));

    const error = await refusalFrom(watcher);

    expect(error.code).toBe('WTM_WATCH_UNAVAILABLE');
    expect(error.message).toContain('EACCES');
    expect(error.message).not.toContain('fs.inotify');
    expect(error.remediation ?? []).toHaveLength(0);
  });

  test('closes the handles it had already opened when a later root is refused', async () => {
    expect(watcherModule).not.toBeNull();
    if (watcherModule === null) return;
    const closed: string[] = [];
    const watcher = new watcherModule.StructuralWatcher({
      registrations: [
        { workspaceRoot: '/a', repositories: [] },
        { workspaceRoot: '/b', repositories: [] },
      ],
      schedule: () => {},
      fingerprint: async () => 'initial',
      platform: 'linux',
      watchFactory: (root) => {
        if (root === '/b') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return { close: () => { closed.push(root); }, onError: () => () => {} };
      },
    });

    await expect(watcher.start()).rejects.toThrow('fs.inotify.max_user_watches');
    expect(closed).toEqual(['/a']);
  });
});
