import { describe, expect, test } from 'bun:test';
import { wtmErrorCodeSchema, type WtmErrorCode } from '@wtm/protocol';
import { exitCodeForError } from '../exit-codes';

/**
 * The test `exit-codes.ts` needed in order for its own comment to be true.
 *
 * `exitCodeForError` is a partial mapping with a `return 1` default, so a code nobody classified
 * does not fail to compile — it silently exits 1. The module's comment claimed every code was
 * pinned by a test; no test imported the module at all, and the first code registered after that
 * comment was written (`WTM_PLATFORM_UNSUPPORTED`) went straight through the gap: documented in
 * `docs/18-errors-json-contract.md` as exiting 2, actually exiting 1.
 *
 * So the pin is exhaustive by construction. The table below is the decision, spelled once; adding a
 * code to the protocol without adding it here fails the first test, and changing a class without
 * meaning to fails the second. Neither can be satisfied by a regex or by a default.
 */
const expectedExitCodes: Readonly<Record<WtmErrorCode, number>> = {
  // 2 — the user has to change something outside WTM. No retry helps.
  WTM_NOT_INITIALIZED: 2,
  WTM_WORKSPACE_NOT_FOUND: 2,
  WTM_CONFIG_INVALID: 2,
  WTM_SOCKET_PATH_TOO_LONG: 2,
  WTM_PLATFORM_UNSUPPORTED: 2,
  WTM_WATCH_UNAVAILABLE: 2,

  // 3 — a safety refusal. Nothing was done, and the caller has somewhere to look.
  GIT_MAIN_WORKTREE: 3,
  GIT_WORKTREE_LOCKED: 3,
  GIT_DIRTY_STAGED: 3,
  GIT_DIRTY_UNSTAGED: 3,
  GIT_UNTRACKED: 3,
  GIT_UNMERGED: 3,
  GIT_HEAD_NOT_REMOTE_PERSISTED: 3,
  WTM_OPERATION_CONFLICT: 3,
  RESOURCE_PATH_DENIED: 3,
  GC_ACTIVE_WORKTREE_PROTECTED: 3,

  // 4 — the daemon is not answering. A distinct class because a caller can act on it: start it.
  WTM_DAEMON_UNAVAILABLE: 4,

  // 5 — an adapter spoke a protocol WTM cannot use. Distinct so a caller can disable the adapter.
  ADAPTER_PROTOCOL_INCOMPATIBLE: 5,
  ADAPTER_INVALID_RESPONSE: 5,

  // 1 — a general failure. This is the default, and each of these is a deliberate acceptance of
  // it rather than an omission; that distinction is the whole reason the table is exhaustive.
  WTM_TEMPLATE_UNRESOLVED: 1,
  WTM_DAEMON_INVALID_REQUEST: 1,
  WTM_DAEMON_PROTOCOL_INCOMPATIBLE: 1,
  WTM_DAEMON_REQUEST_FAILED: 1,
  GIT_COMMAND_FAILED: 1,
  GIT_REPOSITORY_DEGRADED: 1,
  GIT_UPSTREAM_MISSING: 1,
  RUNTIME_PORT_UNAVAILABLE: 1,
  RUNTIME_TASK_ALREADY_RUNNING: 1,
  RUNTIME_TASK_NOT_RUNNING: 1,
  RUNTIME_PROCESS_IDENTITY_STALE: 1,
  RUNTIME_START_FAILED: 1,
  RUNTIME_STOP_FAILED: 1,
  ADAPTER_NOT_TRUSTED: 1,
  ADAPTER_TIMEOUT: 1,
  ADAPTER_DETECTION_AMBIGUOUS: 1,
  ADAPTER_PLAN_CONFLICT: 1,
  RESOURCE_TRACKED_FILE_PROTECTED: 1,
  RESOURCE_CLEANUP_FAILED: 1,
  RESOURCE_CLONE_UNAVAILABLE: 1,
};

describe('exitCodeForError', () => {
  test('classifies every code the protocol registers, with none left to the default by accident', () => {
    const registered = [...wtmErrorCodeSchema.options].sort();
    const classified = Object.keys(expectedExitCodes).sort();

    expect(classified).toEqual(registered);
  });

  test('reports the classified status for every registered code', () => {
    for (const code of wtmErrorCodeSchema.options) {
      expect({ code, exit: exitCodeForError(code) })
        .toEqual({ code, exit: expectedExitCodes[code] });
    }
  });

  test('the classes are the five the CLI documents, and nothing else', () => {
    const classes = new Set(wtmErrorCodeSchema.options.map((code) => exitCodeForError(code)));

    expect([...classes].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
