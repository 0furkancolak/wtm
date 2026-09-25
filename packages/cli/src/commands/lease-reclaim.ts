import { probeEndpoint, type EndpointCandidate, type SQLiteStateStore, type WorktreeRecord } from '@wtm/core';

/**
 * One feature's leased ports that no managed task of it has ever used.
 *
 * - `reclaimable`: a dry run would give them back.
 * - `released`: `--apply` gave them back.
 * - `in-use`: something listens on one of them that no managed task accounts for (a foreground
 *   `wtm run`, or a server started from `eval "$(wtm env)"`), so every port of the feature stays.
 * - `started`: a task of the feature recorded a run between planning and releasing; they stay.
 */
export interface LeaseReclaimGroup {
  branch: string | null;
  worktrees: string[];
  endpoints: Array<{ name: string; port: number }>;
  outcome: 'reclaimable' | 'released' | 'in-use' | 'started';
}

/**
 * The ports `wtm gc` can give back: those of a feature -- one branch across the workspace's
 * repositories -- none of whose worktrees has ever run a managed task.
 *
 * Reports used to lease every `[ports.*]` endpoint of a feature just by being asked about it, so
 * a worktree nobody started held ports for as long as it existed. A feature that has run a task
 * keeps its leases, however long ago that was: "every repository of a feature sees the same
 * `{port.x}`" is a promise to whatever was configured with those ports. Giving back a never-used
 * feature's ports costs nothing but a different number on its first start.
 */
export async function reclaimNeverStartedLeases(input: {
  store: SQLiteStateStore;
  workspaceId: string;
  apply: boolean;
  now: string;
  isAvailable?: (candidate: EndpointCandidate) => Promise<boolean>;
}): Promise<LeaseReclaimGroup[]> {
  const isAvailable = input.isAvailable ?? probeEndpoint;
  const repositories = new Set(input.store.listRepositories(input.workspaceId).map(({ id }) => id));
  const groups = new Map<string, WorktreeRecord[]>();
  for (const worktree of input.store.listWorktrees()) {
    if (!repositories.has(worktree.repositoryId)) continue;
    const key = worktree.branch === null ? `worktree:${worktree.id}` : `branch:${worktree.branch}`;
    groups.set(key, [...groups.get(key) ?? [], worktree]);
  }

  const report: LeaseReclaimGroup[] = [];
  for (const members of groups.values()) {
    const worktreeIds = members.map(({ id }) => id);
    const leases = input.store.listEndpointLeases({ worktreeIds, states: ['ACTIVE'] });
    if (leases.length === 0) continue;
    if (worktreeIds.some((worktreeId) => input.store.listManagedProcesses({ worktreeId }).length > 0)) continue;
    const group = {
      branch: displayBranch(members[0]!.branch),
      worktrees: members.map(({ path }) => path).sort(),
      endpoints: leases.map(({ name, port }) => ({ name, port }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
    const free = await Promise.all(leases.map(async ({ protocol, host, port }) => await isAvailable({ protocol, host, port })));
    if (free.includes(false)) {
      report.push({ ...group, outcome: 'in-use' });
      continue;
    }
    if (!input.apply) {
      report.push({ ...group, outcome: 'reclaimable' });
      continue;
    }
    const released = input.store.releaseNeverStartedEndpointLeases(worktreeIds, input.now);
    report.push({ ...group, outcome: released === null ? 'started' : 'released' });
  }
  return report.sort((left, right) => (left.branch ?? '').localeCompare(right.branch ?? ''));
}

function displayBranch(branch: string | null): string | null {
  return branch?.replace(/^refs\/heads\//, '') ?? null;
}
