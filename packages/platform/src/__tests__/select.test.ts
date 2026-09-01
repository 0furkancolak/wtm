import { describe, expect, test } from 'bun:test';
import { wtmErrorCodeSchema } from '@wtm/protocol';
import { UnsupportedPlatformError, selectPlatformRuntime, supportedPlatforms } from '../index';

/**
 * These tests are about the composition root itself, not about any port's behaviour — each port has
 * its own suite. What is checked here is that a runtime is *complete and self-consistent*: that
 * every field comes from the same platform, and that constructing the Linux one from this macOS
 * host works at all, which is the property the entire increment's Linux half rests on.
 */
describe('selectPlatformRuntime', () => {
  const env = { HOME: '/Users/x' } as const;

  test('builds a complete runtime for every supported platform, from any host', () => {
    for (const id of supportedPlatforms) {
      const runtime = selectPlatformRuntime({ platform: id, env, home: '/Users/x' });

      expect(runtime.id).toBe(id);
      // A runtime that mixed a macOS path policy with a Linux service backend would still
      // typecheck, so the agreement is asserted rather than assumed.
      expect(runtime.service.id).toBe(id);
      expect(runtime.paths.dataRoot.length).toBeGreaterThan(0);
      expect(runtime.paths.serviceRoot.length).toBeGreaterThan(0);
      expect(runtime.socket.limitBytes).toBeGreaterThan(0);
      expect(typeof runtime.process.readStartTime).toBe('function');
    }
  });

  test('the two platforms disagree about every path, which is why the seam exists', () => {
    const darwin = selectPlatformRuntime({ platform: 'darwin', env, home: '/Users/x' });
    const linux = selectPlatformRuntime({ platform: 'linux', env, home: '/Users/x' });

    expect(darwin.paths.dataRoot).not.toBe(linux.paths.dataRoot);
    expect(darwin.paths.logRoot).not.toBe(linux.paths.logRoot);
    expect(darwin.paths.serviceRoot).not.toBe(linux.paths.serviceRoot);
    expect(darwin.socket.limitBytes).not.toBe(linux.socket.limitBytes);
    expect(darwin.service.managerName).not.toBe(linux.service.managerName);
  });

  test('refuses an unsupported platform with an error the envelope can carry', () => {
    let thrown: unknown;
    try { selectPlatformRuntime({ platform: 'win32', env, home: '/Users/x' }); }
    catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(UnsupportedPlatformError);
    const error = thrown as UnsupportedPlatformError;
    expect(wtmErrorCodeSchema.options).toContain(error.code);
    expect(error.severity).toBe('error');
    expect(error.message).toContain('win32');
    // The refusal names what WTM does support, so the reader learns the answer and not only the
    // refusal. Windows is a later increment; saying "requires macOS" would now be false.
    expect(error.message).toContain('darwin');
    expect(error.message).toContain('linux');
    expect(error.context).toEqual({ platform: 'win32', supported: ['darwin', 'linux'] });
  });

  test('refuses a home that is not absolute, once, on behalf of every port', () => {
    for (const home of ['', 'relative/home', './x']) {
      expect(() => selectPlatformRuntime({ platform: 'linux', env, home })).toThrow(TypeError);
    }
  });

  test('resolves the home, so two runtimes cannot disagree about one directory', () => {
    const direct = selectPlatformRuntime({ platform: 'darwin', env, home: '/Users/x' });
    const indirect = selectPlatformRuntime({ platform: 'darwin', env, home: '/Users/y/../x' });

    expect(indirect.paths.dataRoot).toBe(direct.paths.dataRoot);
    expect(indirect.paths.socketRoot).toBe(direct.paths.socketRoot);
  });

  test('reads only its arguments: an ambient XDG variable does not reach a runtime given none', () => {
    const withXdg = selectPlatformRuntime({
      platform: 'linux', home: '/Users/x', env: { XDG_STATE_HOME: '/xdg/state' },
    });
    const without = selectPlatformRuntime({ platform: 'linux', home: '/Users/x', env: {} });

    expect(withXdg.paths.dataRoot).toBe('/xdg/state/wtm');
    expect(without.paths.dataRoot).not.toBe(withXdg.paths.dataRoot);
  });
});
