import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readEnvDeclarations } from '../declarations';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wtm-declarations-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const valueOf = (declarations: Awaited<ReturnType<typeof readEnvDeclarations>>, name: string) =>
  declarations.find((declaration) => declaration.name === name)?.value;

describe('environment declarations', () => {
  it('keeps a port and a loopback address, and drops everything else', async () => {
    await writeFile(join(root, '.env.example'), [
      'PORT=3000',
      'API_URL=http://localhost:4000/v1',
      'DATABASE_URL=postgres://user:hunter2@db.internal:5432/app',
      'SESSION_SECRET=please-change-me',
      'STRIPE_KEY=sk_live_abcdefghijklmnop',
    ].join('\n'));

    const declarations = await readEnvDeclarations(root);

    expect(valueOf(declarations, 'PORT')).toBe('3000');
    expect(valueOf(declarations, 'API_URL')).toBe('http://localhost:4000/v1');
    // A value WTM has no use for is a value it has no business carrying.
    expect(valueOf(declarations, 'DATABASE_URL')).toBeNull();
    expect(valueOf(declarations, 'SESSION_SECRET')).toBeNull();
    expect(valueOf(declarations, 'STRIPE_KEY')).toBeNull();
  });

  it('drops a query string, which is where a credential travels inside a URL', async () => {
    await writeFile(join(root, '.env.example'), 'API_URL=http://localhost:4000/v1?token=abcdef\n');

    expect(valueOf(await readEnvDeclarations(root), 'API_URL')).toBeNull();
  });

  it('reads the real .env for names only', async () => {
    await writeFile(join(root, '.env'), 'PORT=3000\nAPI_URL=http://localhost:4000\n');

    const declarations = await readEnvDeclarations(root);

    expect(declarations.map(({ name }) => name)).toEqual(['PORT', 'API_URL']);
    expect(declarations.every(({ value }) => value === null)).toBe(true);
  });

  it('prefers the example file when both declare the same variable', async () => {
    await writeFile(join(root, '.env.example'), 'PORT=3000\n');
    await writeFile(join(root, '.env'), 'PORT=9999\n');

    const declarations = await readEnvDeclarations(root);

    expect(declarations).toEqual([{ name: 'PORT', value: '3000', file: '.env.example' }]);
  });

  it('reads the commented-out and exported forms an example file uses', async () => {
    await writeFile(join(root, '.env.example'), [
      '# WEB_URL="http://localhost:5173"  # the dev server',
      'export PORT=8080',
      'NOT_A_DECLARATION',
    ].join('\n'));

    const declarations = await readEnvDeclarations(root);

    expect(declarations).toEqual([
      { name: 'WEB_URL', value: 'http://localhost:5173', file: '.env.example' },
      { name: 'PORT', value: '8080', file: '.env.example' },
    ]);
  });
});
