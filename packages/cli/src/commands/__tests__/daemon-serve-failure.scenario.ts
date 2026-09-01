import { runCli } from '../../main';

/**
 * A daemon whose startup fails with an error carrying build-machine frames, run through the
 * production reporter. The stack is written by hand because a stack raised inside the test
 * tree names the test tree; the frames a released binary raises name the machine that built
 * it, and those are the frames this scenario exists to keep off the user's terminal.
 */
const failure = new Error('The WTM daemon runtime could not be created.');
failure.stack = [
  'Error: The WTM daemon runtime could not be created.',
  '    at createProductionDaemon (/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs:41337:19)',
  '    at serveDaemon (/Users/runner/work/wtm/wtm/dist/sea/.build/sea-bin.cjs:41202:24)',
].join('\n');

process.exitCode = await runCli(['daemon', 'serve', '--json'], {
  daemonRuntimeFactory: async () => { throw failure; },
});
