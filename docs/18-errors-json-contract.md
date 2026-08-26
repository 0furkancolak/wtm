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

### Scope/config

```text
WTM_NOT_INITIALIZED
WTM_WORKSPACE_NOT_FOUND
WTM_CONFIG_INVALID
WTM_TEMPLATE_UNRESOLVED
WTM_DAEMON_UNAVAILABLE
```

### Git

```text
GIT_COMMAND_FAILED
GIT_REPOSITORY_DEGRADED
GIT_MAIN_WORKTREE
GIT_WORKTREE_LOCKED
GIT_DIRTY_STAGED
GIT_DIRTY_UNSTAGED
GIT_UNTRACKED
GIT_UNMERGED
GIT_HEAD_NOT_REMOTE_PERSISTED
GIT_UPSTREAM_MISSING
```

### Runtime

```text
RUNTIME_PORT_UNAVAILABLE
RUNTIME_TASK_ALREADY_RUNNING
RUNTIME_TASK_NOT_RUNNING
RUNTIME_PROCESS_IDENTITY_STALE
RUNTIME_START_FAILED
RUNTIME_STOP_FAILED
```

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
