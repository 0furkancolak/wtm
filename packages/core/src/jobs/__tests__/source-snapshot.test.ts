import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';
import { captureSourceSnapshot } from '../source-snapshot';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-job-source-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, '.git', 'isolated-global'), GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  await writeFile(join(root, 'source.ts'), 'export const n = 1;\n');
  await writeFile(join(root, '.gitignore'), 'ignored-output\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  return { root, git };
}

test('unchanged dirty sources match while tracked, index and untracked edits change evidence', async () => {
  const { root, git } = await fixture();
  const first = await captureSourceSnapshot(root);
  expect(await captureSourceSnapshot(root)).toEqual(first);
  await writeFile(join(root, 'source.ts'), 'export const n = 2;\n');
  const dirty = await captureSourceSnapshot(root);
  expect(dirty.fingerprint).not.toBe(first.fingerprint);
  expect((await captureSourceSnapshot(root)).fingerprint).toBe(dirty.fingerprint);
  git('add', 'source.ts');
  expect((await captureSourceSnapshot(root)).fingerprint).not.toBe(dirty.fingerprint);
  const staged = await captureSourceSnapshot(root);
  await writeFile(join(root, 'extra.ts'), 'export {};');
  expect((await captureSourceSnapshot(root)).fingerprint).not.toBe(staged.fingerprint);
});

test('rewriting original bytes is not silently treated as unchanged', async () => {
  const { root } = await fixture();
  const first = await captureSourceSnapshot(root);
  await writeFile(join(root, 'source.ts'), 'temporary edit');
  await writeFile(join(root, 'source.ts'), 'export const n = 1;\n');
  expect((await captureSourceSnapshot(root)).fingerprint).not.toBe(first.fingerprint);
});

test('bounds scanning and makes ignored input coverage explicit', async () => {
  const { root } = await fixture();
  const first = await captureSourceSnapshot(root);
  await writeFile(join(root, 'ignored-output'), 'generated');
  expect(await captureSourceSnapshot(root)).toEqual(first);
  expect(first.scope).toBe('git-tracked-and-untracked');
  await expect(captureSourceSnapshot(root, { maxFiles: 1 })).rejects.toThrow('budget');
  await expect(captureSourceSnapshot(root, { maxBytes: 1 })).rejects.toThrow('budget');
});

test('does not follow source symlinks outside the worktree', async () => {
  const { root } = await fixture();
  await symlink(join(root, 'source.ts'), join(root, 'linked.ts'));
  await expect(captureSourceSnapshot(root)).rejects.toThrow('symlink');
});

test('detects a parent swapped to a symlink and restored during file open', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./source-parent-race.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
