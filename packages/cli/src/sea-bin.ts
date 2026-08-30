import { runInternalMode } from './internal';

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const internalExitCode = await runInternalMode(argv);
  if (internalExitCode !== null) return internalExitCode;
  // Private runner modes must not pay for, or expose, the public CLI module graph.
  // An anchor supervises a task for its whole lifetime, so the SQLite driver and the
  // embedded assets stay unloaded until a command that reads state actually runs.
  const { nodeSqliteDatabaseFactory } = await import('../../core/src/state/node-sqlite-driver');
  const { installStateStoreRuntime } = await import('../../core/src/state/runtime');
  const { installEndpointProbe, spawnedEndpointProbe } = await import('../../core/src/runtime/endpoints');
  const { installSkillAssets } = await import('./assets');
  const { seaMigrationAssets, seaSkillAssets } = await import('./sea-assets');
  installStateStoreRuntime({
    databaseFactory: nodeSqliteDatabaseFactory,
    migrationAssets: seaMigrationAssets,
  });
  installSkillAssets(seaSkillAssets);
  // This executable has no `-e`, so the default probe would fail every port it was offered.
  installEndpointProbe(spawnedEndpointProbe(process.execPath, ['__wtm_internal_endpoint_probe']));
  const { runCli } = await import('./main');
  return runCli(argv, { runtimeInvocation: { executable: process.execPath, prefixArgs: [] } });
}

run().then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
