/**
 * One production `wtm remove`, in its own process.
 *
 * The cross-process guarantees — the repository operation lease, and the adoption of a lease
 * whose owner died — are only guarantees when the two callers really are two processes, so the
 * scenarios that assert them spawn this rather than calling `runCli` twice in one.
 *
 * Argv: `<databasePath> <globalConfigPath> <cwd> <selector> <socketPath|-> [flags…]`.
 * A `-` socket means "no daemon": a client that refuses every request, so the child can never
 * reach whatever daemon the developer running the suite happens to have on their own machine.
 */
import { DaemonClient } from '../client';
import type { RuntimeDaemonClient } from '../commands/runtime-client';
import { runCli } from '../main';

const [databasePath, globalConfigPath, cwd, selector, socketPath, ...flags] = process.argv.slice(2);
if (
  databasePath === undefined || globalConfigPath === undefined
  || cwd === undefined || selector === undefined || socketPath === undefined
) {
  process.stderr.write('remove-child: databasePath globalConfigPath cwd selector socketPath [flags…]\n');
  process.exit(2);
}

const daemon = socketPath === '-' ? null : new DaemonClient({ socketPath });
if (daemon !== null) await daemon.start().catch(() => {});
const client: RuntimeDaemonClient = daemon ?? {
  request: async () => { throw new Error('Daemon client is not connected'); },
};

let stdout = '';
let stderr = '';
const exitCode = await runCli(['remove', selector, '--json', ...flags], {
  cwd,
  analysisDatabasePath: databasePath,
  removalGlobalConfigPath: globalConfigPath,
  runtimeClient: client,
  stdout: (value) => { stdout += value; },
  stderr: (value) => { stderr += value; },
});
await daemon?.close();

process.stdout.write(`${JSON.stringify({ exitCode, envelope: JSON.parse(stdout), stderr })}\n`);
