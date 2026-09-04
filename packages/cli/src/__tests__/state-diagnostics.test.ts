import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonStateStore,
  EndpointLease,
  EndpointLeaseQuery,
  RepositoryRecord,
  WorkspaceRecord,
  WorktreeRecord,
} from '@wtm/core';
import { selectPlatformRuntime, UnsupportedPlatformError } from '@wtm/platform';
import { daemonSocketFileName, publishedDaemonSocketPath } from '@wtm/platform/socket';
import { doctorChecks } from '../diagnostics';
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
});

describe('doctor', () => {
  it('says which registered repositories are no longer on disk', async () => {
    // The finding that would have explained a daemon that refused to start at all.
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect(findings.find(({ check }) => check === 'git')).toEqual({
      check: 'git',
      status: 'error',
      message: '2 registered repositories no longer on disk, starting with /workspace/api. '
        + 'WTM keeps serving the rest; the registration returns on its own if the directory comes back.',
      details: { registered: 2, unavailable: 2 },
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
        + 'Start it with `wtm daemon start`.',
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
    // the limit is a property of the address in bytes.
    const path = `/${'ü'.repeat(50)}/wtmd.sock`;
    expect(path.length).toBe(61);

    const finding = await socketPathFinding(path);

    expect(finding?.details).toMatchObject({ byteLength: 111 });
    // Stated rather than left to be inferred: 111 bytes is past every limit WTM has a backend
    // for, so the status this fixture characterises is the same one on either host. It was left
    // unasserted, which meant the test would have gone on passing had the finding silently
    // become a `pass` on a platform whose limit was larger.
    expect(hostLimitBytes).toBeLessThan(111);
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

async function findingsAt(cwd: string, daemonSocketPath: string) {
  return (await createStateDiagnosticDataSource(store, {
    cwd,
    globalConfigPath: '/workspace/config.toml',
    daemonSocketPath,
  }).readDoctor(registered)).findings;
}

async function registrationFinding(cwd: string, daemonSocketPath: string) {
  return (await findingsAt(cwd, daemonSocketPath)).find(({ check }) => check === 'registration');
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
