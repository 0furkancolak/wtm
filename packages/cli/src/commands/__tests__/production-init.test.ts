import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StateRegistrationReader, StateStore } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import { grantForeignDirectoryAccess } from '../../../../testkit/src/directory-access';
import { runProductionInitCommand } from '../init';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production init', () => {
  test('closes its production SQLite store after initialization', async () => {
    let closes = 0;
    const stateStore = {} as StateStore & StateRegistrationReader;
    const root = await temporaryRoot();

    const envelope = await runProductionInitCommand({
      root: '/project',
      userDataDir: '/user-data',
      databasePath: join(root, 'state', 'state.db'),
      installAiSkill: false,
    }, {
      openStateStore: () => ({ stateStore, close: () => { closes += 1; } }),
      runInit: async () => ({
        schemaVersion: 1,
        ok: true,
        command: 'init',
        scope: { mode: 'local' },
        data: null,
        warnings: [],
        errors: [],
      }),
    });

    expect(envelope.ok).toBe(true);
    expect(closes).toBe(1);
  });

  test('closes its store when initialization throws', async () => {
    let closes = 0;
    const root = await temporaryRoot();
    const operation = runProductionInitCommand({
      root: '/project',
      userDataDir: '/user-data',
      databasePath: join(root, 'state', 'state.db'),
    }, {
      openStateStore: () => ({ stateStore: {} as StateStore & StateRegistrationReader, close: () => { closes += 1; } }),
      runInit: async () => { throw new Error('init failure'); },
    });

    await expect(operation).rejects.toThrow('init failure');
    expect(closes).toBe(1);
  });

  test('establishes the user-state database parent as private without applying that policy to project skills', async () => {
    const root = await temporaryRoot();
    const stateParent = join(root, 'state');

    await runProductionInitCommand({
      root: '/ordinary-project',
      userDataDir: root,
      databasePath: join(stateParent, 'state.db'),
      installAiSkill: false,
    }, {
      openStateStore: () => ({ stateStore: {} as StateStore & StateRegistrationReader, close: () => {} }),
      runInit: async () => ({
        schemaVersion: 1,
        ok: true,
        command: 'init',
        scope: { mode: 'local' },
        data: null,
        warnings: [],
        errors: [],
      }),
    });

    expect((await stat(stateParent)).mode & 0o777).toBe(0o700);
  });

  test('reports an unsafe private state directory as an ok:false envelope, not a thrown rejection', async () => {
    const root = await temporaryRoot();
    const insecure = join(root, 'insecure');
    await mkdir(insecure, { mode: 0o700 });
    await grantForeignDirectoryAccess(insecure);

    const envelope = await runProductionInitCommand({
      root: '/project',
      userDataDir: '/user-data',
      databasePath: join(insecure, 'state.db'),
      installAiSkill: false,
      fileTrust: selectPlatformRuntime().fileTrust,
    }, {
      openStateStore: () => ({ stateStore: {} as StateStore & StateRegistrationReader, close: () => {} }),
      runInit: async () => { throw new Error('must not be reached: the private directory check should refuse first'); },
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]).toMatchObject({
      code: 'WTM_PRIVATE_DIRECTORY_UNSAFE',
      context: { command: 'init' },
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-production-init-'));
  roots.push(root);
  return root;
}
