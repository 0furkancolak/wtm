import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { detectWorkspaceServices, type DetectedService } from '../service-detection';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wtm-detect-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function repository(name: string, files: Record<string, string>): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  for (const [file, contents] of Object.entries(files)) await writeFile(join(path, file), contents);
  return path;
}

const detect = (...roots: string[]) =>
  detectWorkspaceServices({ root, repositories: roots.map((path) => ({ root: path })) });

const named = (services: DetectedService[], name: string) =>
  services.find((service) => service.name === name);

describe('service detection', () => {
  it('reads a repository as the port it wants, the variable it wants it under, and its allowlist', async () => {
    const api = await repository('api', {
      '.env.example': 'PORT=4000\nCORS_ORIGINS=\nDATABASE_URL=postgres://localhost/app\n',
    });

    const [service] = (await detect(api)).services;

    expect(service?.name).toBe('api');
    expect(service?.path).toBe('api');
    expect(service?.port).toMatchObject({ env: 'PORT', preferred: 4000 });
    expect(service?.cors).toEqual(['CORS_ORIGINS']);
    expect(service?.port?.evidence).toEqual([{ file: 'api/.env.example', detail: 'PORT=' }]);
  });

  it('links a repository to the one whose port its address already names', async () => {
    const api = await repository('api', { '.env.example': 'PORT=4000\n' });
    const web = await repository('web', { '.env.example': 'VITE_API_URL=http://localhost:4000/v1\n' });

    const services = (await detect(api, web)).services;

    expect(named(services, 'web')?.links).toEqual([{
      variable: 'VITE_API_URL',
      target: 'api',
      template: 'http://localhost:{port.api}/v1',
      confidence: 'high',
      evidence: { file: 'web/.env.example', detail: 'VITE_API_URL=' },
    }]);
  });

  it('falls back to the variable name, and says that it guessed', async () => {
    const api = await repository('api', { '.env.example': 'PORT=4000\n' });
    // No port on the address, so nothing but the variable's own name points at the API.
    const web = await repository('web', { '.env.example': 'API_ORIGIN=http://localhost\n' });

    expect(named((await detect(api, web)).services, 'web')?.links).toEqual([{
      variable: 'API_ORIGIN',
      target: 'api',
      template: 'http://localhost:{port.api}',
      confidence: 'medium',
      evidence: { file: 'web/.env.example', detail: 'API_ORIGIN=' },
    }]);
  });

  it('does not link a repository to itself', async () => {
    const api = await repository('api', {
      '.env.example': 'PORT=4000\nSELF_URL=http://localhost:4000\n',
    });

    expect(named((await detect(api)).services, 'api')?.links).toEqual([]);
  });

  it('reads the port out of a dev script when nothing declares one', async () => {
    const web = await repository('web', {
      'package.json': JSON.stringify({ scripts: { dev: 'next dev -p 3000' } }),
    });

    expect(named((await detect(web)).services, 'web')?.port).toMatchObject({ env: null, preferred: 3000 });
  });

  it('reads compose for the ports it publishes and the services it points between', async () => {
    const stack = await repository('stack', {
      'compose.yaml': [
        'services:',
        '  stack:',
        '    ports:',
        '      - "8080:8080"',
        '  worker:',
        '    environment:',
        '      QUEUE_URL: http://stack:8080/queue',
      ].join('\n'),
    });

    const services = (await detect(stack)).services;

    expect(named(services, 'stack')?.port).toMatchObject({ preferred: 8080 });
    // The address names this repository's own service, so there is no second service to link to.
    expect(named(services, 'stack')?.links).toEqual([]);
  });

  it('takes the API repository over the web repository for the same directory name', async () => {
    const first = await repository('api', { '.env.example': 'PORT=4000\n' });
    await mkdir(join(root, 'vendor'), { recursive: true });
    const second = await repository(join('vendor', 'api'), { '.env.example': 'PORT=4001\n' });

    expect((await detect(first, second)).services.map(({ name }) => name)).toEqual(['api', 'api-2']);
  });

  it('says so when a repository publishes more applications than it can be given endpoints', async () => {
    const monorepo = await repository('monorepo', {
      'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
    });
    for (const application of ['api', 'web']) {
      await mkdir(join(monorepo, 'apps', application), { recursive: true });
      await writeFile(join(monorepo, 'apps', application, 'package.json'), '{}');
    }

    const [service] = (await detect(monorepo)).services;

    expect(service?.notes[0]).toContain('apps/api, apps/web');
    expect(service?.notes[0]).toContain('[ports.<name>]');
  });
});
