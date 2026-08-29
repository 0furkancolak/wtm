import { nodeSqliteDatabaseFactory } from '../../core/src/state/node-sqlite-driver';
import { installStateStoreRuntime } from '../../core/src/state/runtime';
import { installSkillAssets } from './assets';
import { runInternalMode } from './internal';
import { seaMigrationAssets, seaSkillAssets } from './sea-assets';

installStateStoreRuntime({
  databaseFactory: nodeSqliteDatabaseFactory,
  migrationAssets: seaMigrationAssets,
});
installSkillAssets(seaSkillAssets);

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const internalExitCode = await runInternalMode(argv);
  if (internalExitCode !== null) return internalExitCode;
  // Private runner modes must not pay for, or expose, the public CLI module graph.
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
