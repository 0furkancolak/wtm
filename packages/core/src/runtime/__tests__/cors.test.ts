import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { detectCorsVariables, resolveCors } from '../cors';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wtm-cors-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('CORS variable detection', () => {
  it('reads the allowlist variable a repository declares', async () => {
    await writeFile(join(root, '.env.example'), [
      'DATABASE_URL=postgres://localhost/app',
      'CORS_ORIGIN=http://localhost:3000',
      'PORT=3000',
    ].join('\n'));

    expect(await detectCorsVariables(root)).toEqual(['CORS_ORIGIN']);
  });

  it('reads every conventional spelling, including behind a project prefix', async () => {
    await writeFile(join(root, '.env.example'), [
      'CORS_ORIGINS=',
      'CORS_ALLOWED_ORIGINS=',
      'ALLOWED_ORIGINS=',
      'APP_CORS_ORIGIN=',
      '# NEXT_PUBLIC_CORS_ORIGINS=',
    ].join('\n'));

    expect(await detectCorsVariables(root)).toEqual([
      'CORS_ORIGINS',
      'CORS_ALLOWED_ORIGINS',
      'ALLOWED_ORIGINS',
      'APP_CORS_ORIGIN',
      'NEXT_PUBLIC_CORS_ORIGINS',
    ]);
  });

  it('claims no variable a repository has not declared', async () => {
    await writeFile(join(root, '.env.example'), 'DATABASE_URL=\nALLOWED_HOSTS=\nORIGIN_SERVER=\n');

    expect(await detectCorsVariables(root)).toEqual([]);
  });

  it('detects nothing in a repository with no declaration files', async () => {
    expect(await detectCorsVariables(root)).toEqual([]);
  });
});

describe('CORS resolution', () => {
  it('fills the declared variable with the origins of this feature', async () => {
    await writeFile(join(root, '.env.example'), 'CORS_ORIGINS=\n');

    expect(await resolveCors({
      root,
      origins: ['http://localhost:4100', 'http://localhost:4200'],
    })).toEqual({
      value: 'http://localhost:4100,http://localhost:4200',
      variables: ['CORS_ORIGINS'],
    });
  });

  it('adds the origins the workspace asked for, without repeating one', async () => {
    await writeFile(join(root, '.env.example'), 'CORS_ORIGIN=\n');

    expect((await resolveCors({
      cors: { origins: ['https://app.example', 'http://localhost:4100'] },
      root,
      origins: ['http://localhost:4100'],
    })).value).toBe('http://localhost:4100,https://app.example');
  });

  it('publishes under the variables the workspace names instead of detecting any', async () => {
    await writeFile(join(root, '.env.example'), 'CORS_ORIGIN=\n');

    expect((await resolveCors({
      cors: { env: ['MY_ORIGINS'] },
      root,
      origins: ['http://localhost:4100'],
    })).variables).toEqual(['MY_ORIGINS']);
  });

  it('publishes nothing when the workspace turns detection off', async () => {
    await writeFile(join(root, '.env.example'), 'CORS_ORIGIN=\n');

    expect((await resolveCors({
      cors: { enabled: false },
      root,
      origins: ['http://localhost:4100'],
    })).variables).toEqual([]);
  });

  it('publishes nothing when the feature has no origins to allow', async () => {
    await writeFile(join(root, '.env.example'), 'CORS_ORIGIN=\n');

    expect(await resolveCors({ root, origins: [] })).toEqual({ value: '', variables: [] });
  });
});
