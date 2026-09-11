import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { platformPathsFor } from '../../../platform/src/paths/platform-paths';
import { isolatedHomeEnvironment } from '../isolated-home';
import { shortTmpRoot } from '../platform';
import { runScenario } from '../scenario-child';

test('isolated Windows paths override an ambient user profile and application data roots', () => {
  const home = 'C:\\wtm-fixture\\home';
  const env = {
    HOME: 'C:\\Users\\runner',
    USERPROFILE: 'C:\\Users\\runner',
    LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local',
    APPDATA: 'C:\\Users\\runner\\AppData\\Roaming',
    ...isolatedHomeEnvironment(home),
  };
  expect(env.USERPROFILE).toBe(home);
  expect(env.APPDATA.replaceAll('/', '\\')).toBe('C:\\wtm-fixture\\home\\AppData\\Roaming');
  const paths = platformPathsFor('win32', { home, env });
  expect(paths).toMatchObject({
    dataRoot: 'C:\\wtm-fixture\\home\\AppData\\Local\\WTM',
    configPath: 'C:\\wtm-fixture\\home\\AppData\\Local\\WTM\\config.toml',
    logRoot: 'C:\\wtm-fixture\\home\\AppData\\Local\\WTM\\logs',
    serviceRoot: 'C:\\wtm-fixture\\home\\AppData\\Local\\WTM\\service',
  });
  const otherHome = 'C:\\wtm-fixture\\other';
  expect(paths.socketRoot).toStartWith('\\\\.\\pipe\\wtm-');
  expect(paths.socketRoot).not.toBe(platformPathsFor('win32', {
    home: otherHome, env: { ...env, ...isolatedHomeEnvironment(otherHome) },
  }).socketRoot);
});

test('a real child inherits only fixture home and app-data locations without helper-created directories', () => {
  const root = mkdtempSync(join(shortTmpRoot(), 'wtm-env-'));
  const home = join(root, 'home');
  try {
    const result = runScenario('node', ['--input-type=module', '-e', `
      import { homedir } from 'node:os';
      process.stdout.write(JSON.stringify({
        home: homedir(), userProfile: process.env.USERPROFILE,
        local: process.env.LOCALAPPDATA, roaming: process.env.APPDATA,
      }));
    `], { env: { ...process.env, ...isolatedHomeEnvironment(home) }, timeoutMs: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      home, userProfile: home,
      local: join(home, 'AppData', 'Local'), roaming: join(home, 'AppData', 'Roaming'),
    });
    expect(existsSync(home)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
