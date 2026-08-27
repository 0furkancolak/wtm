import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { AdapterContext } from '@wtm/protocol';

export interface AdapterFixture {
  context: AdapterContext;
  cleanup(): Promise<void>;
  snapshot(): Promise<Record<string, string>>;
}

export async function createAdapterFixture(entries: Record<string, string | null> = {}): Promise<AdapterFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'wtm-adapter-fixture-'));
  const workspaceRoot = join(temporaryRoot, 'workspace with spaces');
  const repositoryRoot = join(workspaceRoot, 'repository');

  await mkdir(repositoryRoot, { recursive: true });
  for (const [path, contents] of Object.entries(entries)) {
    const absolutePath = join(repositoryRoot, path);
    if (contents === null) {
      await mkdir(absolutePath, { recursive: true });
      continue;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }

  return {
    context: {
      workspace: { root: workspaceRoot },
      repository: { root: repositoryRoot, mainRoot: repositoryRoot },
      worktree: { root: repositoryRoot, id: 7, branch: 'feature/adapters' },
    },
    cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    snapshot: () => snapshotFiles(repositoryRoot),
  };
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  await visit(root, root, snapshot);
  return snapshot;
}

async function visit(root: string, directory: string, snapshot: Record<string, string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath);
    if (entry.isDirectory()) {
      snapshot[`${relativePath}/`] = '<directory>';
      await visit(root, absolutePath, snapshot);
    } else {
      snapshot[relativePath] = (await readFile(absolutePath)).toString('base64');
    }
  }
}
