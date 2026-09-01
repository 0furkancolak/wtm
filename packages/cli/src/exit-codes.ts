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
  // compile -- it silently exits 1, which is why every code here is pinned by a test.
  if (
    code === 'WTM_CONFIG_INVALID'
    || code === 'WTM_WORKSPACE_NOT_FOUND'
    || code === 'WTM_NOT_INITIALIZED'
    || code === 'WTM_SOCKET_PATH_TOO_LONG'
  ) return 2;
  if (
    code === 'GIT_MAIN_WORKTREE'
    || code === 'GIT_WORKTREE_LOCKED'
    || code === 'GIT_DIRTY_STAGED'
    || code === 'GIT_DIRTY_UNSTAGED'
    || code === 'GIT_UNTRACKED'
    || code === 'GIT_UNMERGED'
    || code === 'GIT_HEAD_NOT_REMOTE_PERSISTED'
    // A second process already destroying this repository is a safety refusal, in the same
    // class as a Git blocker: nothing was done, and the caller has somewhere to look.
    || code === 'WTM_OPERATION_CONFLICT'
    || code === 'RESOURCE_PATH_DENIED'
    || code === 'GC_ACTIVE_WORKTREE_PROTECTED'
  ) return 3;
  return 1;
}
