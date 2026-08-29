#!/usr/bin/env node
import { runCli } from './main';
import { runInternalMode } from './internal';

const argv = process.argv.slice(2);
const internalExitCode = await runInternalMode(argv);
process.exitCode = internalExitCode ?? await runCli(argv);
