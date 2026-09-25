import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { analyzeWorkerEnvironment, readWorkerDefinitions, wranglerDevCommand } from '../worker-env';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wtm-worker-env-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('wranglerDevCommand', () => {
  it('recognizes wrangler dev however it is launched', () => {
    expect(wranglerDevCommand(['bunx', 'wrangler', 'dev', '--port', '4000'])).toEqual({ forwarded: [] });
    expect(wranglerDevCommand(['npx', 'wrangler@4', 'dev'])).toEqual({ forwarded: [] });
    expect(wranglerDevCommand(['./node_modules/.bin/wrangler', 'dev'])).toEqual({ forwarded: [] });
    expect(wranglerDevCommand('cd apps/api && exec bunx wrangler dev --port 1')).toEqual({ forwarded: [] });
  });

  it('is not fooled by other wrangler subcommands or other programs', () => {
    expect(wranglerDevCommand(['bunx', 'wrangler', 'deploy'])).toBeNull();
    expect(wranglerDevCommand(['bun', 'run', 'dev'])).toBeNull();
    expect(wranglerDevCommand(['next', 'dev'])).toBeNull();
    expect(wranglerDevCommand('bunx wrangler types && next dev')).toBeNull();
  });

  it('reads the config file, the environment and every --var already on the command line', () => {
    expect(wranglerDevCommand([
      'bunx', 'wrangler', 'dev', '-c', 'wrangler.jsonc', '--env', 'staging',
      '--var', 'CORS_ALLOWED_ORIGINS:{cors.origins}', '--var=API_URL:http://x',
    ])).toEqual({ configPath: 'wrangler.jsonc', environment: 'staging', forwarded: ['CORS_ALLOWED_ORIGINS', 'API_URL'] });
    expect(wranglerDevCommand(['wrangler', 'dev', '--config=a/wrangler.toml', '-e=prod']))
      .toEqual({ configPath: 'a/wrangler.toml', environment: 'prod', forwarded: [] });
    expect(wranglerDevCommand('exec bunx wrangler dev --var "CORS_ALLOWED_ORIGINS:$CORS_ALLOWED_ORIGINS" --var \'FRONTEND_URL:$FRONTEND_URL\''))
      .toEqual({ forwarded: ['CORS_ALLOWED_ORIGINS', 'FRONTEND_URL'] });
  });
});

describe('readWorkerDefinitions', () => {
  it('reads .dev.vars for names only, skipping commented-out lines', async () => {
    await writeFile(join(root, '.dev.vars'), [
      'CORS_ALLOWED_ORIGINS=http://localhost:3000',
      'export FRONTEND_URL="http://localhost:3000"',
      '# API_URL=http://localhost:4000',
      'SECRET_KEY=do-not-carry-me',
    ].join('\n'));

    const definitions = await readWorkerDefinitions({ cwd: root });

    expect(definitions).toEqual({
      CORS_ALLOWED_ORIGINS: '.dev.vars',
      FRONTEND_URL: '.dev.vars',
      SECRET_KEY: '.dev.vars',
    });
    expect(JSON.stringify(definitions)).not.toContain('do-not-carry-me');
  });

  it('prefers .dev.vars.<env> over .dev.vars, the way wrangler does, and loads only one', async () => {
    await writeFile(join(root, '.dev.vars'), 'BASE_ONLY=1\n');
    await writeFile(join(root, '.dev.vars.staging'), 'STAGING_ONLY=1\n');

    expect(await readWorkerDefinitions({ cwd: root, environment: 'staging' })).toEqual({ STAGING_ONLY: '.dev.vars.staging' });
    expect(await readWorkerDefinitions({ cwd: root, environment: 'prod' })).toEqual({ BASE_ONLY: '.dev.vars' });
  });

  it('falls back to .env files when there is no .dev.vars', async () => {
    await writeFile(join(root, '.env'), 'FROM_DOTENV=1\n');
    await writeFile(join(root, '.env.local'), 'FROM_LOCAL=1\n');

    expect(await readWorkerDefinitions({ cwd: root })).toEqual({ FROM_DOTENV: '.env', FROM_LOCAL: '.env.local' });
  });

  it('reads vars keys from wrangler.jsonc, comments and trailing commas included', async () => {
    await writeFile(join(root, 'wrangler.jsonc'), [
      '{',
      '  // the worker',
      '  "name": "api", /* inline */',
      '  "vars": { "APP_ENV": "dev", "URL": "http://a//b", },',
      '  "env": { "staging": { "vars": { "STAGING_URL": "x" } } },',
      '}',
    ].join('\n'));

    expect(await readWorkerDefinitions({ cwd: root })).toEqual({ APP_ENV: 'wrangler.jsonc', URL: 'wrangler.jsonc' });
    // Wrangler environments do not inherit `vars`; the named environment's own table is the one in force.
    expect(await readWorkerDefinitions({ cwd: root, environment: 'staging' })).toEqual({ STAGING_URL: 'wrangler.jsonc' });
  });

  it('reads [vars] from wrangler.toml, and an explicit config path relative to cwd', async () => {
    await mkdir(join(root, 'apps', 'api'), { recursive: true });
    await writeFile(join(root, 'apps', 'api', 'wrangler.toml'), 'name = "api"\n[vars]\nAPI_URL = "http://localhost:4001"\n');
    await writeFile(join(root, 'apps', 'api', '.dev.vars'), 'API_URL=http://localhost:4001\n');

    expect(await readWorkerDefinitions({ cwd: root, configPath: 'apps/api/wrangler.toml' }))
      .toEqual({ API_URL: 'apps/api/.dev.vars' });
  });

  it('answers with nothing, not an error, for a directory with no worker in it', async () => {
    await writeFile(join(root, 'wrangler.jsonc'), '{ not json');

    expect(await readWorkerDefinitions({ cwd: root })).toEqual({});
    expect(await readWorkerDefinitions({ cwd: join(root, 'missing') })).toEqual({});
  });
});

describe('analyzeWorkerEnvironment', () => {
  it('splits what WTM sets into forwarded, shadowed by the worker, and merely unreached', () => {
    expect(analyzeWorkerEnvironment({
      environmentNames: ['API_URL', 'CORS_ALLOWED_ORIGINS', 'FRONTEND_URL', 'WTM_ID', 'XDG_CONFIG_HOME'],
      forwarded: ['CORS_ALLOWED_ORIGINS'],
      definitions: { CORS_ALLOWED_ORIGINS: '.dev.vars', FRONTEND_URL: '.dev.vars', API_URL: 'wrangler.jsonc', SECRET: '.dev.vars' },
    })).toEqual({
      forwarded: ['CORS_ALLOWED_ORIGINS'],
      shadowed: [{ name: 'API_URL', file: 'wrangler.jsonc' }, { name: 'FRONTEND_URL', file: '.dev.vars' }],
      unreached: ['WTM_ID', 'XDG_CONFIG_HOME'],
    });
  });
});
