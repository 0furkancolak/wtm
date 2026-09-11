import type { WtmErrorCode } from '@wtm/protocol';

/**
 * The exit status a failing command reports for a given error code.
 *
 * This lives in its own module because two callers need it and they cannot import each other:
 * `main.ts` imports `commands/daemon.ts`, so `commands/daemon.ts` cannot import back. It was
 * previously private to `main.ts`, which left `wtm daemon serve` carrying a one-row copy of the
 * table -- and a command reporting exit 1 for a condition every other command reports as 2 is the
 * defect that copy was introduced to fix, reappearing one level down.
 *
 * The status is a property of the error code, not of the command that raised it. Anything that
 * needs an exit status for a `WtmErrorCode` calls this.
 */
export function exitCodeForError(code: WtmErrorCode): number {
  if (code === 'WTM_DAEMON_UNAVAILABLE') return 4;
  if (code === 'ADAPTER_PROTOCOL_INCOMPATIBLE' || code === 'ADAPTER_INVALID_RESPONSE') return 5;
  // Configuration the user has to change, not something a retry can fix. `exitCodeForError` is
  // a partial mapping with a `return 1` default, so a code left out of it does not fail to
  // compile -- it silently exits 1. `__tests__/exit-codes.test.ts` is what makes that visible:
  // it enumerates `wtmErrorCodeSchema.options` and requires an explicit classification for every
  // one, so a newly registered code fails the suite until somebody decides its class.
  //
  // That test did not exist until Increment C1. This comment previously asserted it did, and the
  // gap it was supposed to close opened immediately: `WTM_PLATFORM_UNSUPPORTED` was registered in
  // the protocol and documented as exiting 2 while this function still returned 1 for it.
  if (
    code === 'WTM_CONFIG_INVALID'
    || code === 'WTM_JOB_NOT_QUEUEABLE'
    || code === 'WTM_JOB_MEMORY_ESTIMATE_REQUIRED'
    || code === 'WTM_JOB_MEMORY_BUDGET_EXCEEDED'
    || code === 'WTM_JOB_NOT_FOUND'
    || code === 'WTM_WORKSPACE_NOT_FOUND'
    || code === 'WTM_NOT_INITIALIZED'
    || code === 'WTM_SOCKET_PATH_TOO_LONG'
    // Something occupies the daemon's socket path that WTM will not remove. A retry finds the same
    // occupant; only a person can clear it, which is the class a supervised daemon stops on.
    || code === 'WTM_IPC_PATH_UNUSABLE'
    // A private directory that is a symbolic link, not a directory, another user's, or readable by
    // others. It stays that way until a person changes it. A directory that could not be *read* is
    // raised uncoded instead, because a retry can clear that one (todo item 51).
    || code === 'WTM_PRIVATE_DIRECTORY_UNSAFE'
    || code === 'WTM_PLATFORM_UNSUPPORTED'
    // No backend for this operating system. Nothing about the workspace is wrong and no retry
    // helps, which is the same class as a socket path that cannot fit: the user has to change
    // something outside WTM.
    || code === 'WTM_WATCH_UNAVAILABLE'
    // A watch the host refused to open. This status is only ever *seen* when the refusal
    // stopped `wtm daemon serve` from starting, and at startup the reasons are host limits and
    // permissions -- an exhausted `fs.inotify.max_user_watches`, a file-descriptor ceiling, a
    // root the daemon may not read. Every one of them is raised outside WTM and none of them is
    // cleared by running the command again, which is the same class as a socket path that does
    // not fit. Reporting it as 1 would tell a script to retry a condition that only a person
    // can change.
  ) return 2;
  if (
    code === 'GIT_MAIN_WORKTREE'
    || code === 'WTM_JOB_QUEUE_FULL'
    || code === 'WTM_JOB_IDEMPOTENCY_CONFLICT'
    || code === 'WTM_JOB_SOURCE_CHANGED'
    || code === 'GIT_WORKTREE_LOCKED'
    || code === 'GIT_DIRTY_STAGED'
    || code === 'GIT_DIRTY_UNSTAGED'
    || code === 'GIT_UNTRACKED'
    || code === 'GIT_UNTRACKED_SYMLINKS'
    || code === 'GIT_IGNORED_CONTENT'
    || code === 'GIT_UNMERGED'
    || code === 'GIT_HEAD_NOT_REMOTE_PERSISTED'
    // `wtm create`'s two refusals. Both are decided before Git writes anything, so nothing was
    // created and the caller has somewhere to look -- the worktree already holding the branch,
    // or the directory already at the path. That is the same class as a Git blocker, not a
    // configuration error the user must edit a file to clear.
    || code === 'GIT_BRANCH_IN_USE'
    || code === 'WTM_WORKTREE_PATH_OCCUPIED'
    // A second process already destroying this repository is a safety refusal, in the same
    // class as a Git blocker: nothing was done, and the caller has somewhere to look.
    || code === 'WTM_OPERATION_CONFLICT'
    || code === 'RESOURCE_PATH_DENIED'
    || code === 'GC_ACTIVE_WORKTREE_PROTECTED'
  ) return 3;
  return 1;
}
