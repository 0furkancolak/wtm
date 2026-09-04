import { mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { writeExecutableFixture } from '../../../../testkit/src/executable-fixture';
import { resolveRealExecutablePath } from '../../../../testkit/src/real-executable';
import { GitCommandError } from '../../git/git-runner';
import { refreshRemoteTrackingRefs } from '../remote-persistence';
import { analyzeWorktree } from '../worktree-analysis';

/**
 * Proves out of process that analysis performs no network access: a `git` earlier on `PATH`
 * refuses every `fetch` and delegates everything else to the real one, so an analysis that
 * silently fetched could not finish. The refresh is run through the same shim afterwards to
 * show the shim is load-bearing rather than unreachable.
 */
const fixture = await createGitSafetyFixture();
try {
  const realGit = resolveRealExecutablePath('git');
  const fakeDirectory = join(fixture.root, 'fake-bin');
  await mkdir(fakeDirectory, { recursive: true });
  await writeExecutableFixture(join(fakeDirectory, 'git'), `const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('fetch')) {
  process.stderr.write('shim: git fetch is not allowed here\\n');
  process.exit(78);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(result.stdout ?? Buffer.alloc(0));
process.stderr.write(result.stderr ?? Buffer.alloc(0));
process.exit(result.status ?? 1);
`);
  process.env.PATH = `${fakeDirectory}${delimiter}${process.env.PATH ?? ''}`;

  const analysis = await analyzeWorktree({
    repoPath: fixture.repoPath,
    worktreePath: fixture.linkedWorktreePath,
    baseRef: 'refs/heads/main',
  });
  const refreshFailure = await refreshRemoteTrackingRefs(fixture.repoPath).then(
    () => null,
    (error: unknown) => (error instanceof GitCommandError
      ? { code: error.code, exitCode: error.exitCode }
      : String(error)),
  );

  process.stdout.write(`${JSON.stringify({
    readiness: analysis.safety.readiness,
    blockerCodes: analysis.safety.blockers.map((blocker) => blocker.code),
    remoteKnowledge: analysis.remoteKnowledge,
    refreshFailure,
  })}\n`);
} finally {
  await fixture.cleanup();
}
