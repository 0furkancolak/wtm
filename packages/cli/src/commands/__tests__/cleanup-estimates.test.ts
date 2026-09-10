import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureCleanupCandidates } from '../cleanup-estimates';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'wtm-cleanup-estimates-')); roots.push(root); return root; }

test('complete estimates exclude retained resource policies and preserve worktree data', async () => {
  const path = await fixture();
  const keep = join(path, 'retained'); const generated = join(path, 'generated');
  await writeFile(keep, Buffer.alloc(4096)); await writeFile(generated, Buffer.alloc(8192));
  const measurements = await measureCleanupCandidates([{ path, loadConfig: async () => ({
    config: { resources: { keep: { path: '{worktree.root}/retained', policy: 'shared' }, generated: { path: 'generated', policy: 'ephemeral' } } },
    context: { worktree: { root: path } },
  }) }]);
  expect(measurements.get(path)).toMatchObject({ status: 'complete', estimatedBytes: (await stat(generated)).blocks * 512, excluded: { policyPaths: 1 } });
  expect((await stat(keep)).size).toBe(4096);
});

test('entry and time budgets are shared by the entire report in deterministic path order', async () => {
  const root = await fixture();
  const paths = [join(root, 'b'), join(root, 'a')];
  for (const path of paths) await mkdir(path);
  const loaded: string[] = [];
  const candidates = paths.map((path) => ({ path, loadConfig: async () => { loaded.push(path); return { config: {}, context: {} }; } }));
  const entries = await measureCleanupCandidates(candidates, { maxEntries: 1 });
  expect(entries.get(paths[1]!)).toMatchObject({ status: 'complete', entries: 1, estimatedBytes: 0 });
  expect(entries.get(paths[0]!)).toMatchObject({ status: 'partial', reason: 'entry-budget', estimatedBytes: null });
  expect(loaded).toEqual([paths[1]!]);
  loaded.length = 0;
  const expired = await measureCleanupCandidates(candidates, { maxDurationMs: 0 });
  expect([...expired.values()].every((value) => value.status === 'partial' && value.reason === 'time-budget')).toBe(true);
  expect(loaded).toEqual([]);
});

test('configuration failures and unresolved resource templates never become a measured zero', async () => {
  const root = await fixture();
  const estimates = await measureCleanupCandidates([
    { path: join(root, 'a'), loadConfig: async () => { throw new Error('secret config path'); } },
    { path: join(root, 'b'), loadConfig: async () => ({ config: { resources: { keep: { path: '{env.SECRET}', policy: 'external' as const } } }, context: {} }) },
  ]);
  expect([...estimates.values()].every((value) => value.status === 'unavailable' && value.estimatedBytes === null)).toBe(true);
  expect(JSON.stringify([...estimates.values()])).not.toContain('secret');
});
