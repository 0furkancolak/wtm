import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import type { DiskCommandResult } from '../commands/disk';
import type { GcCommandResult } from '../commands/gc';

/**
 * The pure data-aggregation step for the disk-usage / cleanup-candidate panel (unit 2 of item 15).
 *
 * Like `view-model.ts`, this turns an existing stable envelope into a flat, TUI-shaped view —
 * here the envelopes `wtm disk --json` and `wtm gc --dry-run --json` already produce, built by
 * the exact same `runProductionDiskCommand`/`runProductionGcCommand` those two commands call
 * (`packages/cli/src/commands/resource-production.ts`). This module invents no second way to
 * gather the data; `loop.ts` only decides *when* to ask for it.
 *
 * `wtm gc --dry-run` never mutates anything — `applyGcPlan`'s dry-run branch only ever produces
 * `'would-delete'`/`'already-absent'`/`'failed'` items and returns before any lease, quarantine or
 * delete step runs (`packages/core/src/resources/gc.ts`) — so this panel is safe to poll on a
 * timer. The panel must still never be wired to `apply: true`; `main.ts` always calls it with
 * `apply: false`.
 *
 * On every real WTM install today, `gc.items` is legitimately empty: the sandbox/storage-object GC
 * tables' *write* path (registration) is connected only in tests, not on any production code path
 * (`docs/13-data-model-and-state-machines.md`'s "Resource GC state" section,
 * `docs/superpowers/plans/2026-09-21-release-readiness-audit.md`). That is a pre-existing gap in
 * the GC subsystem, not something this panel can or should paper over — `render.ts` says so
 * explicitly instead of showing a bare empty list that would read as "confirmed clean".
 */

export interface TuiDiskTotalsView {
  readonly logicalBytes: number;
  readonly allocatedBytes: number;
}

export interface TuiDiskSummaryView {
  readonly objects: number;
  readonly logicalBytes: number;
  readonly allocatedBytes: number;
}

export interface TuiDiskView {
  readonly totals: TuiDiskTotalsView;
  readonly owned: TuiDiskSummaryView;
  readonly unknown: TuiDiskSummaryView;
  /** Worktree-local `[resources]`, which `gc` never collects — see `docs/08`'s own section. */
  readonly worktree: TuiDiskSummaryView;
}

type TuiGcOutcome = GcCommandResult['items'][number]['outcome'];

export interface TuiGcItemView {
  readonly path: string;
  readonly outcome: TuiGcOutcome;
  /** Present only for `'failed'`/`'lease-contended'` items. */
  readonly message?: string;
}

export interface TuiGcView {
  readonly planned: number;
  readonly excluded: number;
  readonly items: readonly TuiGcItemView[];
}

export interface TuiResourcesView {
  readonly fetchedAt: string;
  /** `null` when `[resources]`/resource lifecycle state is unavailable (see `errors`). */
  readonly disk: TuiDiskView | null;
  readonly gc: TuiGcView | null;
  /** Envelope-level errors from either `disk` or the `gc` dry-run, surfaced verbatim. */
  readonly errors: readonly WtmError[];
}

/** What a resource fetch (`main.ts`'s `readResources`) hands back, before a timestamp is attached. */
export interface TuiResourceFetch {
  readonly diskEnvelope: JsonEnvelope<DiskCommandResult | null>;
  readonly gcEnvelope: JsonEnvelope<GcCommandResult | null>;
}

export interface TuiResourceSnapshot extends TuiResourceFetch {
  /** ISO timestamp of this fetch, supplied by the caller so the view stays deterministic. */
  readonly fetchedAt: string;
}

export function buildTuiResourcesView(snapshot: TuiResourceSnapshot): TuiResourcesView {
  const disk = snapshot.diskEnvelope.data;
  const gc = snapshot.gcEnvelope.data;
  return {
    fetchedAt: snapshot.fetchedAt,
    disk: disk === null ? null : {
      totals: { logicalBytes: disk.totals.logicalBytes, allocatedBytes: disk.totals.allocatedBytes },
      owned: { ...disk.owned },
      unknown: { ...disk.unknown },
      worktree: { ...disk.worktree },
    },
    gc: gc === null ? null : {
      planned: gc.planned,
      excluded: gc.excluded,
      items: gc.items.map((item) => ({
        path: item.path,
        outcome: item.outcome,
        ...('error' in item ? { message: item.error.message } : {}),
      })),
    },
    errors: [...snapshot.diskEnvelope.errors, ...snapshot.gcEnvelope.errors],
  };
}
