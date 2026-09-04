import { access, mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { listGitWorktrees } from '@wtm/core';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { writeExecutableFixture } from '../../../../testkit/src/executable-fixture';
import { resolveRealExecutablePath } from '../../../../testkit/src/real-executable';
import { runRemoveCommand } from '../remove';

const fixture = await createGitSafetyFixture();
try {
  const realGit = resolveRealExecutablePath('git');
  const fakeDirectory = join(fixture.root, 'fake-bin');
  await mkdir(fakeDirectory, { recursive: true });
  const malformed = [
    '2 R. N... 100644 100644 100644 0123456789012345678901234567890123456789',
    '0123456789012345678901234567890123456789 R100',
    '? must-not-be-consumed.txt',
    '',
  ].join('\0');
  await writeExecutableFixture(join(fakeDirectory, 'git'), `const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('status')) {
  process.stdout.write(Buffer.from(${JSON.stringify(malformed)}, 'utf8'));
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(result.stdout ?? Buffer.alloc(0));
process.stderr.write(result.stderr ?? Buffer.alloc(0));
process.exit(result.status ?? 1);
`);
  process.env.PATH = `${fakeDirectory}${delimiter}${process.env.PATH ?? ''}`;

  const envelope = await runRemoveCommand({
    repoPath: fixture.repoPath,
    selector: fixture.linkedWorktreePath,
    baseRef: 'refs/heads/main',
  });
  const topology = await listGitWorktrees(fixture.repoPath);
  let pathExists = true;
  try {
    await access(join(fixture.linkedWorktreePath, 'feature.txt'));
  } catch {
    pathExists = false;
  }
  process.stdout.write(`${JSON.stringify({
    envelope,
    pathExists,
    topologyContains: topology.some((record) => record.path === fixture.linkedWorktreePath),
  })}\n`);
} finally {
  await fixture.cleanup();
}
