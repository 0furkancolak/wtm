import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStateStore, type GitWorktreeRecord } from '@wtm/core';
import { WtmDaemon } from '../main';
import { StructuralWatcher } from '../watcher';

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-edit-storm-')));
const repo = join(root, 'repo');
const gitDir = join(repo, '.git');
await mkdir(gitDir, { recursive: true });
const store = new SQLiteStateStore(join(root, 'state.db'));
const snapshot: GitWorktreeRecord[] = [{
  path: repo, head: '0'.repeat(40), branch: 'refs/heads/main', detached: false,
  bare: false, lockedReason: null, prunableReason: null,
}];
let listener!: (event: string, filename: string | Buffer | null) => void;
let scheduledSignals = 0;
let adapterDiscoveries = 0;
let adapterSpawns = 0;
try {
  const workspace = store.upsertWorkspace({ name: 'storm', root, scope: 'local', configPath: join(root, 'wtm.toml') });
  const repository = store.upsertRepository({ workspaceId: workspace.id, mainRoot: repo, commonGitDir: gitDir, remoteIdentity: null });
  store.reconcileWorktrees(repository.id, snapshot);
  const daemon = new WtmDaemon({
    stateStore: store,
    socketPath: join(root, 'wtmd.sock'),
    platform: 'darwin',
    nodeVersion: process.versions.node,
    listGitWorktrees: async () => snapshot,
    adapterDiscovery: async () => { adapterDiscoveries += 1; adapterSpawns += 1; },
    watcherFactory: (registrations, schedule) => new StructuralWatcher({
      registrations,
      schedule: (signal) => { scheduledSignals += 1; schedule(signal); },
      fingerprint: async () => 'stable',
      watchFactory: (watchedRoot, _options, captured) => {
        if (watchedRoot === repo) listener = captured;
        return { close() {}, onError: () => () => {} };
      },
    }),
    serverFactory: () => ({ start: async () => {}, close: async () => {} }),
  });
  await daemon.start();
  try {
    for (let index = 0; index < 1_000; index += 1) listener('change', `src/module-${index}.ts`);
    await daemon.flush();
  } finally {
    await daemon.close();
  }
  process.stdout.write(JSON.stringify({
    path: 'WtmDaemon -> StructuralWatcher -> adapterDiscovery',
    edits: 1_000,
    scheduledSignals,
    adapterDiscoveries,
    adapterSpawns,
    status: scheduledSignals === 0 && adapterDiscoveries === 0 && adapterSpawns === 0 ? 'pass' : 'blocker',
  }));
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
