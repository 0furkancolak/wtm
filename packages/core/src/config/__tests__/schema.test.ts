import { describe, expect, it } from 'bun:test';
import { parseWtmConfig, WtmConfigError } from '../schema';

describe('parseWtmConfig', () => {
  it('rejects a task which combines run with main or worktree commands', () => {
    expect(() => parseWtmConfig({ tasks: { dev: { run: ['make', 'dev'], main: ['make', 'main'] } } })).toThrow();
  });

  it('requires a string command to explicitly opt into shell execution', () => {
    expect(() => parseWtmConfig({ tasks: { legacy: { run: 'make dev' } } })).toThrow();
    expect(parseWtmConfig({ tasks: { legacy: { run: 'make dev', shell: true } } }).tasks?.legacy?.shell).toBe(true);
    expect(() => parseWtmConfig({ tasks: { safe: { run: ['make', 'dev'], shell: true } } })).toThrow();
  });

  it('validates every declared main and worktree command against shell mode', () => {
    expect(() => parseWtmConfig({ tasks: { dev: { main: ['make', 'dev'], worktree: 'make dev-worktree' } } })).toThrow();
    expect(() => parseWtmConfig({ tasks: { dev: { main: 'make dev', worktree: ['make', 'dev-worktree'], shell: true } } })).toThrow();
  });

  it('accepts a well-formed [git] allowed_remote_refs list', () => {
    const config = parseWtmConfig({
      git: { allowed_remote_refs: ['refs/remotes/origin/*', 'refs/remotes/upstream/*'] },
    });

    expect(config.git?.allowed_remote_refs).toEqual(['refs/remotes/origin/*', 'refs/remotes/upstream/*']);
  });

  it('rejects an allowed_remote_refs pattern outside refs/remotes', () => {
    expect(() => parseWtmConfig({ git: { allowed_remote_refs: ['refs/heads/main'] } })).toThrow();
  });

  it('rejects an allowed_remote_refs pattern whose wildcard is not trailing', () => {
    expect(() => parseWtmConfig({ git: { allowed_remote_refs: ['refs/remotes/*/main'] } })).toThrow();
  });

  it('rejects an empty allowed_remote_refs list', () => {
    expect(() => parseWtmConfig({ git: { allowed_remote_refs: [] } })).toThrow();
  });

  it('reports an invalid allowed_remote_refs pattern as a coded WTM_CONFIG_INVALID error', () => {
    try {
      parseWtmConfig({ git: { allowed_remote_refs: ['refs/heads/main'] } });
      throw new Error('expected parseWtmConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WtmConfigError);
      const config = error as WtmConfigError;
      expect(config.code).toBe('WTM_CONFIG_INVALID');
      expect(config.context.issues).toEqual([
        { path: 'git.allowed_remote_refs', message: expect.stringContaining('Invalid allowed remote-tracking ref') },
      ]);
    }
  });

  it('accepts a well-formed [proxy] table', () => {
    const config = parseWtmConfig({ proxy: { enabled: true, port: 19999 } });
    expect(config.proxy).toEqual({ enabled: true, port: 19999 });
  });

  it('[proxy] is optional and defaults to nothing', () => {
    expect(parseWtmConfig({}).proxy).toBeUndefined();
  });

  it('rejects an unknown key in [proxy]', () => {
    expect(() => parseWtmConfig({ proxy: { enabled: true, host: '0.0.0.0' } })).toThrow();
  });

  it('rejects a [proxy] port outside 1-65535', () => {
    expect(() => parseWtmConfig({ proxy: { port: 0 } })).toThrow();
    expect(() => parseWtmConfig({ proxy: { port: 65_536 } })).toThrow();
  });

  it('accepts a well-formed [dev-overlay] table', () => {
    const config = parseWtmConfig({ 'dev-overlay': { enabled: true } });
    expect(config['dev-overlay']).toEqual({ enabled: true });
  });

  it('[dev-overlay] is optional and defaults to nothing', () => {
    expect(parseWtmConfig({})['dev-overlay']).toBeUndefined();
  });

  it('rejects an unknown key in [dev-overlay]', () => {
    expect(() => parseWtmConfig({ 'dev-overlay': { enabled: true, checklist: true } })).toThrow();
  });

  it('accepts [dev-overlay] enabled alongside [proxy] disabled — validated independently, wired inert by the daemon', () => {
    const config = parseWtmConfig({ 'dev-overlay': { enabled: true }, proxy: { enabled: false } });
    expect(config['dev-overlay']).toEqual({ enabled: true });
    expect(config.proxy).toEqual({ enabled: false });
  });

  it('accepts a per-repository [dev-overlay.repos.<name>] override (todo item 46, repo-level toggle)', () => {
    const config = parseWtmConfig({
      'dev-overlay': { enabled: true, repos: { 'storefront-web': { enabled: false }, 'storefront-api': {} } },
    });
    expect(config['dev-overlay']).toEqual({
      enabled: true,
      repos: { 'storefront-web': { enabled: false }, 'storefront-api': {} },
    });
  });

  it('rejects an unknown key inside a [dev-overlay.repos.<name>] entry', () => {
    expect(() => parseWtmConfig({ 'dev-overlay': { repos: { web: { enabled: true, extra: 1 } } } })).toThrow();
  });

  it('accepts a well-formed [budgets] table', () => {
    const config = parseWtmConfig({ budgets: { max_processes: 20, min_available_memory_mib: 512 } });
    expect(config.budgets).toEqual({ max_processes: 20, min_available_memory_mib: 512 });
  });

  it('[budgets] is optional and defaults to nothing', () => {
    expect(parseWtmConfig({}).budgets).toBeUndefined();
  });

  it('rejects an unknown key in [budgets]', () => {
    expect(() => parseWtmConfig({ budgets: { max_processes: 20, max_disk: '20GiB' } })).toThrow();
  });

  it('rejects a [budgets] max_processes below 1', () => {
    expect(() => parseWtmConfig({ budgets: { max_processes: 0 } })).toThrow();
  });

  it('rejects a [budgets] min_available_memory_mib below 1', () => {
    expect(() => parseWtmConfig({ budgets: { min_available_memory_mib: 0 } })).toThrow();
  });

  // A fixed port is never leased (`endpoint-plan.ts`'s `fixedPort` returns it verbatim), so two
  // `[ports.<name>]` entries naming the same literal port used to resolve silently to the same
  // number with nothing catching it until whichever process binds second got a bare OS
  // EADDRINUSE. Caught here at config load instead, like every other cross-field [ports] rule.
  it('rejects two fixed [ports] entries that name the same literal port', () => {
    expect(() => parseWtmConfig({
      ports: {
        web: { strategy: 'fixed', port: 20005 },
        metrics: { strategy: 'fixed', port: 20005 },
      },
    })).toThrow();
  });

  it('reports a fixed-port collision as a coded WTM_CONFIG_INVALID error naming both entries', () => {
    try {
      parseWtmConfig({
        ports: {
          web: { strategy: 'fixed', port: 20005 },
          metrics: { strategy: 'fixed', port: 20005 },
        },
      });
      throw new Error('expected parseWtmConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WtmConfigError);
      const config = error as WtmConfigError;
      expect(config.code).toBe('WTM_CONFIG_INVALID');
      expect(config.context.issues).toEqual([
        { path: 'ports.web.port', message: expect.stringContaining('Port 20005 is used by more than one fixed') },
        { path: 'ports.metrics.port', message: expect.stringContaining('Port 20005 is used by more than one fixed') },
      ]);
    }
  });

  it('accepts fixed ports with distinct literal values, and a fixed port alongside a leased one', () => {
    const config = parseWtmConfig({
      ports: {
        web: { strategy: 'fixed', port: 20005 },
        metrics: { strategy: 'fixed', port: 20006 },
        api: { preferred: 20007 },
      },
    });
    expect(config.ports).toMatchObject({
      web: { strategy: 'fixed', port: 20005 },
      metrics: { strategy: 'fixed', port: 20006 },
      api: { preferred: 20007 },
    });
  });
});
