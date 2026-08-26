import { realpath } from 'node:fs/promises';
import {
  readGitCommonDirectory,
  runGit,
} from '../git/git-runner';
import { assertRemovable } from './remove-policy';
import {
  analyzeWorktree,
  WorktreeAnalysisError,
  type WorktreeAnalysis,
  type WorktreeContext,
} from './worktree-analysis';

interface GuardedRemovalHooks {
  afterInitialAnalysis?(analysis: WorktreeAnalysis): void | Promise<void>;
  onMutexWait?(): void;
  afterMutexAcquired?(): void;
}

interface RepositoryMutex {
  tail: Promise<void>;
  release: () => void;
}

const repositoryMutexes = new Map<string, RepositoryMutex>();

export async function removeWorktreeSafely(
  context: WorktreeContext,
): Promise<WorktreeAnalysis> {
  return removeWorktreeSafelyWithHooks(context, {});
}

export async function removeWorktreeSafelyWithHooks(
  context: WorktreeContext,
  hooks: GuardedRemovalHooks,
): Promise<WorktreeAnalysis> {
  const commonGitDirectory = await readGitCommonDirectory(context.repoPath);
  const repositoryKey = await realpath(commonGitDirectory);
  return withRepositoryMutex(repositoryKey, hooks, async () => {
    const initialAnalysis = await analyzeWorktree(context);
    assertRemovable(initialAnalysis);
    const identityToken = removalIdentityToken(initialAnalysis);

    await hooks.afterInitialAnalysis?.(initialAnalysis);

    const finalAnalysis = await analyzeWorktree(context);
    assertRemovable(finalAnalysis);
    assertIdentityUnchanged(identityToken, finalAnalysis);
    await runGit(context.repoPath, ['worktree', 'remove', '--', finalAnalysis.identity.path]);
    return finalAnalysis;
  });
}

async function withRepositoryMutex<T>(
  repositoryKey: string,
  hooks: GuardedRemovalHooks,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = repositoryMutexes.get(repositoryKey);
  if (previous !== undefined) hooks.onMutexWait?.();

  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousTail = previous?.tail ?? Promise.resolve();
  const entry = { tail: previousTail.then(() => turn), release };
  repositoryMutexes.set(repositoryKey, entry);

  await previousTail;
  try {
    hooks.afterMutexAcquired?.();
    return await operation();
  } finally {
    entry.release();
    if (repositoryMutexes.get(repositoryKey) === entry) repositoryMutexes.delete(repositoryKey);
  }
}

interface RemovalIdentityToken {
  path: string;
  headOid: string;
  branchRef: string | null;
  detached: boolean;
  isMain: boolean;
}

function removalIdentityToken(analysis: WorktreeAnalysis): RemovalIdentityToken {
  return {
    path: analysis.identity.path,
    headOid: analysis.identity.headOid,
    branchRef: analysis.identity.branchRef,
    detached: analysis.identity.detached,
    isMain: analysis.identity.isMain,
  };
}

function assertIdentityUnchanged(token: RemovalIdentityToken, analysis: WorktreeAnalysis): void {
  const current = removalIdentityToken(analysis);
  if (
    token.path !== current.path
    || token.headOid !== current.headOid
    || token.branchRef !== current.branchRef
    || token.detached !== current.detached
    || token.isMain !== current.isMain
  ) {
    throw new WorktreeAnalysisError(
      'Worktree identity changed between removal safety checks.',
      { initial: token, current },
    );
  }
}
