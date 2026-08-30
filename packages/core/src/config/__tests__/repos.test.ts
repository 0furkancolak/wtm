import { describe, expect, it } from 'bun:test';
import { parse } from 'smol-toml';
import { parseWtmConfig, WtmConfigError } from '../schema';
import { repoEnvironment, resolveRepoScope } from '../repos';

const config = (toml: string) => parseWtmConfig(parse(toml));
const scope = { workspaceRoot: '/workspace', repoRoot: '/workspace/api' };

describe('repository scoping', () => {
  it('matches a repository by the path the entry names', () => {
    const resolved = resolveRepoScope(config('[repos.backend]\npath = "api"\n'), scope);

    expect(resolved?.name).toBe('backend');
  });

  it('matches a repository by the entry name when it names no path', () => {
    expect(resolveRepoScope(config('[repos.api]\n'), scope)?.name).toBe('api');
  });

  it('gives each repository its own reading of the same variable', () => {
    const declared = config([
      '[repos.api.environment]',
      'PORT = "{port.api}"',
      '',
      '[repos.web.environment]',
      'PORT = "{port.web}"',
    ].join('\n'));

    expect(repoEnvironment(declared, scope)).toEqual({ PORT: '{port.api}' });
    expect(repoEnvironment(declared, { ...scope, repoRoot: '/workspace/web' })).toEqual({ PORT: '{port.web}' });
  });

  it('says nothing about a repository no entry names', () => {
    expect(repoEnvironment(config('[repos.web]\n'), scope)).toBeUndefined();
  });

  it('refuses two entries that name the same repository', () => {
    const declared = config('[repos.api]\n\n[repos.backend]\npath = "api"\n');

    expect(() => resolveRepoScope(declared, scope)).toThrow(WtmConfigError);
    expect(() => resolveRepoScope(declared, scope)).toThrow('name the same repository');
  });
});
