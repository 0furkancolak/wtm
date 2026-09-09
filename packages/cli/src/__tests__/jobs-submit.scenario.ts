import { runCli } from '../main';

const [socketPath, cwd, key] = process.argv.slice(2);
if (!socketPath || !cwd || !key) throw new Error('Missing queue submission fixture arguments');
process.exitCode = await runCli(['run', 'check', '--enqueue', '--idempotency-key', key, '--json'], {
  cwd, daemonSocketPath: socketPath,
});
