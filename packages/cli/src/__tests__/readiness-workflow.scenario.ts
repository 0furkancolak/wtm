import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { listGitWorktrees, readGitRepositoryIdentity, type ManagedProcessRecord } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import type { ObservedProcessIdentity } from '@wtm/platform/ports';
import { stringify } from 'smol-toml';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { createProductionDaemon, type ProductionDaemonRuntime } from '../../../daemon/src/runtime-factory';
import { DaemonClient } from '../client';
import { runCli } from '../main';

const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-ready-'));
const platform = selectPlatformRuntime().process;
let runtime: ProductionDaemonRuntime | null = null;
let client: DaemonClient | null = null;
let child: ObservedProcessIdentity | null = null;
let worktreeId: string | null = null;
const config = {
  version: 1,
  ports: { range: '38000-38999', web: { strategy: 'stable-dynamic' } },
  tasks: { dev: {
    run: [process.execPath, 'readiness-server.cjs', controls, '{port.web}'], background: true,
    healthcheck: { type: 'http', url: 'http://127.0.0.1:{port.web}/health', timeout: '8s', interval: '100ms' },
  } },
};
async function invoke(argv: string[]) {
  assert.ok(client);
  let output = '';
  const exitCode = await runCli([...argv, '--json'], { cwd: fixture.firstRepoPath, runtimeClient: client, stdout: (value) => { output += value; }, stderr: () => {} });
  return { exitCode, envelope: JSON.parse(output) };
}
try {
  await writeFile(join(fixture.firstRepoPath, 'readiness-server.cjs'), `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const controls = process.argv[2];
let readyAt;
http.createServer((_request, response) => {
  readyAt ??= performance.now() + 5500;
  const failed = fs.existsSync(path.join(controls, 'fail'));
  response.writeHead(failed || performance.now() < readyAt ? 503 : 204);
  response.end();
}).listen(Number(process.argv[3]), '127.0.0.1', () => fs.writeFileSync(path.join(controls, 'pid'), String(process.pid)));
`);
  await writeFile(join(fixture.root, 'wtm.toml'), stringify(config));
  runtime = await createProductionDaemon({
    dataRoot: join(fixture.userDataDir, 'readiness'), logRoot: join(fixture.userDataDir, 'logs'),
    socketPath: process.platform === 'win32' ? String.raw`\\.\pipe\wtm-ready-${basename(controls)}` : join(controls, 'daemon.sock'),
    globalConfigPath: join(controls, 'global.toml'), runtimeInvocation: developmentRuntimeInvocation(), gracePeriodMs: 500, pollIntervalMs: 25,
  });
  const workspace = runtime.stateStore.upsertWorkspace({ name: 'readiness', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml') });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtime.stateStore.upsertRepository({ workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: fixture.firstRepoPath, remoteIdentity: null });
  runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.firstRepoPath));
  worktreeId = runtime.stateStore.listWorktrees(repository.id).find((record) => record.isMain)!.id;
  await runtime.start();
  client = new DaemonClient({ socketPath: runtime.paths.socketPath }); await client.start();
  const started = await invoke(['start', 'dev', '--wait', '--timeout', '8s']);
  assert.equal(started.exitCode, 0, JSON.stringify(started));
  assert.equal(started.envelope.data.readiness.state, 'READY');
  assert.ok(started.envelope.data.readiness.elapsedMs >= 5500);
  const owner = started.envelope.data.process as ManagedProcessRecord;
  const inspected = await platform.inspectProcess(Number(await readFile(join(controls, 'pid'), 'utf8')));
  assert.equal(inspected.status, 'present', JSON.stringify(inspected));
  if (inspected.status === 'present') child = inspected.identity;
  const reused = await invoke(['start', 'dev', '--wait']);
  assert.equal(reused.exitCode, 0, JSON.stringify(reused));
  assert.equal(reused.envelope.data.existing, true);
  assert.equal(reused.envelope.data.process.id, owner.id);
  await writeFile(join(controls, 'fail'), 'fail');
  const timedOut = await invoke(['start', 'dev', '--wait', '--timeout', '200ms']);
  assert.equal(timedOut.exitCode, 1, JSON.stringify(timedOut));
  assert.equal(timedOut.envelope.errors[0].code, 'RUNTIME_READINESS_TIMEOUT');
  assert.equal(runtime.stateStore.getManagedProcess(owner.id)?.state, 'RUNNING');
  const changed = structuredClone(config);
  changed.tasks.dev.healthcheck.url = 'file:///invalid';
  await writeFile(join(fixture.root, 'wtm.toml'), stringify(changed));
  const invalid = await invoke(['restart', 'dev', '--wait']);
  assert.equal(invalid.exitCode, 2, JSON.stringify(invalid));
  assert.equal(invalid.envelope.errors[0].code, 'WTM_CONFIG_INVALID');
  assert.equal(runtime.stateStore.getManagedProcess(owner.id)?.state, 'RUNNING');
  assert.equal((await platform.inspectProcess(owner.pid)).status, 'present');
  const stopped = await invoke(['stop', 'dev']);
  assert.equal(stopped.exitCode, 0, JSON.stringify(stopped));
  assert.equal((await platform.inspectProcessGroup(owner.pgid)).status, 'absent');
  assert.ok(child);
  assert.equal((await platform.inspectProcess(child.pid)).status, 'absent');
  console.log(JSON.stringify({ readiness: true, existing: true, timeoutKeptService: true, invalidRestartPreservedService: true, groupAbsent: true }));
} finally {
  let safe = true;
  if (runtime !== null) {
    if (worktreeId !== null) {
      try { await runtime.supervisor.stopAll(worktreeId); } catch { safe = false; }
    }
    for (const record of runtime.stateStore.listManagedProcesses()) {
      try { if ((await platform.inspectProcessGroup(record.pgid)).status !== 'absent') safe = false; } catch { safe = false; }
    }
  }
  if (child !== null) {
    try {
      const inspected = await platform.inspectProcess(child.pid);
      if (inspected.status === 'failed' || (inspected.status === 'present' && inspected.identity.processStartTime === child.processStartTime)) safe = false;
    } catch { safe = false; }
  }
  try { await client?.close(); } finally { await runtime?.close(); }
  if (!safe) throw new Error('Native readiness cleanup is unconfirmed; fixture retained.');
  await rm(controls, { recursive: true, force: true }); await fixture.cleanup();
}
