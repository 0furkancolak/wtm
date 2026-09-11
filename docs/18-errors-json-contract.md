# Error and JSON Contract

## Envelope

Operational JSON commands return:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "status",
  "scope": {
    "mode": "local",
    "workspaceId": "..."
  },
  "data": {},
  "warnings": [],
  "errors": []
}
```

When `ok` is false, `errors` is non-empty and the CLI returns nonzero.

## Error item

```json
{
  "code": "GIT_HEAD_NOT_REMOTE_PERSISTED",
  "message": "HEAD is not reachable from an allowed remote-tracking ref.",
  "severity": "error",
  "context": {
    "worktreeId": 7,
    "branch": "feat/auth"
  },
  "remediation": [
    {
      "kind": "command-suggestion",
      "argv": ["git", "-C", "/path/to/wt", "push", "-u", "origin", "HEAD"]
    }
  ]
}
```

A remediation command is a suggestion, not an automatically approved action.

## Stable V1 error families

### Persistent jobs

```text
WTM_JOB_NOT_FOUND
WTM_JOB_QUEUE_FULL
WTM_JOB_IDEMPOTENCY_CONFLICT
WTM_JOB_NOT_QUEUEABLE
WTM_JOB_NOT_COMPLETE
WTM_JOB_UNSUCCESSFUL
WTM_JOB_SOURCE_CHANGED
WTM_JOB_MEMORY_ESTIMATE_REQUIRED
WTM_JOB_MEMORY_BUDGET_EXCEEDED
```

Job commands retain the V1 JSON envelope. A successful enqueue is durable acceptance, not a
successful task result. The acceptance includes `jobId`, `state`, `accepted`, `idempotencyKey`
and `reused`. Queries preserve the recorded task exit code independently of the CLI exit code.

| Error | CLI exit | Meaning |
| --- | --- | --- |
| `WTM_JOB_NOT_FOUND` | 2 | No visible retained job has that identifier in this queue scope. |
| `WTM_JOB_NOT_QUEUEABLE` | 2 | The task is not eligible, local machine/user identity is unavailable, or state belongs to a different host/user. |
| `WTM_JOB_MEMORY_ESTIMATE_REQUIRED` | 2 | Enabled memory admission requires a positive task estimate. |
| `WTM_JOB_MEMORY_BUDGET_EXCEEDED` | 2 | The estimate cannot fit the configured or known host capacity after headroom. |
| `WTM_JOB_QUEUE_FULL` | 3 | The bounded queue/history cannot accept another job. |
| `WTM_JOB_IDEMPOTENCY_CONFLICT` | 3 | The key already belongs to a different request; no second job ran. |
| `WTM_JOB_SOURCE_CHANGED` | 3 | The job's source/configuration evidence changed or cannot be verified. |
| `WTM_JOB_NOT_COMPLETE` | 1 | The job has not reached a completed, released state. |
| `WTM_JOB_UNSUCCESSFUL` | 1 | The completed task failed, was interrupted/cancelled, or timed out. |

`jobs result` preserves its data on refusal. Agents must read the terminal state, `exitCode`,
slot ownership and `sourceValidity`; an accepted/queued job is never evidence that tests passed.
`UNCHANGED` describes the documented Git-visible input snapshot, not ignored/external inputs
or an immutable source sandbox. Metadata carries command fingerprints, not resolved environment
values or secret-bearing argv. Task output may itself contain secrets, as with ordinary logs.

Temporary shortage or unknown memory evidence leaves the job queued with `memory_budget`
when earlier concurrency/FIFO/worktree gates permit considering it. Status remains a successful
lookup. If changed global policy makes an already queued job permanently unfit, claim records
`FAILED` and its memory error without a process, startedAt or invented exit code. `jobs result`
still applies the normal terminal/source/result checks. Legacy jobs retain null estimates;
enabling memory admission never invents a reservation amount or clears their held slots.

### Scope/config

```text
WTM_NOT_INITIALIZED
WTM_WORKSPACE_NOT_FOUND
WTM_CONFIG_INVALID
WTM_TEMPLATE_UNRESOLVED
WTM_DAEMON_UNAVAILABLE
WTM_DAEMON_INVALID_REQUEST
WTM_DAEMON_PROTOCOL_INCOMPATIBLE
WTM_DAEMON_REQUEST_FAILED
WTM_OPERATION_CONFLICT
WTM_WORKTREE_PATH_OCCUPIED
WTM_SOCKET_PATH_TOO_LONG
WTM_IPC_PATH_UNUSABLE
WTM_PRIVATE_DIRECTORY_UNSAFE
WTM_PLATFORM_UNSUPPORTED
WTM_WATCH_UNAVAILABLE
```

`WTM_OPERATION_CONFLICT` means another process already holds a destructive-operation lease on the
repository, so the requested operation would race it. The lease is repository-wide: any of
`remove`, `gc` and `repair` refuses the other two, not just a second attempt at the same one, so a
`wtm remove` is refused while a daemon `gc` is running on that repository. `context` carries
`repositoryId`, `operation` (what was requested), `holderOperation` (what is holding the
repository, which is the same as `operation` only when the collision is with the same operation),
`holderPid`, `acquiredAt`, `stage` (`null` while the holder is still live, otherwise the last stage
the abandoned holder recorded), and `abandoned`. A `--resume` remediation is offered only when
`holderOperation` equals `operation`: resuming continues *this* command's half-done work, and there
is none to continue in another operation's journal. It is a safety policy block, so it exits with
code 3.

`WTM_DAEMON_UNAVAILABLE` means a required daemon operation could not reach the daemon. It also
covers the case one step earlier, where WTM could not reach the *service manager* that would start
it: `launchctl` with no user domain on macOS, and `systemctl --user` with no session bus on Linux —
the ordinary state inside many containers, across `su`, and on a host with lingering disabled. The
message names the manager in force (`The systemd user domain is unavailable.`), and the usual Linux
remedy is `loginctl enable-linger "$USER"`, which gives the account a user manager that does not
depend on a login session. systemd does not spend a distinct exit status on a bus failure — it
exits 1, like a dozen ordinary refusals — so WTM classifies the condition rather than reading it
off the exit code, which is why it is one diagnosable answer on both platforms instead of a generic
request failure on one of them. It exits with code 4.

`WTM_SOCKET_PATH_TOO_LONG` means the daemon's Unix socket path does not fit in the platform's
socket address. The limit is that platform's `sizeof(sun_path)` — 104 bytes on macOS, 108 on
Linux — so on macOS a path of 104 bytes binds and one of 105 fails with `EINVAL`. It counts
bytes, not characters, and the message names whichever limit is in force. `context` carries `path` (the address that
was measured), `byteLength`, `limitBytes`, `exceededBy`, and both `publishedPath` and `boundPath` —
the daemon binds a private sibling and links the published name onto it, and the check measures
whichever of the two is longer. Nothing was bound or connected: the check runs before either. It is
a configuration the user has to change — a shorter home directory — so it exits with code 2.

`WTM_IPC_PATH_UNUSABLE` means the daemon's socket path, published or private, is occupied by
something WTM will not remove: a file other than WTM's own empty, `0600`, single-link placeholder
at least 30 s old, a symbolic link, a directory, or a file or socket owned by another user. WTM
reclaims only a stale socket of its own and that empty placeholder file its own shutdown leaves
behind when it is killed mid-close — a younger one is refused as transient instead, since a
service manager's next retry is expected to find it gone. `context` carries
`path`, `occupant` (`file`, `foreign-file`, `directory`, `symlink`, `foreign-socket` or `other`)
and `ownerUid`. The remediation is `rm <path>` where removing the path is the remedy, and
`wtm doctor` where it is not. A daemon run by launchd or systemd stops retrying on this code
instead of restarting forever. It is a condition a person has to clear, so it exits with code 2.

`WTM_PRIVATE_DIRECTORY_UNSAFE` means one of the directories WTM keeps private to the current user
(its data root, its database directory, or the daemon's socket directory) is one it will not use.
The directory is either a symbolic link, not a directory, owned by another user, or open to others
(any group or other permission bit set, reported as "readable by others"). WTM never repairs such a
directory itself. `context` carries `path` and `reason`. When the directory is only open to others,
the remediation is `chmod 700 <path>`. There is none for the other reasons, because what to do
depends on why the path is that way. A daemon run by launchd or systemd stops retrying on this code.

Some failures are not reported with this code, because they may clear on its own:
- a directory that could not be read at all;
- a directory that changed while WTM was checking it;
- a directory WTM has yet to create whose nearest existing parent belongs to another user, such as a
  home directory on a volume that is not mounted yet.

Each of these stays an uncoded failure that a service manager retries. The coded condition is one a
person has to clear, so it exits with code 2.

`WTM_PLATFORM_UNSUPPORTED` means WTM has no backend for the operating system it was started on.
`context` carries `platform`, the `process.platform` value that was refused, and `supported`, the
list of platform ids WTM does have a backend for. It exits with code 2: nothing about the workspace
is wrong, and no retry will help.

`WTM_WATCH_UNAVAILABLE` means a registered root could not be put under a filesystem watch, or could
not be put back under one. `context` carries `root` (the directory that could not be watched),
`errno` (the condition the host reported, or `null` when it reported none) and `platform` (the
backend whose remedy the message names). The message names the condition and the remedy for the
host WTM is running on: on Linux an `ENOSPC` is the inotify watch budget rather than the disk, and
the remediation raises `fs.inotify.max_user_watches`; an `EMFILE` names `fs.inotify.max_user_instances`
and the open-file limit; on macOS the same refusals name the open-file limit only. A condition WTM
has no specific remedy for is reported with the reading that produced it and no advice.

The daemon keeps serving while a root is unwatched — it still reconciles whenever something asks
it to — but it does not notice changes under that root on its own. It retries the watch with
backoff: the first attempt is immediate, then 1 s, 2 s, 4 s and so on to a ceiling of one attempt a
minute, so a raised limit is picked up within a minute without restarting the daemon.

It exits with code 2. The status is only ever seen when the refusal stopped `wtm daemon serve` from
starting, and at startup the reasons are host limits and permissions: something outside WTM has to
be raised or granted, and running the command again does not clear it. That is the same class as a
socket path that does not fit.

`WTM_WORKTREE_PATH_OCCUPIED` and `GIT_BRANCH_IN_USE` are `wtm create`'s two refusals, and both
are decided before Git writes anything, so nothing was created when either is reported.

`WTM_WORKTREE_PATH_OCCUPIED` means the path `create` computed —
`<workspace>/<repository-directory>-<branch-slug>` — already exists. `context` carries `branch` and
`path`. This is also what a slug collision looks like: `feat/auth` and `feat-auth` name the same
directory, and the second one is refused here rather than given a generated suffix, because a
computed path is only useful while a person can guess it.

`GIT_BRANCH_IN_USE` means the branch is already checked out in another worktree of the same
repository, which Git would refuse too — but as a pre-flight it can say *which* one. `context`
carries `branch` and `worktreePath`, the worktree holding it.

Both exit with code 3: nothing was done, and the caller has somewhere to look.

### Git

```text
GIT_COMMAND_FAILED
GIT_REPOSITORY_DEGRADED
GIT_MAIN_WORKTREE
GIT_WORKTREE_LOCKED
GIT_DIRTY_STAGED
GIT_DIRTY_UNSTAGED
GIT_UNTRACKED
GIT_UNTRACKED_SYMLINKS
GIT_IGNORED_CONTENT
GIT_BRANCH_IN_USE
GIT_UNMERGED
GIT_HEAD_NOT_REMOTE_PERSISTED
GIT_UPSTREAM_MISSING
```

`GIT_UNTRACKED` identifies untracked paths; `GIT_IGNORED_CONTENT` identifies ignored files or
directories reported by Git (including `.gitignore`, `info/exclude`, and global excludes).
Both carry worktree-relative `context.paths` and `context.count`, and both map to exit code 3.
`workingTree.counts.ignored` and `workingTree.paths.ignored` are separate from `untracked`;
consumers that need all local-only content must inspect both groups. Ignored directories can be
reported as one path ending in `/`; counts describe Git entries, not a recursive file count.

`GIT_UNTRACKED_SYMLINKS` reports `context.policy`, worktree-relative `paths` and `count`.
With `safety.untracked_symlinks = "block"` it is a non-deferrable removal blocker (exit 3).
With `review` it appears in warnings; a successful analysis still exits 0 and reports
`REVIEW` when no blocker exists. `ignore` is the default. These settings affect WTM's
decision; the final unforced Git command may still reject an untracked symlink.

### Runtime

```text
RUNTIME_PORT_UNAVAILABLE
RUNTIME_TASK_ALREADY_RUNNING
RUNTIME_TASK_NOT_RUNNING
RUNTIME_PROCESS_IDENTITY_STALE
RUNTIME_START_FAILED
RUNTIME_STOP_FAILED
RUNTIME_READINESS_TIMEOUT
RUNTIME_READINESS_FAILED
RUNTIME_READINESS_ABORTED
```

The three readiness errors map to exit code 1. A timeout reports `TIMED_OUT`; cancellation
reports `ABORTED`; a failed observation distinguishes `PROCESS_EXITED`, `PROCESS_CHANGED`,
`IDENTITY_UNCERTAIN` and `EVIDENCE_UNAVAILABLE`. Start/restart responses preserve the process
and observation in `data` even when `ok:false`. `READY` is the successful wait observation;
`NOT_CHECKED` is a start without a probe. Neither timeout nor abort stops the managed task.

### Adapter

```text
ADAPTER_NOT_TRUSTED
ADAPTER_PROTOCOL_INCOMPATIBLE
ADAPTER_TIMEOUT
ADAPTER_INVALID_RESPONSE
ADAPTER_DETECTION_AMBIGUOUS
ADAPTER_PLAN_CONFLICT
```

### Storage/cleanup

```text
RESOURCE_PATH_DENIED
RESOURCE_TRACKED_FILE_PROTECTED
RESOURCE_CLEANUP_FAILED
RESOURCE_CLONE_UNAVAILABLE
GC_ACTIVE_WORKTREE_PROTECTED
```

## Exit code classes

Recommended:

```text
0  success
1  generic operational failure
2  usage/config error
3  safety policy blocked requested action
4  daemon/IPC unavailable for required operation
5  protocol/adapter incompatibility
```

Scripts should prefer JSON `errors[].code` over interpreting the numeric code beyond the broad class.

## Human output

Human messages can change for readability. Stable automation must use `--json`.
