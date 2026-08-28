import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '../../../../testkit/src/fake-adapter';
import { runAdapterCommand } from '../adapter';

async function sqlitePersistence() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-command-'));
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  try {
    const databasePath = join(root, 'state.db');
    const trusted = await runAdapterCommand({
      action: 'trust', adapterId: 'fake', executablePath: adapter.executablePath, databasePath,
    });
    const listed = await runAdapterCommand({ action: 'list', databasePath });
    if (!trusted.ok || trusted.data === null || !('adapterId' in trusted.data) || !listed.ok || listed.data === null) {
      throw new Error('Adapter trust command unexpectedly failed');
    }
    const records = 'adapters' in listed.data ? listed.data.adapters : [];
    return {
      adapterId: trusted.data.adapterId,
      recordCount: records.length,
      sha256: trusted.data.sha256,
      trustedAtIsIso: !Number.isNaN(Date.parse(trusted.data.trustedAt)),
    };
  } finally {
    await adapter.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

async function concurrentTrust() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-command-'));
  const first = await createFakeAdapter({ type: 'response', response: {} });
  const second = await createFakeAdapter({ type: 'response', response: {} });
  try {
    const databasePath = join(root, 'state.db');
    const results = await Promise.all([
      runAdapterCommand({ action: 'trust', adapterId: 'first', executablePath: first.executablePath, databasePath }),
      runAdapterCommand({ action: 'trust', adapterId: 'second', executablePath: second.executablePath, databasePath }),
    ]);
    const listed = await runAdapterCommand({ action: 'list', databasePath });
    if (!results.every(({ ok }) => ok) || !listed.ok || listed.data === null || !('adapters' in listed.data)) {
      throw new Error('Concurrent adapter trust commands unexpectedly failed');
    }
    return { adapterIds: listed.data.adapters.map(({ adapterId }) => adapterId) };
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
    await rm(root, { recursive: true, force: true });
  }
}

async function createsMissingPrivateParent() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-command-'));
  try {
    const databasePath = join(root, 'missing', 'WTM', 'state.db');
    const listed = await runAdapterCommand({ action: 'list', databasePath });
    return {
      ok: listed.ok,
      databaseCreated: (await lstat(databasePath)).isFile(),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejectsUnsafePrivateParents() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-command-'));
  try {
    const insecure = join(root, 'insecure');
    await mkdir(insecure, { mode: 0o700 });
    await chmod(insecure, 0o755);
    const actual = join(root, 'actual');
    await mkdir(actual, { mode: 0o700 });
    const aliased = join(root, 'aliased');
    await symlink(actual, aliased);
    const [insecureMode, symlinkParent] = await Promise.all([
      runAdapterCommand({ action: 'list', databasePath: join(insecure, 'state.db') }),
      runAdapterCommand({ action: 'list', databasePath: join(aliased, 'state.db') }),
    ]);
    return {
      insecureMode: { ok: insecureMode.ok, code: insecureMode.errors[0]?.code },
      symlinkParent: { ok: symlinkParent.ok, code: symlinkParent.errors[0]?.code },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejectsNestedSymlinkAndParentReplacement() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-command-'));
  try {
    const actual = join(root, 'actual');
    const nested = join(actual, 'nested');
    await mkdir(nested, { recursive: true, mode: 0o700 });
    const alias = join(root, 'alias');
    await symlink(actual, alias);
    const parent = join(root, 'replacement-parent');
    await mkdir(parent, { mode: 0o700 });
    const [nestedSymlink, replacedParent] = await Promise.all([
      runAdapterCommand({ action: 'list', databasePath: join(alias, 'nested', 'state.db') }),
      runAdapterCommand({
        action: 'list', databasePath: join(parent, 'state.db'),
        async beforeDatabaseOpen() {
          await rename(parent, `${parent}.original`);
          await mkdir(parent, { mode: 0o700 });
        },
      }),
    ]);
    return {
      nestedSymlink: { ok: nestedSymlink.ok, code: nestedSymlink.errors[0]?.code },
      replacedParent: { ok: replacedParent.ok, code: replacedParent.errors[0]?.code },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const scenarios: Record<string, () => Promise<unknown>> = {
  'sqlite-persistence': sqlitePersistence,
  'concurrent-trust': concurrentTrust,
  'creates-missing-private-parent': createsMissingPrivateParent,
  'rejects-unsafe-private-parents': rejectsUnsafePrivateParents,
  'rejects-nested-symlink-and-parent-replacement': rejectsNestedSymlinkAndParentReplacement,
};

const scenario = scenarios[process.argv[2] ?? ''];
if (scenario === undefined) throw new Error('Unknown scenario');
process.stdout.write(`${JSON.stringify(await scenario())}\n`);
