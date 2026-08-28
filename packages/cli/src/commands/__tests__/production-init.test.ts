import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StateStore } from '@wtm/core';
import { runProductionInitCommand } from '../init';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production init', () => {
  test('closes its production SQLite store after initialization', async () => {
    let closes = 0;
    const stateStore = {} as StateStore;
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
      openStateStore: () => ({ stateStore: {} as StateStore, close: () => { closes += 1; } }),
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
      openStateStore: () => ({ stateStore: {} as StateStore, close: () => {} }),
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
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-production-init-'));
  roots.push(root);
  return root;
}
