import { afterEach, describe, expect, it, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CiProvider,
  DaemonStateStore,
  EndpointLease,
  EndpointLeaseQuery,
  ManagedProcessRecord,
  RepositoryRecord,
  WorkspaceRecord,
  WorktreeRecord,
} from '@wtm/core';
import { selectPlatformRuntime, UnsupportedPlatformError } from '@wtm/platform';
import { daemonSocketFileName, publishedDaemonSocketPath } from '@wtm/platform/socket';
import { inspectProcessIdentity } from '@wtm/daemon';
import type { ServicePaths } from '@wtm/daemon/service-lifecycle';
import { daemonStatusFileName, nextDaemonStatus, writeDaemonStatus } from '../daemon-status';
import { doctorChecks, runDoctorCommand } from '../diagnostics';
import { createStateDiagnosticDataSource } from '../state-diagnostics';

const workspace: WorkspaceRecord = {
  id: 'workspace-1',
  name: 'workspace',
  root: '/workspace',
  scope: 'local',
  configPath: '/workspace/wtm.toml',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
};

const repositories: RepositoryRecord[] = [
  { id: 'api', workspaceId: 'workspace-1', commonGitDir: '/workspace/api/.git', mainRoot: '/workspace/api', remoteIdentity: null, createdAt: '2026-01-01T00:00:00.000Z', lastReconciledAt: null },
  { id: 'web', workspaceId: 'workspace-1', commonGitDir: '/workspace/web/.git', mainRoot: '/workspace/web', remoteIdentity: null, createdAt: '2026-01-01T00:00:00.000Z', lastReconciledAt: null },
];

function worktree(id: string, repositoryId: string, path: string, numericId: number): WorktreeRecord {
  return {
    id,
    repositoryId,
    numericId,
    path,
    branch: 'refs/heads/main',
    headOid: '0'.repeat(40),
    isMain: numericId === 1,
    isLocked: false,
    state: 'DISCOVERED',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    lastRuntimeAt: null,
  };
}

const worktrees = [
  worktree('api-main', 'api', '/workspace/api', 1),
  worktree('web-feature', 'web', '/workspace/web-feature', 2),
];

const leases: EndpointLease[] = [
  { id: 'lease-1', worktreeId: 'web-feature', name: 'web', protocol: 'tcp', host: '127.0.0.1', port: 4200, state: 'ACTIVE', allocatedAt: '2026-01-01T00:00:00.000Z', lastVerifiedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'lease-2', worktreeId: 'api-main', name: 'api', protocol: 'tcp', host: '127.0.0.1', port: 4100, state: 'ACTIVE', allocatedAt: '2026-01-01T00:00:00.000Z', lastVerifiedAt: '2026-01-01T00:00:00.000Z' },
];

const store = {
  listWorkspaces: () => [workspace],
  listRepositories: (workspaceId?: string) =>
    repositories.filter((repository) => workspaceId === undefined || repository.workspaceId === workspaceId),
  listWorktrees: (repositoryId?: string) =>
    worktrees.filter((record) => repositoryId === undefined || record.repositoryId === repositoryId),
  listManagedProcesses: () => [],
  listEndpointLeases: (query: EndpointLeaseQuery = {}) => leases.filter((lease) =>
    (query.worktreeIds === undefined || query.worktreeIds.includes(lease.worktreeId))
    && (query.states === undefined || query.states.includes(lease.state))),
} as unknown as DaemonStateStore;

const sourceAt = (cwd: string) => createStateDiagnosticDataSource(store, {
  cwd,
  globalConfigPath: '/workspace/config.toml',
});

