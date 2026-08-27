import { runCli } from '../../main';

process.exitCode = await runCli(['daemon', 'serve', '--json']);
