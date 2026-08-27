import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [role, pidFile, mode] = process.argv.slice(2);

if (role === 'member') {
  if (mode === 'ignore-term' || mode === 'child-ignore') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
  process.send?.('ready');
} else if (role === 'natural') {
  const timer = setInterval(() => {}, 1_000);
  process.on('SIGUSR1', () => {
    process.stdout.write('natural stdout\n');
    process.stderr.write('natural stderr\n');
    process.exitCode = 0;
    clearInterval(timer);
  });
  if (pidFile !== undefined) await writeFile(pidFile, String(process.pid));
} else if (role === 'parent' && pidFile !== undefined && mode !== undefined) {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  const memberSource = `
    if (process.argv[1] === 'ignore-term' || process.argv[1] === 'child-ignore') {
      process.on('SIGTERM', () => {});
    }
    setInterval(() => {}, 1_000);
    process.send?.('ready');
  `;
  const child = spawn(process.execPath, ['-e', memberSource, mode], {
    stdio: mode === 'exit-parent' ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
  });
  if (child.pid === undefined) throw new Error('Fixture child did not receive a PID');
  if (mode === 'exit-parent') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture child readiness timed out')), 5_000);
      child.once('message', (message) => {
        if (message !== 'ready') return;
        clearTimeout(timer);
        resolve();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Fixture child exited before readiness')));
    });
    child.disconnect();
  }
  await writeFile(pidFile, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
  if (mode === 'exit-parent') child.unref();
  else setInterval(() => {}, 1_000);
} else {
  throw new Error('Invalid process-group fixture arguments');
}
