import { SQLiteStateStore } from '../sqlite-store';
import type { EndpointCandidate } from '../store';

const store = new SQLiteStateStore(':memory:');
try {
  const workspace = store.upsertWorkspace({ name: 'budget', root: '/tmp/budget', scope: 'local', configPath: null });
  const repository = store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: '/tmp/budget/repo/.git',
    mainRoot: '/tmp/budget/repo',
    remoteIdentity: null,
  });
  const [worktree] = store.reconcileWorktrees(repository.id, [{
    path: '/tmp/budget/repo',
    head: 'a'.repeat(40),
    branch: 'refs/heads/main',
    detached: false,
    bare: false,
    lockedReason: null,
    prunableReason: null,
  }]).discovered;
  if (worktree === undefined) throw new Error('Expected a discovered worktree');

  // A probe that never says yes: a daemon throttled so hard that its prober outlives its own
  // timeout answers exactly like this, for every port it is offered.
  let refusals = 0;
  const refuseEverything = (_candidate: EndpointCandidate): boolean => {
    refusals += 1;
    return false;
  };

  let message = '';
  try {
    store.allocateEndpoint({
      worktreeId: worktree.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      // The default band, thirty thousand ports wide.
      portRange: { min: 20000, max: 50000 },
    }, refuseEverything);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  // One free port at the front of the band still costs exactly one probe.
  let accepted = 0;
  const lease = store.allocateEndpoint({
    worktreeId: worktree.id,
    name: 'api',
    protocol: 'tcp',
    host: '127.0.0.1',
    portRange: { min: 20000, max: 50000 },
  }, () => {
    accepted += 1;
    return true;
  });

  process.stdout.write(`${JSON.stringify({ refusals, message, accepted, leasedPort: lease.port })}\n`);
} finally {
  store.close();
}
