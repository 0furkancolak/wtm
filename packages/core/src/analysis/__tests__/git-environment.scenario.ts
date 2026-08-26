import { join } from 'node:path';
import { analyzeWorktree } from '../worktree-analysis';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';

const scenario = process.argv[2];
if (scenario === undefined) throw new Error('Scenario name is required');

if (scenario === 'hostile-routing') {
  const fixtureA = await createGitSafetyFixture();
  const fixtureB = await createGitSafetyFixture();
  try {
    await fixtureA.write(fixtureA.linkedWorktreePath, 'feature.txt', 'repo A authoritative\n');
    const routing = {
      GIT_DIR: join(fixtureB.repoPath, '.git'),
      GIT_WORK_TREE: fixtureB.linkedWorktreePath,
      GIT_COMMON_DIR: join(fixtureB.repoPath, '.git'),
      GIT_INDEX_FILE: join(fixtureB.repoPath, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(fixtureB.repoPath, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(fixtureB.repoPath, '.git', 'objects'),
      GIT_NAMESPACE: 'hostile',
      GIT_CEILING_DIRECTORIES: fixtureB.root,
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
      GIT_PREFIX: 'hostile-prefix',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: fixtureB.linkedWorktreePath,
    };
    Object.assign(process.env, routing, { WTM_ENV_SENTINEL: 'preserved' });
    const before = routingSnapshot();

    const analysis = await analyzeWorktree({
      repoPath: fixtureA.repoPath,
      worktreePath: fixtureA.linkedWorktreePath,
      baseRef: 'refs/heads/main',
    });

    const repoBStatus = await fixtureB.git(fixtureB.linkedWorktreePath, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching',
    ]);
    process.stdout.write(`${JSON.stringify({
      analyzedPath: analysis.identity.path,
      blockerCodes: analysis.safety.blockers.map((blocker) => blocker.code),
      repoBStatus: repoBStatus.stdout,
      environmentUnchanged: JSON.stringify(before) === JSON.stringify(routingSnapshot()),
      sentinel: process.env.WTM_ENV_SENTINEL,
    })}\n`);
  } finally {
    await fixtureA.cleanup();
    await fixtureB.cleanup();
  }
} else if (scenario === 'global-excludes') {
  const fixture = await createGitSafetyFixture();
  try {
    const configPath = join(fixture.root, 'isolated-global.gitconfig');
    const excludesPath = join(fixture.root, 'isolated-global-excludes');
    await fixture.write(fixture.root, 'isolated-global-excludes', 'global.secret\n');
    await fixture.git(fixture.repoPath, ['config', '--file', configPath, 'core.excludesFile', excludesPath]);
    await fixture.write(fixture.linkedWorktreePath, 'global.secret', 'must survive removal\n');
    process.env.GIT_CONFIG_GLOBAL = configPath;
    const before = process.env.GIT_CONFIG_GLOBAL;

    const analysis = await analyzeWorktree({
      repoPath: fixture.repoPath,
      worktreePath: fixture.linkedWorktreePath,
      baseRef: 'refs/heads/main',
    });

    process.stdout.write(`${JSON.stringify({
      blockerCodes: analysis.safety.blockers.map((blocker) => blocker.code),
      untrackedPaths: analysis.workingTree.paths.untracked,
      globalConfigUnchanged: process.env.GIT_CONFIG_GLOBAL === before,
    })}\n`);
  } finally {
    await fixture.cleanup();
  }
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}

function routingSnapshot(): Record<string, string | undefined> {
  return {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    GIT_NAMESPACE: process.env.GIT_NAMESPACE,
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM,
    GIT_PREFIX: process.env.GIT_PREFIX,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    WTM_ENV_SENTINEL: process.env.WTM_ENV_SENTINEL,
  };
}
