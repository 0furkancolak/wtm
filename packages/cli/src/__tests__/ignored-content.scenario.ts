import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runCli } from '../main';

const fixture = await createGitSafetyFixture();
const originalLstat = fs.lstat;
try {
  const target = join(fixture.linkedWorktreePath, '.env');
  await fixture.write(fixture.repoPath, '.git/info/exclude', '.env\n');
  await fixture.write(fixture.linkedWorktreePath, '.env', 'private content\n');
  const result: Record<string, unknown> = {};
  for (const command of ['analyze', 'remove']) {
    let stdout = '';
    const exitCode = await runCli([command, fixture.linkedWorktreePath, '--json'], {
      cwd: fixture.repoPath,
      analysisDatabasePath: join(fixture.root, 'absent.db'),
      removalGlobalConfigPath: join(fixture.root, 'absent.toml'),
      stdout: (value) => { stdout += value; }, stderr: () => {},
    });
    result[command] = { exitCode, envelope: JSON.parse(stdout) };
  }
  result.preservedContent = await fs.readFile(target, 'utf8');

  // Permission failures cannot reliably be induced with chmod when the runner is root.
  // Substitute only this filesystem boundary in an isolated Node process; Git and CLI stay real.
  fs.lstat = ((...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === target) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
    return originalLstat(...args);
  }) as typeof fs.lstat;
  syncBuiltinESMExports();
  let stdout = '';
  result.unreadableExitCode = await runCli(['remove', fixture.linkedWorktreePath, '--json'], {
    cwd: fixture.repoPath,
    analysisDatabasePath: join(fixture.root, 'absent.db'),
    removalGlobalConfigPath: join(fixture.root, 'absent.toml'),
    stdout: (value) => { stdout += value; }, stderr: () => {},
  });
  result.unreadableEnvelope = JSON.parse(stdout);
  result.unreadableContentPreserved = await fs.readFile(target, 'utf8');
  process.stdout.write(JSON.stringify(result));
} finally {
  fs.lstat = originalLstat;
  syncBuiltinESMExports();
  await fixture.cleanup();
}
