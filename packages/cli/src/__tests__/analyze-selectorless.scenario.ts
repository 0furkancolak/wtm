import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { writeExecutableFixture } from '../../../testkit/src/executable-fixture';
import { resolveRealExecutablePath } from '../../../testkit/src/real-executable';
import { runCli } from '../main';

/**
 * Item 47 final review, finding 4: plain `wtm analyze` (no selector, no aggregate mode) called
 * `runProductionAnalyze`'s own `listGitWorktrees(cwd)` to find `repositoryRoot`, and then called
 * the shared selector's `collectSelectorCandidates` unconditionally — which, with no selector and
 * no store to short-circuit it, runs one more `git worktree list` and only then discovers it has
 * nothing to add over the first call's own `topology.find`. Counted here the way
 * `refresh-remotes.scenario.ts` counts `git fetch`: a `git` earlier on `PATH` that logs every
 * `worktree list` invocation and delegates to the real binary. A plain analysis already runs this
 * twice on its own (this lookup, then one more inside the analysis proper); the fix removes the
 * third, the one the shared selector's now-skipped call added.
 */
async function installWorktreeListCountingGit(directory: string, logPath: string): Promise<void> {
  const realGit = resolveRealExecutablePath('git');
  await mkdir(directory, { recursive: true });
  await writeExecutableFixture(join(directory, 'git'), `const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('worktree') && args.includes('list')) appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(result.stdout ?? Buffer.alloc(0));
process.stderr.write(result.stderr ?? Buffer.alloc(0));
process.exit(result.status ?? 1);
`);
  process.env['PATH'] = `${directory}${delimiter}${process.env['PATH'] ?? ''}`;
}

async function countWorktreeListInvocations(logPath: string): Promise<number> {
  try {
    return (await readFile(logPath, 'utf8')).split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-analyze-selectorless-')));
const logPath = join(root, 'worktree-list.log');
await installWorktreeListCountingGit(join(root, 'fake-bin'), logPath);

const fixture = await createGitSafetyFixture();
try {
  let stdout = '';
  const exitCode = await runCli(['analyze', '--json'], {
    cwd: fixture.repoPath,
    analysisDatabasePath: join(fixture.root, 'absent.db'),
    removalGlobalConfigPath: join(fixture.root, 'absent-global.toml'),
    stdout: (value) => { stdout += value; },
    stderr: () => {},
  });
  const envelope = JSON.parse(stdout);
  const worktreeListInvocations = await countWorktreeListInvocations(logPath);
  process.stdout.write(`${JSON.stringify({ exitCode, ok: envelope.ok, worktreeListInvocations })}\n`);
} finally {
  await fixture.cleanup();
}
