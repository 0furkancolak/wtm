import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { ManagedLogStore } from '../logs';
import { ManagedProcessSupervisor } from '../process-supervisor';
import { MemoryManagedProcessStore } from '../../../testkit/src/managed-process-store';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('process anchor runtime invocation', () => {
  test('starts and stops through the injected executable without resolving a runtime from PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-anchor-runtime-'));
    const commands = join(root, 'commands');
    await mkdir(commands);
    await symlink('/bin/ps', join(commands, 'ps'));
    const task = join(commands, 'fixture-task');
    await writeFile(task, '#!/bin/sh\nexec /bin/sleep 30\n');
    await chmod(task, 0o700);
    const store = new MemoryManagedProcessStore();
    const supervisor = new ManagedProcessSupervisor({
      stateStore: store,
      logs: new ManagedLogStore({ root: join(root, 'logs') }),
      pollIntervalMs: 10,
      runtimeInvocation: developmentRuntimeInvocation(),
    });
    cleanups.push(async () => {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    });

    const started = await supervisor.start({
      worktreeId: 'worktree-1',
      taskName: 'fixture',
      argv: ['fixture-task'],
      cwd: root,
      env: { PATH: commands },
    });

    expect(started.record.state).toBe('RUNNING');
    expect((await supervisor.stop({ worktreeId: 'worktree-1', taskName: 'fixture' })).state).toBe('STOPPED');
  });
});
