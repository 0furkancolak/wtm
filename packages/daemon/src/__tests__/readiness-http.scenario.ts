import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import type { ManagedProcessRecord, ResolvedTask } from '@wtm/core';
import type { IpcServerPublisher, PublishedIpcServer } from '@wtm/platform';
import { runCli } from '../../../cli/src/main';
import { DaemonClient } from '../../../cli/src/client';
import { UnixIpcServer } from '../server';
import { DaemonRuntimeController } from '../runtime-controller';

let mode: 'delayed' | 'failed' | 'hung' = 'delayed';
let readyAt: number | null = null;
let httpRequests = 0;
let openRequests = 0;
const endpoint = http.createServer((request, response) => {
  httpRequests += 1; openRequests += 1;
  response.once('close', () => { openRequests -= 1; });
  if (mode === 'hung') return;
  readyAt ??= performance.now() + 5500;
  response.writeHead(mode === 'failed' || performance.now() < readyAt ? 503 : 204);
  response.end();
});
await new Promise<void>((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '127.0.0.1', resolve); });
const endpointAddress = endpoint.address();
assert.ok(endpointAddress !== null && typeof endpointAddress === 'object');
// Only process evidence is a fixture here. A separate native workflow owns real processes.
let record: ManagedProcessRecord = {
  id: 'http-observation', worktreeId: 'worktree', taskName: 'dev', pid: 42, pgid: 42,
  processStartTime: 'fixture-start', commandFingerprint: 'fixture-fingerprint', state: 'RUNNING',
  startedAt: new Date().toISOString(), stoppedAt: null, stdoutPath: '/fixture/stdout', stderrPath: '/fixture/stderr', cleanupRequired: false,
};
const task: ResolvedTask = {
  argv: ['node', 'server.js'], shell: false, cwd: '/fixture', envDelta: {}, background: true, singleton: true,
  healthcheck: { type: 'http', url: `http://127.0.0.1:${endpointAddress.port}/health`, timeoutMs: 8000, intervalMs: 100 },
};
let stops = 0;
const controller = new DaemonRuntimeController({
  supervisor: {
    start: async () => ({ record, existing: true }), restart: async () => { throw new Error('unexpected restart'); },
    stop: async () => { stops += 1; record = { ...record, state: 'STOPPED' }; return record; },
    stopAll: async () => [], list: () => [record],
  },
  logs: { read: async () => '', readCompletion: async () => null },
  resolver: {
    resolveTask: async () => ({ workspaceId: 'workspace', worktreeId: 'worktree', task }),
    resolveWorktree: async () => ({ workspaceId: 'workspace', worktreeId: 'worktree' }),
    resolveExec: async () => ({ cwd: '/fixture', envDelta: {} }),
  },
  inspectProcess: async () => ({ status: 'present', identity: record }),
});
let ipcPort = 0;
const originalConnect = net.createConnection;
net.createConnection = ((...args: Parameters<typeof originalConnect>) => args[0] === '/wtm-http-fixture'
  ? originalConnect({ port: ipcPort, host: '127.0.0.1' }) : originalConnect(...args)) as typeof originalConnect;
syncBuiltinESMExports();
const publisher: IpcServerPublisher = {
  async publish(server): Promise<PublishedIpcServer> {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address !== null && typeof address === 'object'); ipcPort = address.port;
    return { address: '/wtm-http-fixture', unpublish: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); } };
  },
};
const ipc = new UnixIpcServer({ socketPath: '/wtm-http-fixture', publisher, handler: (request, context) => controller.handle(request, context) });
const client = new DaemonClient({ socketPath: '/wtm-http-fixture' });
const until = async (predicate: () => boolean) => {
  const deadline = performance.now() + 2000;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error('HTTP observation fixture deadline'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
async function invoke(flags: string[], signal?: AbortSignal) {
  let output = '';
  const code = await runCli(['start', 'dev', '--wait', ...flags, '--json'], {
    cwd: '/fixture', runtimeClient: client, ...(signal === undefined ? {} : { signal }),
    stdout: (value) => { output += value; }, stderr: () => {},
  });
  return { code, envelope: JSON.parse(output) };
}
try {
  await ipc.start(); await client.start();
  const success = await invoke(['--timeout', '8s']);
  assert.equal(success.code, 0, JSON.stringify(success));
  assert.equal(success.envelope.data.readiness.state, 'READY');
  assert.ok(success.envelope.data.readiness.elapsedMs >= 5500);
  mode = 'failed';
  const timedOut = await invoke(['--timeout', '150ms']);
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.envelope.errors[0].code, 'RUNTIME_READINESS_TIMEOUT');
  assert.equal(record.state, 'RUNNING'); assert.equal(stops, 0);
  mode = 'hung';
  const requestsBefore = httpRequests;
  const cancellation = new AbortController();
  const pending = invoke(['--timeout', '8s'], cancellation.signal);
  await until(() => httpRequests > requestsBefore);
  cancellation.abort();
  const cancelled = await pending;
  assert.equal(cancelled.envelope.errors[0].code, 'RUNTIME_READINESS_ABORTED');
  await until(() => openRequests === 0);
  assert.equal(record.state, 'RUNNING'); assert.equal(stops, 0);
  console.log(JSON.stringify({ ready: true, waitedBeyondDefault: true, timeoutKeptService: true, cancelled: true }));
} finally {
  await client.close(); await ipc.close();
  endpoint.closeAllConnections();
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  net.createConnection = originalConnect; syncBuiltinESMExports();
}
