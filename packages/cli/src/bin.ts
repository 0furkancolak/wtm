#!/usr/bin/env node
import { runCli } from './main';

process.exitCode = await runCli(process.argv.slice(2));
