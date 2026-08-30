import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContext } from '@wtm/protocol';
import { withAdapterTasks } from '../adapter-tasks';

async function worktree(files: Record<string, string>): Promise<{ context: AdapterContext; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-adapter-tasks-'));
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  return {
    context: {
      workspace: { root },
      repository: { root, mainRoot: root },
      worktree: { root, id: 0, branch: 'main' },
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe('adapter task merging', () => {
  it('offers a Makefile target as a task no wtm.toml declares', async () => {
    const fixture = await worktree({ Makefile: 'dev: ## Start the dev server\n\tbun run dev\n' });
    try {
      const config = await withAdapterTasks({}, fixture.context);

      expect(config.tasks?.['make:dev']).toEqual({
        description: 'Start the dev server',
        run: ['make', 'dev'],
        cwd: '{worktree.root}',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('lets the project keep its own definition of a name an adapter also claims', async () => {
    const fixture = await worktree({ Makefile: 'dev:\n\t@true\n' });
    try {
      const own = { run: ['bun', 'run', 'dev'] };
      const config = await withAdapterTasks({ tasks: { 'make:dev': own } }, fixture.context);

      expect(config.tasks?.['make:dev']).toEqual(own);
      expect(config.tasks?.['make']).toBeDefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns the configuration untouched when no adapter is detected', async () => {
    const fixture = await worktree({});
    try {
      const config = { tasks: { dev: { run: ['bun', 'run', 'dev'] } } };

      expect(await withAdapterTasks(config, fixture.context)).toBe(config);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps the project resolvable when detection cannot read the worktree', async () => {
    const config = { tasks: { dev: { run: ['bun', 'run', 'dev'] } } };
    const broken = {
      workspace: { root: '/nonexistent' },
      repository: { root: '/nonexistent', mainRoot: '/nonexistent' },
      worktree: { root: '', id: 0, branch: null },
    } as unknown as AdapterContext;

    expect(await withAdapterTasks(config, broken)).toBe(config);
  });
});
