import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { globalDevOverlayPolicy, globalProxyPolicy } from '../proxy-policy';

/**
 * A temporary directory standing in for the daemon's global config root — never the
 * contributor's real WTM state, per this repo's test rules.
 */
let root: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wtm-proxy-policy-'));
  configPath = join(root, 'config.toml');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('globalProxyPolicy', () => {
  it('reads a well-formed [proxy] table', async () => {
    await writeFile(configPath, '[proxy]\nenabled = true\nport = 19999\n', 'utf8');
    expect(await globalProxyPolicy(configPath)).toEqual({ enabled: true, port: 19999 });
  });

  it('returns {} when the file does not exist, rather than throwing', async () => {
    expect(await globalProxyPolicy(join(root, 'missing.toml'))).toEqual({});
  });

  it('returns {} when the file exists but declares no [proxy] table', async () => {
    await writeFile(configPath, '[jobs]\nmax_concurrent_heavy = 2\n', 'utf8');
    expect(await globalProxyPolicy(configPath)).toEqual({});
  });

  it('throws WtmConfigError for a malformed [proxy] table, same as parseWtmConfig always does', async () => {
    await writeFile(configPath, '[proxy]\nenabled = "yes"\n', 'utf8');
    await expect(globalProxyPolicy(configPath)).rejects.toThrow();
  });
});

describe('globalDevOverlayPolicy', () => {
  it('reads a well-formed [dev-overlay] table', async () => {
    await writeFile(configPath, '[dev-overlay]\nenabled = true\n', 'utf8');
    expect(await globalDevOverlayPolicy(configPath)).toEqual({ enabled: true });
  });

  it('returns {} when the file does not exist, rather than throwing', async () => {
    expect(await globalDevOverlayPolicy(join(root, 'missing.toml'))).toEqual({});
  });

  it('returns {} when the file exists but declares no [dev-overlay] table', async () => {
    await writeFile(configPath, '[proxy]\nenabled = true\n', 'utf8');
    expect(await globalDevOverlayPolicy(configPath)).toEqual({});
  });

  it('reads [proxy] and [dev-overlay] independently from the same file', async () => {
    await writeFile(configPath, '[proxy]\nenabled = true\nport = 20001\n\n[dev-overlay]\nenabled = true\n', 'utf8');
    expect(await globalProxyPolicy(configPath)).toEqual({ enabled: true, port: 20_001 });
    expect(await globalDevOverlayPolicy(configPath)).toEqual({ enabled: true });
  });
});