const registered = { id: workspace.id, name: workspace.name, root: workspace.root, scope: workspace.scope } as const;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('registry-backed diagnostics', () => {
  it('answers for the worktree the command was run in', async () => {
    // Reporting the first registered worktree meant standing in one repository and reading
    // another repository's state back.
    const status = await sourceAt('/workspace/web-feature/src').readStatus(registered);

    expect(status.identity.worktreeId).toBe('web-feature');
    expect(status.identity.path).toBe('/workspace/web-feature');
  });

  it('shows the endpoints of the feature that worktree belongs to', async () => {
    const status = await sourceAt('/workspace/web-feature').readStatus(registered);

    // The API's port is leased against the API's worktree, and is still this feature's port.
    expect(status.endpoints.map(({ name, port }) => [name, port]).sort())
      .toEqual([['api', 4100], ['web', 4200]]);
  });

  it('answers about no worktree, rather than another one, outside every worktree', async () => {
    // Substituting a worktree is how `wtm status` inside a brand-new feature branch — one the
    // daemon has not read yet — reported `main`: its branch, its state, its ports, with
    // nothing to say the answer was about somewhere else.
    const { identity, state } = await sourceAt('/elsewhere').readStatus(registered);

    expect({ worktreeId: identity.worktreeId, branch: identity.branch, state })
      .toEqual({ worktreeId: null, branch: null, state: 'UNKNOWN' });
  });

  it('lists every endpoint the workspace holds, across its repositories', async () => {
    const ports = await sourceAt('/workspace/web-feature').readPorts(registered);

    expect(ports.leases.map(({ name, port }) => [name, port]).sort())
      .toEqual([['api', 4100], ['web', 4200]]);
  });

  it('answers explain/plan/env with nothing, rather than throwing, outside every worktree', async () => {
    // `readStatus` already falls back to "no worktree" outside every registered worktree
    // (see above). `readExplain`/`readPlan`/`readEnv` used to resolve unconditionally from
    // `options.cwd`, which meant a `--global` command run from a workspace root -- registered,
    // but not itself inside any worktree -- threw `WTM_WORKSPACE_NOT_FOUND` for every workspace,
    // even ones whose own worktree `status`/`doctor`/`ports` answered from just fine.
    const source = sourceAt('/elsewhere');

    await expect(source.readExplain(registered)).resolves.toEqual({ workspace: registered, decisions: [] });
    await expect(source.readPlan(registered)).resolves.toEqual({ workspace: registered, changes: [] });
    await expect(source.readEnv(registered)).resolves.toEqual({ workspace: registered, variables: {} });
  });

  describe('--global explain/plan/env answer per workspace, not per cwd', () => {
    // `readExplain`/`readPlan`/`readEnv` used to resolve from `options.cwd` regardless of which
    // workspace they were asked about, so a `--global` walk over several workspaces reported the
    // *first* workspace's decisions/plan/environment again under every other workspace's name.
    // `readStatus` already avoids this (`currentWorktree(workspace.id)`, tested above); these
    // assert the other three now do too.
    async function twoWorkspaceFixture() {
      const root = mkdtempSync(join(tmpdir(), 'wtm-global-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, 'a/repo'), { recursive: true });
      mkdirSync(join(root, 'b/repo'), { recursive: true });

      const workspaceA: WorkspaceRecord = { ...workspace, id: 'workspace-a', name: 'a', root: join(root, 'a'), configPath: null };
      const workspaceB: WorkspaceRecord = { ...workspace, id: 'workspace-b', name: 'b', root: join(root, 'b'), configPath: null };
      const repoA: RepositoryRecord = {
        ...repositories[0] as RepositoryRecord, id: 'repo-a', workspaceId: 'workspace-a',
        commonGitDir: join(root, 'a/repo/.git'), mainRoot: join(root, 'a/repo'),
      };
      const repoB: RepositoryRecord = {
        ...repositories[0] as RepositoryRecord, id: 'repo-b', workspaceId: 'workspace-b',
        commonGitDir: join(root, 'b/repo/.git'), mainRoot: join(root, 'b/repo'),
      };
      const worktreeA = worktree('worktree-a', 'repo-a', join(root, 'a/repo'), 1);
      const worktreeB = worktree('worktree-b', 'repo-b', join(root, 'b/repo'), 1);
      const twoWorkspaceStore = {
        listWorkspaces: () => [workspaceA, workspaceB],
        listRepositories: (workspaceId?: string) => [repoA, repoB]
          .filter((repository) => workspaceId === undefined || repository.workspaceId === workspaceId),
        listWorktrees: (repositoryId?: string) => [worktreeA, worktreeB]
          .filter((record) => repositoryId === undefined || record.repositoryId === repositoryId),
        listManagedProcesses: () => [],
        listEndpointLeases: () => [],
      } as unknown as DaemonStateStore;

      const registeredA = { id: workspaceA.id, name: workspaceA.name, root: workspaceA.root, scope: workspaceA.scope } as const;
      const registeredB = { id: workspaceB.id, name: workspaceB.name, root: workspaceB.root, scope: workspaceB.scope } as const;
      // Standing in workspace A's own worktree, as a `--global` walk's `cwd` would be fixed at
      // whichever worktree the command actually ran from.
      const source = createStateDiagnosticDataSource(twoWorkspaceStore, {
        cwd: join(root, 'a/repo'),
        globalConfigPath: join(root, 'config.toml'),
      });
      return { source, registeredA, registeredB };
    }

    it('does not report the running workspace\'s decisions under another workspace\'s name', async () => {
      const { source, registeredA, registeredB } = await twoWorkspaceFixture();

      const explainA = await source.readExplain(registeredA);
      const explainB = await source.readExplain(registeredB);

      // A's own worktree is where the command runs, so A resolves normally.
      expect(explainA.workspace).toEqual(registeredA);
      // B has no worktree at A's cwd: it must not receive A's decisions relabeled as its own.
      expect(explainB).toEqual({ workspace: registeredB, decisions: [] });
    });

    it('does the same for plan and env', async () => {
      const { source, registeredB } = await twoWorkspaceFixture();

      await expect(source.readPlan(registeredB)).resolves.toEqual({ workspace: registeredB, changes: [] });
      await expect(source.readEnv(registeredB)).resolves.toEqual({ workspace: registeredB, variables: {} });
    });

    it('does not leak the running workspace\'s registration/adapters/resources into another workspace\'s doctor report', async () => {
      // `readDoctor`'s `registration`/`adapters`/`resources` checks resolved from `options.cwd`
      // regardless of which workspace `diagnose` was asked about -- the same bug class as
      // explain/plan/env above, just found later. A `--global wtm doctor` walk reported A's own
      // adapters and declared resources under B's name too, and reported B as "registered, daemon
      // answering" even though B's own worktree has nothing to do with where the command ran.
      const { source, registeredA, registeredB } = await twoWorkspaceFixture();

      const doctorA = await source.readDoctor(registeredA);
      const doctorB = await source.readDoctor(registeredB);

      // A's own worktree is where the command runs, so A's checks resolve normally. Registration
      // reports `registered: true` either way -- whether the daemon itself answers in this test
      // environment is a separate fact this test does not depend on.
      expect(doctorA.findings.find(({ check }) => check === 'registration')).toMatchObject({ details: { registered: true } });
      expect(doctorA.findings.find(({ check }) => check === 'adapters')).toMatchObject({ status: 'pass' });
      expect(doctorA.findings.find(({ check }) => check === 'resources')).toMatchObject({ status: 'pass' });

      // B has no worktree at A's cwd: it must not receive A's registration/adapters/resources
      // relabeled as its own.
      expect(doctorB.findings.find(({ check }) => check === 'registration')).toMatchObject({ status: 'unknown' });
      expect(doctorB.findings.find(({ check }) => check === 'adapters')).toMatchObject({ status: 'unknown' });
      expect(doctorB.findings.find(({ check }) => check === 'resources')).toMatchObject({ status: 'unknown' });
    });
  });

  describe('doctor for a workspace whose own worktree contains a nested, separately registered workspace', () => {
    // The sibling case above is guarded by `current === undefined`: a workspace whose own
    // worktree does not contain `cwd` at all gets `unknown`. That guard does nothing when B's
    // repository is nested *inside* A's worktree (a vendored/nested git repository, its own
    // `wtm init`) and `cwd` sits inside both: `current` is non-undefined for A too (A's own
    // worktree does contain `cwd`), so `adapterFinding`/`resourceFinding` proceed -- but they
    // resolve via `findRegistration(store, options.cwd)`, an unscoped search across every
    // registered worktree that always prefers the deepest path match. That is always B's nested
    // worktree, never A's own, so A's doctor report silently describes B's adapters/resources
    // under A's name instead of A's.
    async function nestedWorkspaceFixture() {
      const root = mkdtempSync(join(tmpdir(), 'wtm-nested-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const outerRoot = join(root, 'outer/repo');
      const innerRoot = join(outerRoot, 'vendor/nested');
      mkdirSync(innerRoot, { recursive: true });
      // Only the nested repository looks like a Cargo project. If A's own doctor ever reports
      // cargo in force, it can only be because it resolved B's registration instead of its own.
      writeFileSync(join(innerRoot, 'Cargo.toml'), '[package]\nname = "nested"\n');

      const workspaceA: WorkspaceRecord = { ...workspace, id: 'workspace-outer', name: 'outer', root: join(root, 'outer'), configPath: null };
      const workspaceB: WorkspaceRecord = { ...workspace, id: 'workspace-inner', name: 'inner', root: innerRoot, configPath: null };
      const repoA: RepositoryRecord = {
        ...repositories[0] as RepositoryRecord, id: 'repo-outer', workspaceId: 'workspace-outer',
        commonGitDir: join(outerRoot, '.git'), mainRoot: outerRoot,
      };
      const repoB: RepositoryRecord = {
        ...repositories[0] as RepositoryRecord, id: 'repo-inner', workspaceId: 'workspace-inner',
        commonGitDir: join(innerRoot, '.git'), mainRoot: innerRoot,
      };
      const worktreeA = worktree('worktree-outer', 'repo-outer', outerRoot, 1);
      const worktreeB = worktree('worktree-inner', 'repo-inner', innerRoot, 1);
      const nestedStore = {
        listWorkspaces: () => [workspaceA, workspaceB],
        listRepositories: (workspaceId?: string) => [repoA, repoB]
          .filter((repository) => workspaceId === undefined || repository.workspaceId === workspaceId),
        listWorktrees: (repositoryId?: string) => [worktreeA, worktreeB]
          .filter((record) => repositoryId === undefined || record.repositoryId === repositoryId),
        listManagedProcesses: () => [],
        listEndpointLeases: () => [],
      } as unknown as DaemonStateStore;

      const registeredA = { id: workspaceA.id, name: workspaceA.name, root: workspaceA.root, scope: workspaceA.scope } as const;
      // `cwd` is inside both worktrees -- inside B's own root exactly, and inside A's because B
      // is nested under it.
      const source = createStateDiagnosticDataSource(nestedStore, {
        cwd: innerRoot,
        globalConfigPath: join(root, 'config.toml'),
      });
      return { source, registeredA };
    }

    it('reports the outer workspace\'s own adapters, not the nested workspace\'s', async () => {
      const { source, registeredA } = await nestedWorkspaceFixture();

      const doctorA = await source.readDoctor(registeredA);

      const adapters = doctorA.findings.find(({ check }) => check === 'adapters');
      expect(adapters).toMatchObject({
        status: 'pass',
        message: 'No built-in adapter recognizes this worktree; only configured tasks are available.',
      });
    });
  });
});

describe('wtm status --pr', () => {
  const prWorkspace: WorkspaceRecord = { ...workspace, id: 'ws-pr', name: 'pr-workspace', root: '/pr-workspace' };
  const prRegistered = { id: prWorkspace.id, name: prWorkspace.name, root: prWorkspace.root, scope: prWorkspace.scope } as const;

  function sourceWithRemote(remoteIdentity: string | null, provider: CiProvider) {
    const repository: RepositoryRecord = {
      id: 'pr-repo', workspaceId: prWorkspace.id, commonGitDir: '/pr-workspace/app/.git', mainRoot: '/pr-workspace/app',
      remoteIdentity, createdAt: '2026-01-01T00:00:00.000Z', lastReconciledAt: null,
    };
    const prStore = {
      listWorkspaces: () => [prWorkspace],
      listRepositories: () => [repository],
      listWorktrees: () => [worktree('pr-worktree', repository.id, '/pr-workspace/app', 1)],
      listManagedProcesses: () => [],
      listEndpointLeases: () => [],
    } as unknown as DaemonStateStore;
    return createStateDiagnosticDataSource(prStore, {
      cwd: '/pr-workspace/app',
      globalConfigPath: '/pr-workspace/config.toml',
      ciProvider: () => provider,
    });
  }

  const unusedProvider: CiProvider = {
    name: 'github',
    checkAvailable: async () => { throw new Error('must not be called without --pr'); },
    findPr: async () => { throw new Error('must not be called without --pr'); },
    listRuns: async () => { throw new Error('must not be called without --pr'); },
    listJobs: async () => { throw new Error('must not be called without --pr'); },
    failedJobLog: async () => { throw new Error('must not be called without --pr'); },
  };

  it('omits the pr field entirely, and never calls the provider, without the flag', async () => {
    const status = await sourceWithRemote('git@github.com:acme/widgets.git', unusedProvider).readStatus(prRegistered);
    expect(status.pr).toBeUndefined();
  });

  it('reports the PR and its rolled-up checks when the branch has one', async () => {
    const provider: CiProvider = {
      ...unusedProvider,
      findPr: async () => ({ ok: true, value: { number: 7, url: 'https://github.com/acme/widgets/pull/7', state: 'open', mergeable: 'mergeable' } }),
      listRuns: async () => ({ ok: true, value: [{ runId: 1, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'success', url: 'https://x/1', jobs: [] }] }),
    };
    const status = await sourceWithRemote('git@github.com:acme/widgets.git', provider).readStatus(prRegistered, { pr: true });
    expect(status.pr).toEqual({
      summary: { number: 7, url: 'https://github.com/acme/widgets/pull/7', state: 'open', mergeable: 'mergeable', checks: 'success' },
    });
  });

  it('reports summary: null, no detail, when the branch simply has no PR', async () => {
    const provider: CiProvider = { ...unusedProvider, findPr: async () => ({ ok: true, value: null }) };
    const status = await sourceWithRemote('git@github.com:acme/widgets.git', provider).readStatus(prRegistered, { pr: true });
    expect(status.pr).toEqual({ summary: null });
  });

  it('reports a detail instead of failing the command when gh is unavailable', async () => {
    const provider: CiProvider = {
      ...unusedProvider,
      findPr: async () => ({ ok: false, failure: { kind: 'unavailable', reason: 'missing', detail: 'The GitHub CLI (gh) was not found.' } }),
    };
    const status = await sourceWithRemote('git@github.com:acme/widgets.git', provider).readStatus(prRegistered, { pr: true });
    expect(status.pr).toEqual({ summary: null, detail: 'The GitHub CLI (gh) was not found.' });
  });

  it('reports a detail when the repository has no supported CI provider remote', async () => {
    const status = await sourceWithRemote(null, unusedProvider).readStatus(prRegistered, { pr: true });
    expect(status.pr).toMatchObject({ summary: null });
    expect(status.pr?.detail).toBeDefined();
  });
});

describe('doctor', () => {
  it('says which registered repositories are no longer on disk', async () => {
    // The finding that would have explained a daemon that refused to start at all.
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    // /workspace/web-feature -- worktreeB, linked -- is also absent from the real filesystem
    // here, and is now flagged too (see the two tests below): 2 missing repository roots plus
    // that 1 missing linked worktree.
    expect(findings.find(({ check }) => check === 'git')).toEqual({
      check: 'git',
      status: 'error',
      message: '3 registered paths no longer on disk, starting with /workspace/api. '
        + 'WTM keeps serving the rest; the registration returns on its own if the directory comes back.',
      details: { registered: 2, unavailable: 3, missingWorktrees: 1 },
    });
  });

  it('flags a linked worktree directory that vanished outside WTM\'s own remove, not just a missing repository root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-doctor-worktree-'));
    try {
      mkdirSync(join(root, 'main'), { recursive: true });
      const findings = await doctorWithLinkedWorktree(root, 'DISCOVERED');

      expect(findings.find(({ check }) => check === 'git')).toMatchObject({
        status: 'error',
        details: { missingWorktrees: 1 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not flag a linked worktree already known settled-absent (ORPHANED/REMOVED)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-doctor-worktree-settled-'));
    try {
      mkdirSync(join(root, 'main'), { recursive: true });
      for (const state of ['ORPHANED', 'REMOVED'] as const) {
        const findings = await doctorWithLinkedWorktree(root, state);
        expect(findings.find(({ check }) => check === 'git')).toMatchObject({
          status: 'pass',
          details: { missingWorktrees: 0 },
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a RUNNING record whose live process no longer matches its recorded identity, not just a dead PID', async () => {
    // process.pid is genuinely alive for the whole test, so its real identity is a stand-in for
    // "a supervised task that's actually still running."
    const identity = await inspectProcessIdentity(process.pid);
    if (identity === null) throw new Error('expected the test runner\'s own process to be inspectable');

    const baseRecord: ManagedProcessRecord = {
      id: 'proc-1', worktreeId: 'web-feature', taskName: 'dev',
      pid: identity.pid, pgid: identity.pgid,
      processStartTime: identity.processStartTime, commandFingerprint: identity.commandFingerprint,
      state: 'RUNNING', startedAt: '2026-01-01T00:00:00.000Z', stoppedAt: null,
      stdoutPath: '/dev/null', stderrPath: '/dev/null', cleanupRequired: false,
    };
    const sourceWith = (record: ManagedProcessRecord) => createStateDiagnosticDataSource({
      ...store, listManagedProcesses: () => [record],
    } as unknown as DaemonStateStore, { cwd: '/workspace/web-feature', globalConfigPath: '/workspace/config.toml' });

    const matching = (await sourceWith(baseRecord).readDoctor(registered)).findings;
    expect(matching.find(({ check }) => check === 'process-records'))
      .toMatchObject({ status: 'pass', details: { running: 1 } });

    // Same PID (still genuinely alive) but the recorded identity no longer matches -- the shape
    // of "the OS handed our dead task's old PID to an unrelated process." A bare `isAlive(pid)`
    // check would wrongly call this "running".
    const staleRecord = { ...baseRecord, processStartTime: `not-the-real-start-time-${identity.processStartTime}` };
    const stale = (await sourceWith(staleRecord).readDoctor(registered)).findings;
    expect(stale.find(({ check }) => check === 'process-records')).toMatchObject({
      status: 'warning',
      message: expect.stringContaining('dev'),
      details: { stale: 1 },
    });
  });

  it('counts the endpoints the workspace holds and the tasks it supervises', async () => {
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect(findings.find(({ check }) => check === 'ports')).toMatchObject({ status: 'pass', details: { leases: 2 } });
    expect(findings.find(({ check }) => check === 'process-records'))
      .toMatchObject({ status: 'pass', details: { running: 0 } });
  });

  it('answers every check it declares', async () => {
    // Against `doctorChecks` itself, so a check added to the contract and never answered here
    // fails rather than being back-filled as `unknown` by the envelope and read as healthy.
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect([...findings.map(({ check }) => check)].sort()).toEqual([...doctorChecks].sort());
  });

  it('says no adapter recognizes a worktree rather than saying nothing at all', async () => {
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect(findings.find(({ check }) => check === 'adapters')).toEqual({
      check: 'adapters',
      status: 'pass',
      message: 'No built-in adapter recognizes this worktree; only configured tasks are available.',
      details: { detected: 0, active: 0 },
    });
  });

  it('names the adapter in force, and how many tasks it contributes', async () => {
    // Which adapter won is the first question after the wrong `dev` command runs, and the
    // check that should answer it reported `unknown` no matter what was in the worktree.
    const root = mkdtempSync(join(tmpdir(), 'wtm-doctor-'));
    try {
      mkdirSync(join(root, 'repo'), { recursive: true });
      writeFileSync(join(root, 'repo/Makefile'), 'dev:\n\techo dev\n\ntest:\n\techo test\n');
      const finding = (await doctorIn(root)).find(({ check }) => check === 'adapters');

      expect(finding?.status).toBe('pass');
      expect(finding?.message).toContain('make in force');
      expect(finding?.details).toMatchObject({ detected: 1, active: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The doctor findings for a real directory, which is what adapter detection needs to read. */
async function doctorIn(root: string) {
  const local: WorkspaceRecord = { ...workspace, root, configPath: null };
  const repository: RepositoryRecord = {
    ...repositories[0] as RepositoryRecord,
    commonGitDir: join(root, 'repo/.git'),
    mainRoot: join(root, 'repo'),
  };
  const only = worktree('only', repository.id, join(root, 'repo'), 1);
  const localStore = {
    listWorkspaces: () => [local],
    listRepositories: () => [repository],
    listWorktrees: () => [only],
    listManagedProcesses: () => [],
    listEndpointLeases: () => [],
  } as unknown as DaemonStateStore;
  const source = createStateDiagnosticDataSource(localStore, {
    cwd: join(root, 'repo'),
    globalConfigPath: join(root, 'config.toml'),
  });
  return (await source.readDoctor({
    id: local.id, name: local.name, root: local.root, scope: local.scope,
  })).findings;
}

/**
 * Doctor findings for a real main worktree at `<root>/main` plus a *linked* worktree row whose
 * path (`<root>/linked-gone`) is never created on disk, at the given store state -- what the
 * `git` check must tell apart: a live-but-vanished worktree (any state but ORPHANED/REMOVED)
 * from one whose absence reconcile has already settled.
 */
async function doctorWithLinkedWorktree(root: string, linkedState: WorktreeRecord['state']) {
  const local: WorkspaceRecord = { ...workspace, root, configPath: null };
  const repository: RepositoryRecord = {
    ...repositories[0] as RepositoryRecord,
    commonGitDir: join(root, 'main/.git'),
    mainRoot: join(root, 'main'),
  };
  const main = worktree('main', repository.id, join(root, 'main'), 1);
  const linked = { ...worktree('linked', repository.id, join(root, 'linked-gone'), 2), state: linkedState };
  const localStore = {
    listWorkspaces: () => [local],
    listRepositories: () => [repository],
    listWorktrees: () => [main, linked],
    listManagedProcesses: () => [],
    listEndpointLeases: () => [],
  } as unknown as DaemonStateStore;
  const source = createStateDiagnosticDataSource(localStore, {
    cwd: join(root, 'main'),
    globalConfigPath: join(root, 'config.toml'),
  });
  return (await source.readDoctor({
    id: local.id, name: local.name, root: local.root, scope: local.scope,
  })).findings;
}

describe('a broken wtm.toml', () => {
  // Regression: `readStatus`'s own `declaredResources` used to blanket-catch every failure
  // from resolving the runtime (including a genuinely invalid `wtm.toml`) and report an empty
  // resources list with no error at all -- the one diagnostic command that hid a real
  // `WTM_CONFIG_INVALID` behind a swallowed exception, unlike `explain`/`plan`/`env`/`doctor`,
  // which all surface it.
  function sourceForBrokenConfig(root: string) {
    const local: WorkspaceRecord = { ...workspace, root, configPath: null };
    const repository: RepositoryRecord = {
      ...repositories[0] as RepositoryRecord,
      commonGitDir: join(root, 'repo/.git'),
      mainRoot: join(root, 'repo'),
    };
    const only = worktree('only', repository.id, join(root, 'repo'), 1);
    const localStore = {
      listWorkspaces: () => [local],
      listRepositories: () => [repository],
      listWorktrees: () => [only],
      listManagedProcesses: () => [],
      listEndpointLeases: () => [],
    } as unknown as DaemonStateStore;
    const source = createStateDiagnosticDataSource(localStore, {
      cwd: join(root, 'repo'),
      globalConfigPath: join(root, 'config.toml'),
    });
    const registered = { id: local.id, name: local.name, root: local.root, scope: local.scope } as const;
    return { source, registered };
  }

  it('readStatus now propagates WTM_CONFIG_INVALID instead of reporting an empty resources list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-broken-config-'));
    try {
      mkdirSync(join(root, 'repo'), { recursive: true });
      writeFileSync(join(root, 'wtm.toml'), 'not valid toml {{{');
      const { source, registered } = sourceForBrokenConfig(root);

      await expect(source.readStatus(registered)).rejects.toMatchObject({
        code: 'WTM_CONFIG_INVALID',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('readDoctor still answers every other check, with resources reported unknown rather than aborting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-broken-config-doctor-'));
    try {
      mkdirSync(join(root, 'repo'), { recursive: true });
      writeFileSync(join(root, 'wtm.toml'), 'not valid toml {{{');
      const { source, registered } = sourceForBrokenConfig(root);

      const findings = (await source.readDoctor(registered)).findings;

      expect(findings.find(({ check }) => check === 'config')).toMatchObject({ status: 'error' });
      expect(findings.find(({ check }) => check === 'resources')).toMatchObject({ status: 'unknown' });
      // Every other check still answered -- the whole point of `doctor` is that one broken
      // check does not take the rest down with it.
      expect(findings.find(({ check }) => check === 'git')).toMatchObject({ status: 'pass' });
      expect(findings).toHaveLength(doctorChecks.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('registration', () => {
  it('tells an unreachable daemon apart from an unregistered worktree', async () => {
    // The two states have distinct codes and distinct exit codes everywhere else in WTM. A
    // doctor that collapsed them would send the reader to start a daemon that is already
    // running, or to re-run `wtm init` on a worktree that is already registered.
    const listening = await socketServer();
    const down = join(await tempDir(), 'wtmd.sock');

    const daemonDown = await registrationFinding('/workspace/web-feature', down);
    const notRegistered = await registrationFinding('/elsewhere', listening);

    expect(daemonDown).toEqual({
      check: 'registration',
      status: 'warning',
      message: 'This worktree is registered, but the daemon is not answering on its socket. '
        + 'Start it with `wtm daemon install`.',
      details: { code: 'WTM_DAEMON_UNAVAILABLE', registered: true, daemonReachable: false },
    });
    expect(notRegistered).toEqual({
      check: 'registration',
      status: 'error',
      message: 'This directory is not inside a worktree WTM has registered. '
        + 'Run `wtm init` in the workspace root.',
      details: { code: 'WTM_WORKSPACE_NOT_FOUND', registered: false, daemonReachable: true },
    });
    expect(daemonDown).not.toEqual(notRegistered);
  });

  it('passes when the worktree is registered and the daemon answers', async () => {
    expect(await registrationFinding('/workspace/web-feature', await socketServer())).toEqual({
      check: 'registration',
      status: 'pass',
      message: 'This worktree is registered, and the daemon is answering.',
      details: { code: null, registered: true, daemonReachable: true },
    });
  });

  it('does not file the unregistered-worktree message under adapters', async () => {
    // It used to arrive as an `adapters` finding of status `unknown`, which is the one place a
    // reader looking for "why does WTM not know about this directory" would never look.
    const findings = await findingsAt('/elsewhere', await socketServer());
    const adapters = findings.find(({ check }) => check === 'adapters');

    expect(adapters?.message).not.toContain('wtm init');
    expect(adapters).toEqual({
      check: 'adapters',
      status: 'unknown',
      message: 'Adapter detection needs a registered worktree; see the registration check.',
    });
  });

  test('an unreachable daemon with a recorded startup failure is reported with its reason and its remedy', async () => {
    const statusPath = join(await tempDir(), 'daemon-status.json');
    writeDaemonStatus(statusPath, nextDaemonStatus(null, {
      started: false, code: 'WTM_IPC_PATH_UNUSABLE',
      condition: 'The WTM daemon socket path is a directory: /x.', message: 'The WTM daemon socket path is a directory: /x.',
      remediation: ['wtm', 'doctor'], permanent: true,
    }, new Date('2026-09-11T10:00:00.000Z'), 7));
    const finding = await registrationFinding('/workspace/web-feature', join(await tempDir(), 'absent.sock'), statusPath);

    expect(finding?.status).toBe('error');
    expect(finding?.message).toContain('The WTM daemon socket path is a directory: /x.');
    expect(finding?.message).toContain('since 2026-09-11T10:00:00.000Z');
    expect(finding?.message).toContain('`wtm daemon install`');
    expect(finding?.details).toMatchObject({
      code: 'WTM_IPC_PATH_UNUSABLE', daemonReachable: false,
      startupFailedSince: '2026-09-11T10:00:00.000Z', startupAttempts: 1, startupPermanent: true,
      startupRemediation: 'wtm doctor',
    });
  });

  test('an unregistered worktree with an unreachable daemon reports its recorded startup failure too (review M4)', async () => {
    const statusPath = join(await tempDir(), 'daemon-status.json');
    writeDaemonStatus(statusPath, nextDaemonStatus(null, {
      started: false, code: 'WTM_IPC_PATH_UNUSABLE',
      condition: 'The WTM daemon socket path is a directory: /x.', message: 'The WTM daemon socket path is a directory: /x.',
      remediation: ['wtm', 'doctor'], permanent: true,
    }, new Date('2026-09-11T10:00:00.000Z'), 7));
    const finding = await registrationFinding('/elsewhere', join(await tempDir(), 'absent.sock'), statusPath);

    expect(finding?.status).toBe('error');
    expect(finding?.message).toContain('This directory is not inside a worktree WTM has registered.');
    expect(finding?.message).toContain('The WTM daemon socket path is a directory: /x.');
    expect(finding?.message).toContain('since 2026-09-11T10:00:00.000Z');
    expect(finding?.details).toMatchObject({
      code: 'WTM_WORKSPACE_NOT_FOUND', registered: false, daemonReachable: false,
      startupFailedSince: '2026-09-11T10:00:00.000Z', startupAttempts: 1, startupPermanent: true,
      startupRemediation: 'wtm doctor',
    });
  });

  test('an unregistered worktree with a reachable daemon does not report a stale startup failure', async () => {
    const statusPath = join(await tempDir(), 'daemon-status.json');
    writeDaemonStatus(statusPath, nextDaemonStatus(null, {
      started: false, code: 'WTM_IPC_PATH_UNUSABLE', condition: 'old', message: 'old', remediation: null, permanent: true,
    }, new Date('2026-09-11T10:00:00.000Z'), 7));
    const finding = await registrationFinding('/elsewhere', await socketServer(), statusPath);

    expect(finding?.details).toMatchObject({ code: 'WTM_WORKSPACE_NOT_FOUND', daemonReachable: true });
    expect(finding?.message).not.toContain('old');
  });

  test('a recorded successful start is not presented as the reason the daemon is down', async () => {
    const statusPath = join(await tempDir(), 'daemon-status.json');
    writeDaemonStatus(statusPath, nextDaemonStatus(null, { started: true }, new Date(), 7));
    const finding = await registrationFinding('/workspace/web-feature', join(await tempDir(), 'absent.sock'), statusPath);
    expect(finding?.status).toBe('warning');
    expect(finding?.details).toMatchObject({ code: 'WTM_DAEMON_UNAVAILABLE' });
  });
});

/**
 * `sizeof(sun_path)` for the machine this file runs on: 104 bytes on macOS, 108 on Linux.
 *
 * The four checks below reach `socketPathFinding`, which goes through `findingsAt` — and
 * `findingsAt` passes no `selectPlatform`, so the finding is measured against *this host's*
 * limit. Written as the literal `104` the headroom, the status and the `104-byte limit` in the
 * message were all macOS's answers asserted of whatever host ran them. What each test claims is a
 * relationship — this much headroom, this far over — and the limit it is measured against is the
 * host's to say.
 */
const hostLimitBytes = selectPlatformRuntime().socket.limitBytes;

/**
 * A socket path of exactly `bytes` bytes, ending in the name the daemon actually publishes.
 *
 * Every one of these measurements is a property of the address's length, so the fixture has to hit
 * a length rather than merely be deep.
 */
function socketPathOfBytes(bytes: number): string {
  const segment = bytes - daemonSocketFileName.length - 2;
  if (segment < 1) throw new Error(`${bytes} bytes cannot hold a socket path`);
  const path = `/${'d'.repeat(segment)}/${daemonSocketFileName}`;
  if (Buffer.byteLength(path) !== bytes) throw new Error('fixture did not hit the requested length');
  return path;
}

describe('doctor with a database but no workspace left in it (todo item 52)', () => {
  test('reports the recorded daemon failure beside WTM_NOT_INITIALIZED, as with no database at all', async () => {
    const statusPath = join(await tempDir(), 'daemon-status.json');
    writeDaemonStatus(statusPath, nextDaemonStatus(null, {
      started: false, code: 'WTM_PRIVATE_DIRECTORY_UNSAFE',
      condition: 'WTM private directory is unsafe: /x is readable by others (mode 755); run chmod 700 on it.',
      message: 'WTM private directory is unsafe: /x is readable by others (mode 755); run chmod 700 on it.',
      remediation: ['chmod', '700', '/x'], permanent: true,
    }, new Date('2026-09-11T10:00:00.000Z'), 7));
    // Every workspace forgotten: the database opens, and it has nothing registered in it.
    const emptied = { ...store, listWorkspaces: () => [] } as unknown as DaemonStateStore;

    const envelope = await runDoctorCommand({ cwd: '/fresh' }, createStateDiagnosticDataSource(emptied, {
      cwd: '/fresh',
      globalConfigPath: '/workspace/config.toml',
      daemonSocketPath: join(await tempDir(), 'absent.sock'),
      daemonStatusPath: statusPath,
    }));

    expect(envelope.errors.map(({ code }) => code)).toEqual(['WTM_NOT_INITIALIZED']);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]).toMatchObject({
      code: 'WTM_PRIVATE_DIRECTORY_UNSAFE',
      severity: 'warning',
      remediation: [{ kind: 'command-suggestion', argv: ['chmod', '700', '/x'] }],
    });
    expect(envelope.warnings[0]?.message).toContain('it failed to start once since 2026-09-11T10:00:00.000Z.');
  });
});

describe('the daemon status record is read where the daemon writes it (todo item 52, M4)', () => {
  test('doctor reads the record through the service paths, not through a second derivation', async () => {
    // `daemon serve` records the outcome under `ServicePaths.logRoot`. `doctor` used to arrive at
    // the same file from `PlatformRuntime.paths.logRoot` instead -- equal on this host today, and
    // equal only for as long as the two resolvers agree. Pointing the *writer's* seam at a
    // throwaway directory is what proves the reader follows it: nothing here touches the real
    // `HOME`'s log root, and the record is still found.
    const logRoot = await tempDir();
    writeDaemonStatus(join(logRoot, daemonStatusFileName), nextDaemonStatus(null, {
      started: false,
      code: 'WTM_PRIVATE_DIRECTORY_UNSAFE',
      condition: 'private directory unsafe',
      message: 'WTM private directory is unsafe: /x is readable by others (mode 755).',
      remediation: ['chmod', '700', '/x'],
      permanent: true,
    }, new Date('2026-09-11T10:00:00.000Z'), 7));
    const emptied = { ...store, listWorkspaces: () => [] } as unknown as DaemonStateStore;

    const envelope = await runDoctorCommand({ cwd: '/fresh' }, createStateDiagnosticDataSource(emptied, {
      cwd: '/fresh',
      globalConfigPath: '/workspace/config.toml',
      daemonSocketPath: join(await tempDir(), 'absent.sock'),
      // Only `logRoot` is read on this path; the rest of a real HOME's paths are not needed.
      daemonServicePaths: () => ({ logRoot }) as unknown as ServicePaths,
    }));

    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]).toMatchObject({
      code: 'WTM_PRIVATE_DIRECTORY_UNSAFE',
      severity: 'warning',
      remediation: [{ kind: 'command-suggestion', argv: ['chmod', '700', '/x'] }],
    });
  });

  test('a host with no service backend has no record to read, and says nothing about one', async () => {
    const emptied = { ...store, listWorkspaces: () => [] } as unknown as DaemonStateStore;

    const envelope = await runDoctorCommand({ cwd: '/fresh' }, createStateDiagnosticDataSource(emptied, {
      cwd: '/fresh',
      globalConfigPath: '/workspace/config.toml',
      daemonSocketPath: join(await tempDir(), 'absent.sock'),
      daemonServicePaths: () => null,
    }));

    expect(envelope.errors.map(({ code }) => code)).toEqual(['WTM_NOT_INITIALIZED']);
    expect(envelope.warnings).toEqual([]);
  });
});

describe('socket-path', () => {
  it('reports the headroom left before the path becomes unbindable', async () => {
    const finding = await socketPathFinding(join('/tmp', 'wtmd.sock'));

    expect(finding?.status).toBe('pass');
    expect(finding?.message).toContain('bytes to spare');
    // 14 bytes is a fact about `/tmp/wtmd.sock`; the headroom left over is a fact about the host.
    expect(finding?.details).toMatchObject({
      byteLength: 14,
      limitBytes: hostLimitBytes,
      headroom: hostLimitBytes - 14,
    });
  });

  it('warns while the path still binds, not only once it has stopped', async () => {
    // Nine bytes short of unbindable — under the 16-byte warning threshold on either platform,
    // and still a path the daemon binds today. That combination is the whole claim: the warning
    // has to arrive while there is still a daemon to run `doctor` with.
    const finding = await socketPathFinding(socketPathOfBytes(hostLimitBytes - 9));

    expect(finding?.status).toBe('warning');
    expect(finding?.details).toMatchObject({
      byteLength: hostLimitBytes - 9,
      limitBytes: hostLimitBytes,
      headroom: 9,
    });
    expect(finding?.message).toContain('headroom');
  });

  it('reports a path over the limit as an error naming the measured length', async () => {
    const finding = await socketPathFinding(socketPathOfBytes(hostLimitBytes + 27));

    expect(finding?.status).toBe('error');
    expect(finding?.details).toMatchObject({
      code: 'WTM_SOCKET_PATH_TOO_LONG',
      byteLength: hostLimitBytes + 27,
    });
    expect(finding?.message).toContain(`${hostLimitBytes + 27} bytes`);
    expect(finding?.message).toContain(`${hostLimitBytes}-byte limit`);
  });

  it('measures bytes rather than code units', async () => {
    // A home directory holding non-ASCII characters is longer than its character count, and
    // the limit is a property of the address in bytes. `repeats` of a 2-byte character land
    // comfortably past whatever this host's own limit is, in bytes, while the character count
    // stays under it -- 111 was a POSIX-only constant, past every limit WTM had a backend for
    // until win32's own 256-byte named pipe limit made that no longer true on every host.
    const repeats = hostLimitBytes;
    const path = `/${'ü'.repeat(repeats)}/wtmd.sock`;
    const byteLength = Buffer.byteLength(path);
    expect(path.length).toBeLessThan(byteLength);
    expect(byteLength).toBeGreaterThan(hostLimitBytes);

    const finding = await socketPathFinding(path);

    expect(finding?.details).toMatchObject({ byteLength });
    expect(finding?.status).toBe('error');
  });
});

describe('platform', () => {
  it('reports the macOS roots, manager and limit as the exact strings they have always been', async () => {
    // Pinned literally, not derived. This is the evidence that moving four hard-coded macOS
    // spellings onto `PlatformRuntime.paths` moved nothing else: every path here is byte for byte
    // the one the CLI and the daemon were already using.
    const finding = (await findingsOn(darwinHost)).find(({ check }) => check === 'platform');

    expect(finding).toEqual({
      check: 'platform',
      status: 'pass',
      message: 'darwin, with launchd as the service manager. Data in '
        + '/Users/x/Library/Application Support/WTM, logs in /Users/x/Library/Logs/WTM, the daemon '
        + 'socket in /Users/x/Library/Application Support/WTM, under a 104-byte socket address limit.',
      details: {
        code: null,
        platform: 'darwin',
        serviceManager: 'launchd',
        dataRoot: '/Users/x/Library/Application Support/WTM',
        logRoot: '/Users/x/Library/Logs/WTM',
        socketRoot: '/Users/x/Library/Application Support/WTM',
        socketLimitBytes: 104,
      },
    });
  });

  it('reports systemd, the XDG roots and 108 bytes for a linux host', async () => {
    const finding = (await findingsOn(linuxHost)).find(({ check }) => check === 'platform');

    expect(finding).toMatchObject({
      check: 'platform',
      status: 'pass',
      details: {
        code: null,
        platform: 'linux',
        serviceManager: 'systemd',
        dataRoot: '/home/x/.local/state/wtm',
        logRoot: '/home/x/.local/state/wtm/logs',
        // The socket goes where the platform says sockets go, which is also dramatically shorter
        // than any home directory — the macOS length defect solved for free.
        socketRoot: '/run/user/501/wtm',
        socketLimitBytes: 108,
      },
    });
  });

  it('is an error only when the platform itself is refused', async () => {
    const finding = (await findingsOn(() => { throw new UnsupportedPlatformError('aix'); }))
      .find(({ check }) => check === 'platform');

    expect(finding).toEqual({
      check: 'platform',
      status: 'error',
      message: 'WTM has no backend for aix. Supported platforms: darwin, linux, win32.',
      details: { code: 'WTM_PLATFORM_UNSUPPORTED' },
    });
  });

  it('never reports a status between pass and error', async () => {
    // `pass` or `error`, and nothing between: there is no partial platform. Either the runtime
    // resolved, in which case every root below it is settled, or it did not, in which case none is.
    for (const select of [darwinHost, linuxHost, () => { throw new UnsupportedPlatformError('aix'); }]) {
      const finding = (await findingsOn(select)).find(({ check }) => check === 'platform');
      expect(finding?.status === 'pass' || finding?.status === 'error').toBe(true);
    }
  });

  it('measures the socket path against the limit of the platform it reported', async () => {
    // The two host-scoped checks answer from one selection, so `socket-path` cannot measure
    // against macOS's 104 while `platform` reports linux.
    const findings = await findingsOn(linuxHost);

    expect(findings.find(({ check }) => check === 'socket-path'))
      .toMatchObject({ details: { limitBytes: 108 } });
  });

  it('measures the address the platform actually publishes on', async () => {
    // No `daemonSocketPath` override: the default has to be the socket root the platform names,
    // or `doctor` reports on a path no command ever dials.
    const findings = await findingsOn(darwinHost);

    expect(findings.find(({ check }) => check === 'socket-path')).toMatchObject({
      details: { path: publishedDaemonSocketPath('/Users/x/Library/Application Support/WTM') },
    });
  });

  it('leaves socket-path unanswered rather than guessing a limit for a refused host', async () => {
    // There is no `sizeof(sun_path)` for a platform WTM has no backend for. Left out, the
    // envelope back-fills it as `unknown`; invented, it would be macOS's 104 stated as a
    // universal fact, which is the defect this increment exists to remove.
    const findings = await findingsOn(() => { throw new UnsupportedPlatformError('aix'); });

    expect(findings.map(({ check }) => check)).not.toContain('socket-path');
    expect(findings.find(({ check }) => check === 'platform')?.status).toBe('error');
  });
});

async function tempDir(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'wtm-socket-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A daemon socket that is actually listening, so reachability is observed, not stubbed. */
async function socketServer(): Promise<string> {
  const path = join(await tempDir(), 'wtmd.sock');
  const server = createServer();
  await new Promise<void>((done) => server.listen(path, done));
  cleanups.push(() => server.close());
  return path;
}

async function findingsAt(cwd: string, daemonSocketPath: string, daemonStatusPath?: string) {
  return (await createStateDiagnosticDataSource(store, {
    cwd,
    globalConfigPath: '/workspace/config.toml',
    daemonSocketPath,
    daemonStatusPath: daemonStatusPath ?? join(await tempDir(), 'daemon-status.json'),
  }).readDoctor(registered)).findings;
}

async function registrationFinding(cwd: string, daemonSocketPath: string, daemonStatusPath?: string) {
  return (await findingsAt(cwd, daemonSocketPath, daemonStatusPath)).find(({ check }) => check === 'registration');
}

async function socketPathFinding(daemonSocketPath: string) {
  return (await findingsAt('/workspace/web-feature', daemonSocketPath))
    .find(({ check }) => check === 'socket-path');
}

/**
 * `doctor` asked about a named platform rather than about this host.
 *
 * The whole point of the seam is that the operating system is an argument, and this is where the
 * CLI half of that is proven: the linux answer below is produced on a macOS machine, and the
 * refusal below that is produced without a Windows one.
 */
async function findingsOn(select: () => ReturnType<typeof selectPlatformRuntime>) {
  return (await createStateDiagnosticDataSource(store, {
    cwd: '/workspace/web-feature',
    globalConfigPath: '/workspace/config.toml',
    selectPlatform: select,
  }).readDoctor(registered)).findings;
}

const darwinHost = () => selectPlatformRuntime({
  platform: 'darwin',
  home: '/Users/x',
  // Set, and ignored: a macOS user who exports XDG for some other tool must not find WTM's state
  // relocated. The `platform` finding is where that would be visible if it ever stopped being true.
  env: { XDG_STATE_HOME: '/xdg/state', XDG_CONFIG_HOME: '/xdg/config', XDG_RUNTIME_DIR: '/run/user/501' },
});

const linuxHost = () => selectPlatformRuntime({
  platform: 'linux',
  home: '/home/x',
  env: { XDG_RUNTIME_DIR: '/run/user/501' },
});

describe('the worker-env check', () => {
  /**
   * A workspace whose one repository runs a Cloudflare worker: `wtm.toml` at `root`, the
   * repository at `root/repo`, and whatever worker files `files` writes there.
   */
  async function doctorForWorker(toml: string, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'wtm-worker-env-doctor-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'repo'));
    writeFileSync(join(root, 'wtm.toml'), toml);
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, 'repo', name), contents);
    return (await doctorIn(root)).find(({ check }) => check === 'worker-env');
  }

  const workerToml = (task: string) => [
    'version = 1',
    '[repos.api]',
    'path = "repo"',
    '[repos.api.environment]',
    'API_URL = "http://localhost:1"',
    'FRONTEND_URL = "http://localhost:2"',
    'WTM_ONLY = "x"',
    '[tasks."api:dev"]',
    task,
    'background = true',
  ].join('\n');

  const workerFiles = {
    'wrangler.jsonc': '{ "name": "api", /* c */ "vars": { "APP_ENV": "dev" } }',
    // Values here stand in for the secrets a real `.dev.vars` holds; none may leave this file.
    '.dev.vars': 'API_URL=http://localhost:4000\nFRONTEND_URL=http://localhost:3000\nSESSION_SECRET=hunter2\n',
  };

  it('warns when WTM sets a variable the worker also defines, and names the fix', async () => {
    const finding = await doctorForWorker(workerToml('run = ["bunx", "wrangler", "dev", "-c", "wrangler.jsonc"]'), workerFiles);

    expect(finding).toMatchObject({
      status: 'warning',
      details: { workers: 1, tasks: 'api:dev', shadowed: 'API_URL, FRONTEND_URL' },
    });
    expect(finding?.message).toContain('api:dev runs `wrangler dev`');
    expect(finding?.message).toContain('.dev.vars defines API_URL, FRONTEND_URL');
    expect(finding?.message).toContain('Add worker_vars = ["API_URL", "FRONTEND_URL"] to [tasks."api:dev"].');
    expect(JSON.stringify(finding)).not.toContain('hunter2');
    expect(JSON.stringify(finding)).not.toContain('localhost:4000');
  });

  it('passes once every shadowed variable is forwarded, by worker_vars or a literal --var', async () => {
    const forwarded = await doctorForWorker(workerToml([
      'run = ["bunx", "wrangler", "dev", "--var", "API_URL:{env.API_URL}"]',
      'worker_vars = ["FRONTEND_URL"]',
    ].join('\n')), workerFiles);

    expect(forwarded).toMatchObject({ status: 'pass', details: { workers: 1, tasks: 'api:dev', shadowed: '' } });
  });

  it('points at a wrangler config that app code reads directly, even with no wrangler dev task', async () => {
    const finding = await doctorForWorker(
      workerToml('run = ["bun", "run", "dev"]').replace('WTM_ONLY', 'NEXT_PUBLIC_API_URL'),
      { 'wrangler.json': '{ "vars": { "NEXT_PUBLIC_API_URL": "https://api.example.com" } }' },
    );

    expect(finding).toMatchObject({ status: 'warning', details: { workers: 1, tasks: '', shadowed: 'NEXT_PUBLIC_API_URL' } });
    expect(finding?.message).toContain('wrangler.json defines NEXT_PUBLIC_API_URL');
    expect(finding?.message).toContain('reads it from wrangler.json');
  });

  it('passes quietly where there is no worker at all', async () => {
    expect(await doctorForWorker(workerToml('run = ["bun", "run", "dev"]'), {}))
      .toMatchObject({ status: 'pass', details: { workers: 0 } });
  });
});

describe('process states in status', () => {
  it('reports a run that crashed as failed, with how it ended, rather than as stopped', async () => {
    const run = (id: string, state: ManagedProcessRecord['state'], extra: Partial<ManagedProcessRecord> = {}): ManagedProcessRecord => ({
      id, worktreeId: 'web-feature', taskName: id, pid: 4242, pgid: 4242, processStartTime: 'start',
      commandFingerprint: 'fingerprint', state, startedAt: '2026-09-25T07:21:21.232Z',
      stoppedAt: '2026-09-25T07:27:41.729Z', stdoutPath: '/dev/null', stderrPath: '/dev/null', cleanupRequired: false,
      ...extra,
    });
    const source = createStateDiagnosticDataSource({
      ...store,
      listManagedProcesses: () => [
        run('crashed', 'FAILED', { exitCode: 1 }),
        run('killed', 'FAILED', { exitSignal: 'SIGKILL' }),
        run('stopped', 'STOPPED'),
      ],
    } as unknown as DaemonStateStore, { cwd: '/workspace/web-feature', globalConfigPath: '/workspace/config.toml' });

    const processes = (await source.readStatus(registered)).processes;

    expect(processes.map(({ task, state }) => [task, state])).toEqual([
      ['crashed', 'failed'], ['killed', 'failed'], ['stopped', 'stopped'],
    ]);
    expect(processes[0]).toMatchObject({ exitCode: 1 });
    expect(processes[1]).toMatchObject({ exitSignal: 'SIGKILL' });
    expect(processes[2]).not.toHaveProperty('exitCode');
  });
});

describe('reports take no ports', () => {
  it('status and doctor answer without leasing an endpoint', async () => {
    // Every agent session starts with `wtm status`/`wtm doctor`, in every worktree it touches.
    // Both used to lease every [ports.*] endpoint on the way to an answer, which is how a
    // worktree that never ran a task came to hold seventeen ports.
    const root = mkdtempSync(join(tmpdir(), 'wtm-report-no-lease-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'repo'));
    writeFileSync(join(root, 'wtm.toml'), [
      'version = 1', '[ports]', 'range = "46200-46299"', '[ports.web]', 'preferred = 46250',
      '[resources.env]', 'path = ".env"', 'policy = "ignore"',
    ].join('\n'));
    const local: WorkspaceRecord = { ...workspace, root, configPath: null };
    const repository: RepositoryRecord = { ...repositories[0] as RepositoryRecord, commonGitDir: join(root, 'repo/.git'), mainRoot: join(root, 'repo') };
    let allocations = 0;
    const source = createStateDiagnosticDataSource({
      listWorkspaces: () => [local],
      listRepositories: () => [repository],
      listWorktrees: () => [worktree('only', repository.id, join(root, 'repo'), 1)],
      listManagedProcesses: () => [],
      listEndpointLeases: () => [],
      allocateEndpoint: () => { allocations += 1; throw new Error('a report must not lease'); },
    } as unknown as DaemonStateStore, { cwd: join(root, 'repo'), globalConfigPath: join(root, 'config.toml') });
    const registeredLocal = { id: local.id, name: local.name, root: local.root, scope: local.scope };

    const status = await source.readStatus(registeredLocal);
    const findings = (await source.readDoctor(registeredLocal)).findings;

    expect(allocations).toBe(0);
    expect(status.resources.map(({ name }) => name)).toEqual(['env']);
    expect(findings.find(({ check }) => check === 'resources')?.status).toBe('pass');
  });
});
