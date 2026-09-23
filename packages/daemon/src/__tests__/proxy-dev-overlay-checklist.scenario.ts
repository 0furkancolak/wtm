import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { join } from 'node:path';
import { listGitWorktrees, readGitRepositoryIdentity, slugifyBranchLabel } from '@wtm/core';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { createProductionDaemon } from '../runtime-factory';

/**
 * Regression test for the wiring gap fixed alongside this file: `createProductionDaemon` used to
 * hand the dev-overlay html injector `stateStore` itself, which has no `listChecklistItems` (only
 * `stateStore.checklist.list(...)`), so the overlay's checklist section rendered empty on every
 * real daemon no matter how many items `wtm checklist set` had stored. `dev-overlay.test.ts` and
 * `proxy-dev-overlay.test.ts` both cover the rendering logic in isolation, against a hand-built
 * store double that *does* implement `listChecklistItems` — so neither would ever have caught a
 * regression in the production wiring itself. This scenario goes through the real
 * `createProductionDaemon` composition and a real HTTP round trip instead, the way a browser
 * actually reaches the overlay.
 */
const fixture = await createWorkspaceFixture();
let backend: Server | undefined;

try {
  const stateDirectory = join(fixture.userDataDir, 'state');
  const globalConfigPath = join(fixture.userDataDir, 'config.toml');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

  const backendHtml = '<html><body>hello from backend</body></html>';
  const backendPort = await new Promise<number>((resolve) => {
    backend = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(backendHtml);
    });
    backend.listen(0, '127.0.0.1', () => {
      const address = backend!.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  // The daemon config schema requires a real, positive `[proxy] port` (`port = 0` — "let the OS
  // pick one" — is rejected), so a free port is found the same way `backendPort` above was: bind
  // once on port 0, read back what the OS handed out, close, and reuse that number in the config.
  const proxyConfigPort = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
  await writeFile(globalConfigPath, [
    '[proxy]', 'enabled = true', `port = ${proxyConfigPort}`, '',
    '[dev-overlay]', 'enabled = true',
  ].join('\n'));

  const runtime = await createProductionDaemon({
    dataRoot: stateDirectory,
    logRoot: join(fixture.userDataDir, 'logs'),
    globalConfigPath,
    // Mirrors `proxy.ts`'s own note: binds `127.0.0.1` alone, since a sandbox without IPv6
    // support can't bind `::1` — production always takes the full default pair.
    proxyHosts: ['127.0.0.1'],
  });

  try {
    const workspace = runtime.stateStore.upsertWorkspace({
      name: 'fixture', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
    });
    const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
    const repository = runtime.stateStore.upsertRepository({
      workspaceId: workspace.id,
      commonGitDir: identity.commonGitDir,
      mainRoot: fixture.firstRepoPath,
      remoteIdentity: null,
    });
    runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.firstRepoPath));
    const worktree = runtime.stateStore.listWorktrees(repository.id)
      .find((candidate) => candidate.path === fixture.firstRepoPath);
    if (worktree === undefined) throw new Error('fixture worktree missing before allocateEndpoint');

    if (runtime.stateStore.checklist === undefined) throw new Error('production state store has no checklist support');
    runtime.stateStore.checklist.set(worktree.id, ['Verify the thing works'], new Date().toISOString());

    const lease = runtime.stateStore.allocateEndpoint({
      worktreeId: worktree.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: backendPort, max: backendPort },
      preferredPort: backendPort,
    }, () => true);

    await runtime.start();
    if (runtime.proxy === null) throw new Error('proxy did not start with [proxy] enabled = true');
    const [address] = runtime.proxy.addresses();
    if (address === undefined) throw new Error('proxy bound no address');

    const shortBranch = worktree.branch === null
      ? worktree.id
      : worktree.branch.replace(/^refs\/heads\//, '');
    const hostHeader = `${lease.name}.${slugifyBranchLabel(shortBranch)}.wtm.localhost`;
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: address.host === '' ? '127.0.0.1' : address.host,
        port: address.port,
        method: 'GET',
        path: '/',
        headers: { host: hostHeader },
      }, (incoming) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
      });
      request.on('error', reject);
      request.end();
    });

    console.log(JSON.stringify({
      status: response.status,
      containsBackendHtml: response.body.includes('hello from backend'),
      containsChecklistText: response.body.includes('Verify the thing works'),
      containsChecklistCheckbox: response.body.includes('type="checkbox"'),
    }));
  } finally {
    await runtime.close();
  }
} finally {
  await new Promise<void>((resolve) => { backend === undefined ? resolve() : backend.close(() => resolve()); });
  await fixture.cleanup();
}
