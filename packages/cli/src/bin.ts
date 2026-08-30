#!/usr/bin/env node
import { runInternalMode } from './internal';
import { ignoreClosedOutput } from './pipe';

ignoreClosedOutput();
const argv = process.argv.slice(2);
const internalExitCode = await runInternalMode(argv);
// Private runner modes must not pay for, or expose, the public CLI module graph.
process.exitCode = internalExitCode ?? await (await import('./main')).runCli(argv);
