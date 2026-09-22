import { describe, expect, test } from 'bun:test';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import type { DiskCommandResult } from '../../commands/disk';
import type { GcCommandResult } from '../../commands/gc';
import { buildTuiResourcesView } from '../resources-view';

const diskResult: DiskCommandResult = {
  measurement: { logical: 'file-length-sum', allocated: 'filesystem-block-allocation', reclaimable: 'not-estimated' },
  totals: { logicalBytes: 3_145_728, allocatedBytes: 4_194_304 },
  owned: { objects: 12, logicalBytes: 1_048_576, allocatedBytes: 1_048_576 },
  unknown: { objects: 1, logicalBytes: 2_097_152, allocatedBytes: 2_097_152 },
  worktree: { objects: 3, logicalBytes: 1_048_576, allocatedBytes: 1_048_576 },
};

function diskEnvelope(data: DiskCommandResult | null, errors: WtmError[] = []): JsonEnvelope<DiskCommandResult | null> {
  return errors.length === 0
    ? { schemaVersion: 1, ok: true, command: 'disk', data, warnings: [], errors: [] }
    : { schemaVersion: 1, ok: false, command: 'disk', data, warnings: [], errors: errors as [WtmError, ...WtmError[]] };
}

function gcEnvelope(data: GcCommandResult | null, errors: WtmError[] = []): JsonEnvelope<GcCommandResult | null> {
  return errors.length === 0
    ? { schemaVersion: 1, ok: true, command: 'gc', data, warnings: [], errors: [] }
    : { schemaVersion: 1, ok: false, command: 'gc', data, warnings: [], errors: errors as [WtmError, ...WtmError[]] };
}

describe('buildTuiResourcesView', () => {
  test('reshapes a successful disk + gc dry-run pair', () => {
    const gcResult: GcCommandResult = {
      mode: 'dry-run',
      planned: 1,
      excluded: 2,
      items: [{ storageObjectId: 'obj-1', path: '/registered/demo/.resources/cache-1', outcome: 'would-delete' }],
    };
    const view = buildTuiResourcesView({
      diskEnvelope: diskEnvelope(diskResult),
      gcEnvelope: gcEnvelope(gcResult),
      fetchedAt: '2026-09-22T00:00:00.000Z',
    });

    expect(view.fetchedAt).toBe('2026-09-22T00:00:00.000Z');
    expect(view.disk).toEqual({
      totals: { logicalBytes: 3_145_728, allocatedBytes: 4_194_304 },
      owned: { objects: 12, logicalBytes: 1_048_576, allocatedBytes: 1_048_576 },
      unknown: { objects: 1, logicalBytes: 2_097_152, allocatedBytes: 2_097_152 },
      worktree: { objects: 3, logicalBytes: 1_048_576, allocatedBytes: 1_048_576 },
    });
    expect(view.gc).toEqual({
      planned: 1,
      excluded: 2,
      items: [{ path: '/registered/demo/.resources/cache-1', outcome: 'would-delete' }],
    });
    expect(view.errors).toEqual([]);
  });

  test('carries a failed item\'s error message without dropping the other fields', () => {
    const gcResult: GcCommandResult = {
      mode: 'dry-run',
      planned: 1,
      excluded: 0,
      items: [{
        storageObjectId: 'obj-2',
        path: '/registered/demo/.resources/cache-2',
        outcome: 'failed',
        phase: 'validation',
        error: { code: 'RESOURCE_PATH_DENIED', message: 'The candidate path escaped its sandbox.' },
      }],
    };
    const view = buildTuiResourcesView({
      diskEnvelope: diskEnvelope(diskResult),
      gcEnvelope: gcEnvelope(gcResult),
      fetchedAt: '2026-09-22T00:00:00.000Z',
    });

    expect(view.gc?.items).toEqual([{
      path: '/registered/demo/.resources/cache-2',
      outcome: 'failed',
      message: 'The candidate path escaped its sandbox.',
    }]);
  });

  test('reports null disk/gc and surfaces envelope errors when resource state is unavailable', () => {
    const error = { code: 'WTM_NOT_INITIALIZED' as const, message: 'Resource lifecycle state is unavailable.', severity: 'error' as const };
    const view = buildTuiResourcesView({
      diskEnvelope: diskEnvelope(null, [error]),
      gcEnvelope: gcEnvelope(null, [error]),
      fetchedAt: '2026-09-22T00:00:00.000Z',
    });

    expect(view.disk).toBeNull();
    expect(view.gc).toBeNull();
    expect(view.errors).toEqual([error, error]);
  });

  test('an empty gc items list carries no candidates or exclusions, honestly', () => {
    const gcResult: GcCommandResult = { mode: 'dry-run', planned: 0, excluded: 0, items: [] };
    const view = buildTuiResourcesView({
      diskEnvelope: diskEnvelope(diskResult),
      gcEnvelope: gcEnvelope(gcResult),
      fetchedAt: '2026-09-22T00:00:00.000Z',
    });

    expect(view.gc).toEqual({ planned: 0, excluded: 0, items: [] });
  });
});
