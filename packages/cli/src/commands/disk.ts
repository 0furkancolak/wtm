import { relative, resolve, sep } from 'node:path';
import type { GcEvidence, ResourceSandboxIdentity } from '@wtm/core';
import type { JsonEnvelope } from '@wtm/protocol';

export interface DiskCommandInput {
  sandbox?: ResourceSandboxIdentity;
  sandboxes?: readonly ResourceSandboxIdentity[];
  records: readonly GcEvidence[];
  workspaceId?: string;
  /**
   * What the `[resources]` table put inside this worktree. These live in a Git working tree,
   * which is never a resource sandbox and never swept, so they carry no lifecycle record —
   * and the report they were left out of was the one that says how much disk WTM is using.
   */
  worktree?: DiskUsageSummary;
}

export interface DiskUsageSummary {
  objects: number;
  logicalBytes: number;
  allocatedBytes: number;
}

export interface DiskCommandResult {
  measurement: {
    logical: 'file-length-sum';
    allocated: 'filesystem-block-allocation';
    reclaimable: 'not-estimated';
  };
  totals: Omit<DiskUsageSummary, 'objects'>;
  owned: DiskUsageSummary;
  unknown: DiskUsageSummary;
  /** Worktree-local resources, which `wtm gc` never collects: removing the worktree does. */
  worktree: DiskUsageSummary;
}

export type DiskCommandEnvelope = JsonEnvelope<DiskCommandResult>;

export async function runDiskCommand(input: DiskCommandInput): Promise<DiskCommandEnvelope> {
  const sandboxes = input.sandboxes ?? (input.sandbox === undefined ? [] : [input.sandbox]);
  const matching = input.records.filter((record) => record.state !== 'REMOVED' &&
    sandboxes.some((sandbox) => record.sandboxId === sandbox.id
      && record.sandboxGeneration === sandbox.generation
      && resolve(record.sandboxRoot) === resolve(sandbox.root)
      && containsStrict(sandbox.root, record.path)));
  const owned = summarize(matching.filter((record) => record.owned));
  const unknown = summarize(matching.filter((record) => !record.owned));
  const worktree = input.worktree ?? { objects: 0, logicalBytes: 0, allocatedBytes: 0 };
  return {
    schemaVersion: 1,
    ok: true,
    command: 'disk',
    scope: { mode: 'local', ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }) },
    data: {
      measurement: {
        logical: 'file-length-sum',
        allocated: 'filesystem-block-allocation',
        reclaimable: 'not-estimated',
      },
      totals: {
        logicalBytes: owned.logicalBytes + unknown.logicalBytes + worktree.logicalBytes,
        allocatedBytes: owned.allocatedBytes + unknown.allocatedBytes + worktree.allocatedBytes,
      },
      owned,
      unknown,
      worktree,
    },
    warnings: [],
    errors: [],
  };
}

function summarize(records: readonly GcEvidence[]): DiskUsageSummary {
  return records.reduce<DiskUsageSummary>((summary, record) => ({
    objects: summary.objects + 1,
    logicalBytes: summary.logicalBytes + record.logicalBytes,
    allocatedBytes: summary.allocatedBytes + record.allocatedBytes,
  }), { objects: 0, logicalBytes: 0, allocatedBytes: 0 });
}

function containsStrict(root: string, candidate: string): boolean {
  const nested = relative(resolve(root), resolve(candidate));
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !nested.startsWith(sep);
}
