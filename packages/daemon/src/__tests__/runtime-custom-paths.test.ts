import { expect, test } from 'bun:test';
import { selectPlatformRuntime } from '@wtm/platform';
import { publishedDaemonSocketPath } from '@wtm/platform/socket';
import { resolveProductionRuntimePaths, runtimePathsFor } from '../runtime-factory';

test('a Windows custom data root gets an isolated named pipe, including when omitted by callers', () => {
  const runtime = selectPlatformRuntime({ platform: 'win32', home: 'C:\\Users\\alice', env: {} });
  const first = resolveProductionRuntimePaths(runtime, { dataRoot: 'C:\\fixtures\\first' });
  const second = resolveProductionRuntimePaths(runtime, { dataRoot: 'C:\\fixtures\\second' });
  expect(first.socketPath).toStartWith('\\\\.\\pipe\\wtm-');
  expect(first.socketPath).not.toBe(second.socketPath);
  expect(first.socketPath.length).toBeLessThan(256);
  expect(resolveProductionRuntimePaths(runtime, { dataRoot: 'C:\\fixtures\\first\\.' }).socketPath).toBe(first.socketPath);
  expect(resolveProductionRuntimePaths(runtime, { dataRoot: runtime.paths.dataRoot }).socketPath).toBe(runtimePathsFor(runtime).socketPath);
  const explicit = '\\\\.\\pipe\\wtm-explicit-fixture';
  expect(resolveProductionRuntimePaths(runtime, { dataRoot: first.dataRoot, socketPath: explicit }).socketPath).toBe(explicit);
});

test('default platform IPC and explicit POSIX data-root isolation keep their existing paths', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const runtime = selectPlatformRuntime({ platform, home: platform === 'win32' ? 'C:\\Users\\alice' : '/tmp/alice', env: { XDG_RUNTIME_DIR: '/tmp/runtime' } });
    expect(resolveProductionRuntimePaths(runtime).socketPath).toBe(runtimePathsFor(runtime).socketPath);
    expect(publishedDaemonSocketPath(runtime.paths.socketRoot)).toBe(runtimePathsFor(runtime).socketPath);
    if (platform !== 'win32') expect(resolveProductionRuntimePaths(runtime, { dataRoot: '/tmp/isolated' }).socketPath).toBe('/tmp/isolated/wtmd.sock');
  }
});

/**
 * Regression for a real production bug: `createProductionDaemon({})` — exactly what
 * `wtm daemon serve` calls with no overrides — resolved `globalConfigPath` as
 * `join(dataRoot, 'config.toml')` unconditionally, which is not the documented global config
 * location on Linux (`~/.config/wtm/config.toml`, a different directory from `~/.local/state/wtm`,
 * the data root) or Windows. `[budgets]`/`[jobs]`/`[proxy]` in the real, documented config file
 * were silently never read by an installed daemon. `socketPath` already gets this right two lines
 * above — this mirrors it: the untouched default reads the platform's own config path, and only an
 * explicitly relocated `dataRoot` moves `globalConfigPath` with it.
 */
test('an untouched data root resolves globalConfigPath to the platform default, not a dataRoot-relative path', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const runtime = selectPlatformRuntime({ platform, home: platform === 'win32' ? 'C:\\Users\\alice' : '/tmp/alice', env: { XDG_RUNTIME_DIR: '/tmp/runtime' } });
    expect(resolveProductionRuntimePaths(runtime).globalConfigPath).toBe(runtimePathsFor(runtime).globalConfigPath);
    if (platform !== 'win32') {
      // An explicitly relocated dataRoot still gets globalConfigPath nested under it, as isolation
      // convenience for a caller (tests) that isolates entirely via `dataRoot`.
      expect(resolveProductionRuntimePaths(runtime, { dataRoot: '/tmp/isolated' }).globalConfigPath).toBe('/tmp/isolated/config.toml');
    }
  }
});
