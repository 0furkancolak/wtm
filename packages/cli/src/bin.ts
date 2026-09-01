#!/usr/bin/env node
import { runInternalMode } from './internal';
import { ignoreClosedOutput } from './pipe';

async function run(): Promise<number> {
  ignoreClosedOutput();
  const argv = process.argv.slice(2);
  const internalExitCode = await runInternalMode(argv);
  if (internalExitCode !== null) return internalExitCode;
  // Private runner modes must not pay for, or expose, the public CLI module graph.
  return await (await import('./main')).runCli(argv);
}

// `runCli` recognises usage errors and nothing else, so anything unforeseen used to leave this
// entry as an unhandled rejection and Node printed the whole trace -- frames naming the machine
// that built the release, which tell the person reading them nothing they can act on. The shape
// here is `sea-bin.ts`'s: the condition, one line, status 1.
run().then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    const trimmed = raw.trim();
    const firstBreak = trimmed.search(/[\r\n]/);
    const message = firstBreak === -1 ? trimmed : `${trimmed.slice(0, firstBreak).trimEnd()} [...]`;
    process.stderr.write(`${message === '' ? 'The command failed for an unknown reason.' : message}\n`);
    process.exitCode = 1;
  },
);
