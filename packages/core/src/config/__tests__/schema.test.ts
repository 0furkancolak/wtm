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
});
