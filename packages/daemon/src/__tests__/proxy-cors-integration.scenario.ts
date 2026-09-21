import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQLiteStateStore, initializeWorkspace } from '@wtm/core';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { resolveWorktreeRuntime } from '../task-resolution';

/**
 * W10-1: when `[proxy] enabled = true` in the daemon's global config, a worktree's CORS
 * allowlist gains the proxy hostname origin alongside the dynamic-port origin it already had,
 * for every endpoint that opts into a browser origin — and only those. Argv selects which of
 * three global-config shapes this run exercises, so the "disabled" case is its own process
 * rather than a mutation of state a prior case already touched.
 *
 * `web` has no `origin = false`, so it must get both origins when the proxy is enabled. `api`
 * sets `origin = false`, so it must never get a browser origin at all — dynamic-port or proxy —
 * which is the sanity check the parent unit asked for: an endpoint that opted out of a browser
 * origin does not get a proxy-hostname origin back through the proxy's side door.
 */
const mode = process.argv[2] ?? 'disabled';

const fixture = await createWorkspaceFixture();
const stateDirectory = join(fixture.userDataDir, 'state');
const globalConfigPath = join(fixture.userDataDir, 'config.toml');
let store: SQLiteStateStore | null = null;

try {
  await writeFile(join(fixture.linkedWorktreePath, '.env.example'), 'CORS_ORIGINS=\n');
  await writeFile(join(fixture.root, 'wtm.toml'), [
    'version = 1',
    '',
    '[workspace]',
    'name = "workspace with spaces"',
    '',
    '[ports]',
    'range = "31200-31299"',
    '',
    '[ports.web]',
    'preferred = 31250',
    '',
    '[ports.api]',
    'preferred = 31251',
    'origin = false',
  ].join('\n'));

  if (mode === 'enabled') {
    await writeFile(globalConfigPath, ['[proxy]', 'enabled = true', 'port = 34567'].join('\n'));
  } else if (mode === 'enabled-default-port') {
    await writeFile(globalConfigPath, ['[proxy]', 'enabled = true'].join('\n'));
  }
  // mode === 'disabled': no global config file at all, exactly like every daemon before this
  // unit shipped — the ENOENT path `globalProxyPolicy` already handled.

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  store = new SQLiteStateStore(join(stateDirectory, 'state.db'));
  await initializeWorkspace({ root: fixture.root, userDataDir: fixture.userDataDir, stateStore: store });

  const runtime = await resolveWorktreeRuntime({
    store,
    cwd: fixture.linkedWorktreePath,
    globalConfigPath,
    probe: () => true,
  });

  const webPort = runtime.endpoints.ports.web as number;
  const apiPort = runtime.endpoints.ports.api as number;

  process.stdout.write(`${JSON.stringify({
    origins: runtime.endpoints.origins,
    corsOrigins: runtime.automaticEnvironment.CORS_ORIGINS,
    webPort,
    apiPort,
  }, null, 0)}\n`);
} finally {
  store?.close();
  await rm(stateDirectory, { recursive: true, force: true });
  await fixture.cleanup();
}
