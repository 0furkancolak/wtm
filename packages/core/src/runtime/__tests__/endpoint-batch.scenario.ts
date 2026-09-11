import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { SQLiteStateStore } from '../../state/sqlite-store';
import type { EndpointCandidate } from '../../state/store';
import { allocateStableEndpoint, installEndpointProbe, isEndpointAvailable, spawnedEndpointProbe } from '../endpoints';

const name = process.argv[2];
const cliEntry = fileURLToPath(new URL('../../../../cli/src/bin.ts', import.meta.url));
const request = { name: 'web', host: '127.0.0.1', protocol: 'tcp' as const, portRange: { min: 22000, max: 22004 }, preferredPort: 22003 };
const candidate = (port: number): EndpointCandidate => ({ host: '127.0.0.1', protocol: 'tcp', port });

if (name === 'allocation' || name === 'budget' || name === 'malformed' || name === 'legacy') {
  const store = new SQLiteStateStore(':memory:');
  try {
    const workspace = store.upsertWorkspace({ name: 'batch', root: '/batch', scope: 'local', configPath: null });
    const repository = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/batch/.git', mainRoot: '/batch', remoteIdentity: null });
    const [worktree] = store.reconcileWorktrees(repository.id, [{ path: '/batch', head: 'a'.repeat(40), branch: 'refs/heads/main', detached: false, bare: false, lockedReason: null, prunableReason: null }]).discovered;
    assert.ok(worktree);
    const input = { ...request, worktreeId: worktree.id };
    const single = () => { throw new Error('A batch-capable allocator must not spawn one helper per candidate'); };
    if (name === 'legacy') {
      let calls = 0;
      installEndpointProbe((...args: [EndpointCandidate]) => {
        assert.equal(args.length, 1);
        calls += 1;
        return true;
      });
      assert.equal(allocateStableEndpoint(store, input).port, 22003);
      assert.equal(calls, 1, 'A legacy installed probe must still stop at the first free port');
    } else if (name === 'allocation') {
      store.allocateEndpoint({ ...input, name: 'reserved', preferredPort: 22000 });
      const batches: number[][] = [];
      const probe = Object.assign(single, { batch: (candidates: readonly EndpointCandidate[]) => {
        batches.push(candidates.map((value) => value.port));
        return candidates.map((value) => value.port === 22002 || value.port === 22004);
      } });
      const lease = allocateStableEndpoint(store, input, probe);
      assert.equal(lease.port, 22002);
      assert.deepEqual(batches, [[22003, 22001, 22002, 22004]]);
      assert.equal(allocateStableEndpoint(store, input, probe).id, lease.id);
      assert.deepEqual(batches[1], [22002, 22003, 22001, 22004]);
      assert.equal(store.listEndpointLeases().length, 2);
    } else if (name === 'budget') {
      let calls = 0;
      const probe = Object.assign(single, { batch: (candidates: readonly EndpointCandidate[]) => {
        calls += 1;
        assert.equal(candidates.length, 256);
        assert.equal(candidates[0]?.port, 22003);
        return candidates.map(() => false);
      } });
      assert.throws(() => store.allocateEndpoint({ ...input, portRange: { min: 20000, max: 50000 } }, probe), /256 ports were offered/);
      assert.equal(calls, 1);
      assert.deepEqual(store.listEndpointLeases(), []);
    } else {
      const existing = store.allocateEndpoint(input);
      for (const answer of [[true], ['true', true, true, true, true], null]) {
        const probe = Object.assign(single, { batch: () => answer as readonly boolean[] });
        assert.throws(() => allocateStableEndpoint(store, input, probe), /No available/);
        assert.deepEqual(store.listEndpointLeases(), [existing]);
      }
    }
  } finally { store.close(); }
} else if (name === 'transport') {
  const root = await mkdtemp(join(tmpdir(), 'wtm-batch-'));
  try {
    const trace = join(root, 'calls');
    const script = "require('node:fs').appendFileSync(process.argv[1], 'call\\n'); let s=''; process.stdin.on('data', c => s+=c); process.stdin.on('end', () => { const x=JSON.parse(s); process.stdout.write(JSON.stringify({ available: x.candidates.map(c => c.port === 22002) })); });";
    const probe = spawnedEndpointProbe(process.execPath, ['-e', 'process.exit(1)'], ['-e', script, trace]);
    assert.ok(probe.batch, 'The spawned probe must expose a batch transport');
    assert.deepEqual(probe.batch([candidate(22001), candidate(22002), candidate(22003)]), [false, true, false]);
    assert.equal(await readFile(trace, 'utf8'), 'call\n');
    for (const output of ['not json', '{"available":[true]}', '{"available":[1,1]}', '{"available":[true,true],"extra":1}']) {
      const invalid = spawnedEndpointProbe(process.execPath, [], ['-e', `process.stdout.write(${JSON.stringify(output)})`]);
      assert.deepEqual(invalid.batch!([candidate(22001), candidate(22002)]), [false, false]);
    }
    const failed = spawnedEndpointProbe(process.execPath, [], ['-e', 'process.stdout.write(\'{"available":[true]}\'); process.exit(1)']);
    assert.deepEqual(failed.batch!([candidate(22001)]), [false]);
    const hung = spawnedEndpointProbe(process.execPath, [], ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]);
    const start = performance.now();
    assert.deepEqual(hung.batch!([candidate(22001)]), [false]);
    assert.ok(performance.now() - start < 5000, 'The entire helper must have one bounded deadline');
  } finally { await rm(root, { recursive: true, force: true }); }
} else if (name === 'native') {
  const tcp = createServer();
  const udp = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
    const tcpAddress = tcp.address();
    assert.ok(tcpAddress && typeof tcpAddress === 'object');
    const udpAddress = udp.address();
    const candidates = [candidate(tcpAddress.port), { ...candidate(udpAddress.port), protocol: 'udp' as const }];
    assert.ok(isEndpointAvailable.batch, 'Production Node allocation must use batching');
    assert.deepEqual(isEndpointAvailable.batch(candidates), [false, false]);
    const privateProbe = spawnedEndpointProbe(process.execPath, ['--import', 'tsx', cliEntry, '__wtm_internal_endpoint_probe'], ['--import', 'tsx', cliEntry, '__wtm_internal_endpoint_batch_probe']);
    assert.deepEqual(privateProbe.batch!(candidates), [false, false]);
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    await new Promise<void>((resolve) => udp.close(resolve));
    assert.deepEqual(isEndpointAvailable.batch(candidates), [true, true]);
    assert.deepEqual(privateProbe.batch!(candidates), [true, true]);
    // The helper releases every successful bind; a second helper can bind the same endpoints.
    assert.deepEqual(privateProbe.batch!(candidates), [true, true]);
  } finally {
    if (tcp.listening) await new Promise<void>((resolve) => tcp.close(() => resolve()));
    try { udp.close(); } catch { /* Already closed above. */ }
  }
} else { throw new Error(`Unknown batch scenario ${name}`); }
process.stdout.write('passed\n');
