# CLI Reference

## General scoping rule

WTM commands operate on the workspace containing the current directory unless a workspace/path selector is given.

`--global` means **all registered workspaces**, not "scan the entire home directory".

Examples:

```bash
wtm status
wtm status --global
wtm analyze --global
wtm ports --global
```

Destructive commands still require an explicit worktree selector even when global scope is used.

## Initialization

### `wtm init [path]`

Creates a local `wtm.toml` when absent, scans repositories/worktrees, records adapter detection and registers the workspace. A complete existing file is used byte-for-byte; if required minimal fields are missing, init returns non-secret `requiredChanges` and remediation without modifying the file. It never returns reconstructed user configuration in ordinary error context.

Into a file it creates, `init` also writes what the repositories declare — endpoint ports, CORS variables, and addresses that name another repository. Against a file that already exists, it reports them instead: `data.pendingConfig` carries the tables that are missing, and `data.configBlocks` says which are already decided. See [`wtm detect`](#wtm-detect-path) and [Detection](03-configuration-spec.md#detection).

Options:

```text
--yes             accept non-destructive proposed defaults
--max-depth <n>   discovery depth
--ai-skill        also install the local Agent Skill, as `wtm skill install` does
--no-detect       write only a name and a version, reading no repository
--json            machine-readable result
```

`--yes` records explicit acceptance of WTM's non-destructive defaults in the result contract as
`data.confirmation.defaultsAccepted`. V1 init is non-interactive, so this flag never approves destructive work.

Registering writes `wtm.toml` and nothing else into the project. Everything else WTM can put
there — the Agent Skill among them — is asked for explicitly, so adopting WTM in someone else's
repository adds one file they can read, and leaves the rest of it exactly as it was.

### `wtm init --global [path]`

Registers a workspace without writing `wtm.toml` into the selected directory; the configuration is stored in user WTM data. On `init` and `skill install`, `--global` selects a destination rather than scoping a read, and each carries its own help text saying so.

### `wtm detect [path]`

Reports what each repository in the workspace declares — the port it wants and the variable it wants it under, the CORS allowlist variables it reads, and the addresses that point at another repository — together with the TOML that says it.

Without a path, `detect` answers for the workspace the current directory belongs to, like every other command; a path is read as the workspace root instead.

```text
--write           append the tables wtm.toml does not have yet
--max-depth <n>   discovery depth
--json            machine-readable result
```

`--write` never edits a line already in the file: it appends only tables the file does not define, and warns about the rest. A port a repository asks for that `[ports].range` cannot offer is written as a comment naming the range that would fit, so the configuration stays valid. Without a `wtm.toml` to add to, `--write` fails and points at `wtm init`.

Only variable names and safe values — a port, or a bare `http(s)` address — are read from `.env` files; see [Detection](03-configuration-spec.md#detection) for the full list of sources.

## Status and diagnostics

### `wtm status [selector]`

Shows resolved worktree identity, state, endpoints, processes and runtime resources.

### `wtm doctor [selector]`

Runs deterministic checks for Git, config, adapters, resources, ports and process records.

| Check | What it answers |
| --- | --- |
| `registration` | Whether this directory is inside a worktree WTM has registered, and — separately — whether the daemon is reachable. These are different problems with different fixes, so they are never reported as one another |
| `git` | Whether every registered repository is still on disk |
| `config` | Whether the configuration resolves, and whether `[ports].range` can offer the ports it prefers |
| `adapters` | Which built-in adapters are in force, and why a detected one was left out |
| `resources` | How many declared resources are in place, and why one is not |
| `ports` | How many endpoints the workspace holds, and whether two worktrees hold the same one |
| `process-records` | How many supervised tasks are running, and which records name a process that is gone |
| `socket-path` | How much room is left under the platform's Unix socket path limit, reported as a warning while there is still headroom rather than only once the daemon cannot bind |

### `wtm explain [selector]`

Every choice in force in this worktree, and where it came from.

| Kind | One per | Provenance |
| --- | --- | --- |
| `config` | Configuration leaf, and each variable the environment ends up with | The file and line that settled it, or `wtm:derived` |
| `adapter` | Adapter that recognized the worktree | Why it is in force, or which rule excluded it |
| `task` | Task that can be run here | The configuration, or `adapter:<id>` |
| `resource` | `[resources.<name>]` | The line that declares it, and the state this worktree has it in |

The `env.<NAME>` decisions are the useful half: they name the *layer* that won each variable —
`[repos.<name>.environment]` over `[environment]` over what WTM derived — which is the question
somebody asks when `PORT` is not what they expected.

`explain` resolves the way a task would, so an endpoint with no lease is given one. Use `plan`
for the question that must not change its own answer.

### `wtm plan [selector]`

What WTM would do next, and what it would leave alone. Nothing here changes anything: the
runtime is resolved without leasing a port, resources are inspected rather than created, and
detection only reads.

| Kind | `create` | `none` |
| --- | --- | --- |
| `config` | A table detection would add, with the TOML that says it | — |
| `endpoint` | A declared endpoint this feature has no port for | The port it already holds |
| `resource` | A declared resource that is not there | One that is |
| `process` | — | A running task; `remove` for a record whose process is gone |
| `adapter` | — | A detected adapter that was excluded, and why |

V1 ships `plan` only; there is no separate apply command. `wtm detect --write` applies the
`config` half.

## Task execution

### `wtm run <task>`

Runs a configured task in the foreground with resolved environment/context.

```text
--json      emit the stable JSON envelope
-h, --help  display help for command
```

### `wtm exec <argv...>`

Executes raw argv in the foreground with the same resolved environment/context. The argument is a command line, not a configured task name; use `wtm run <task>` for tasks.

```text
--json      emit the stable JSON envelope
-h, --help  display help for command
```

### `wtm start <task>`

Starts a managed background task owned by the current worktree.

### `wtm stop [task]`

Stops one task or all WTM-managed tasks for the selected worktree.

### `wtm restart <task>`

Equivalent to safe stop + start.

### `wtm resolve <task>`

Prints the final command, cwd and environment delta without running it.
Use `--json` for the stable V1 envelope. The argument is always a configured task name; it is not a worktree selector.

Example:

```text
$ wtm resolve dev
cwd: /Users/me/workspace/api
command: make dev-with-worktree-7
```

Unknown top-level words do not automatically execute shell commands. Tasks are always addressed by name through `wtm run`, `wtm start`, `wtm restart` or `wtm resolve`.

## Runtime commands

### `wtm ps`

Lists the WTM-managed process groups of the whole workspace — a feature that spans two repositories runs two servers, and both are the answer.

### `wtm ports`

Shows endpoint leases.

### `wtm env`

Prints the resolved environment delta. Options are `--json` and `--global`.

### `wtm logs [task]`

Reads managed task logs.

```bash
wtm logs dev --follow
```

## Worktree analysis

### `wtm analyze [selector]`

Produces the advanced worktree analysis defined in `10-git-safety-worktree-analysis.md`.
The optional selector accepts a registered numeric worktree ID, branch name, absolute path, or path relative to the current repository. `--all`, `--cleanup-candidates`, and `--global` are mutually exclusive aggregate modes and cannot be combined with a selector.

Useful modes:

```bash
wtm analyze
wtm analyze --all
wtm analyze --cleanup-candidates
wtm analyze --global --json
wtm analyze --refresh-remotes
```

Options:

```text
--all                  every worktree in the current repository
--cleanup-candidates   linked worktrees that may be cleanup candidates
--refresh-remotes      refresh remote-tracking refs first (network access)
--global               aggregate registered workspaces only
--json                 emit the stable JSON envelope
```

`--refresh-remotes` runs `git fetch --prune` for every remote an allowed remote-ref pattern
selects, before any analysis, and names the remotes it refreshed in the human output — not in the
envelope, which is a compatibility contract, so `--json` stdout still parses as exactly one
envelope. It fetches **once per
distinct repository**, not once per worktree: the aggregate modes analyze many worktrees that
share one repository, and a refresh hung off each analysis would send ten fetch rounds where one
is honest. `--prune` is the load-bearing half — see
[Remote freshness](10-git-safety-worktree-analysis.md#remote-freshness).

The refresh **fails closed**: a fetch that fails fails the command with `GIT_COMMAND_FAILED` and
reports no analysis at all. Continuing on stale refs is the outcome the flag exists to prevent, so
neither downgrading the confidence nor reporting `REFRESHED` over unchanged refs is offered.

Without the flag, analysis performs no network access. Every analysis carries a
`remoteKnowledge` block saying which of the two it was.

## Safe removal

### `wtm remove <selector>`

Runs the removal lifecycle of [Safe remove flow](10-git-safety-worktree-analysis.md#safe-remove-flow):
analysis, then the runtime work — stopping this worktree's managed tasks, deleting the resources
WTM materialized in it, releasing its ports — then a second analysis, and only then Git.
The required selector accepts a registered numeric worktree ID, branch name, absolute path, or path relative to the current repository. Use `--json` for the stable V1 envelope.

Options:

```text
--refresh-remotes  refresh remote-tracking refs first (network access)
--resume           continue a removal whose process died, adopting its abandoned lease
--json             emit the stable JSON envelope
```

`--refresh-remotes` behaves exactly as it does on `analyze`, for the one repository the selector
resolves in.

`--resume` is for the second half of a removal whose process died. WTM holds one destructive-operation
lease per repository and journals the stage it reached on that lease, so a killed `wtm remove` leaves
a row naming both. A plain re-run refuses with `WTM_OPERATION_CONFLICT` rather than continuing
someone else's half-finished cleanup by accident; `--resume` adopts the lease and runs the lifecycle
again from the top. Every stage is idempotent, so re-running one that had already completed is
harmless — which is why resumption re-runs rather than skipping ahead: the journal says where the
dead process stopped writing, not what it finished doing.

V1 intentionally does **not** provide a loss-bypassing `--force` option.

If blocked, output includes concrete remediation categories such as:

```text
BLOCKED: uncommitted changes
  commit them, stash them outside WTM, or explicitly revert them yourself

BLOCKED: 2 commits are not present on an allowed remote ref
  push the branch first: git push -u origin HEAD
```

WTM never runs the suggested commit/push/reset/clean action automatically.

A successful removal reports what the runtime gave back before Git ran:

```json
{
  "removed": { "path": "…", "branchRef": "refs/heads/feat/auth", "headOid": "…" },
  "cleanup": {
    "stoppedProcesses": 2,
    "releasedEndpoints": 2,
    "collectedResources": 1,
    "retainedResources": [{ "name": "node_modules", "reason": "shared" }]
  },
  "analysis": { "…": "…" }
}
```

| Field | Meaning |
| --- | --- |
| `stoppedProcesses` | Managed processes the daemon stopped for this worktree |
| `releasedEndpoints` | Endpoint leases moved from `ACTIVE` to `RELEASED` |
| `collectedResources` | `[resources]` paths WTM created inside the worktree and deleted; a target already absent is not one |
| `retainedResources` | What WTM declined to delete, and why — `shared`, `native-cache`, `external`, `ignore`, or the reason its path could not be resolved |

The block is always present and zeroed rather than omitted, including on the Git-only path a
worktree WTM has no registration for takes, so the shape never varies.

`remove` needs the daemon when — and only when — the worktree has managed process records that are
still live or still owe durable cleanup. WTM never signals a process the daemon supervises from a
second process, so an unreachable daemon there is `WTM_DAEMON_UNAVAILABLE` and a refusal, not a
best-effort kill. A worktree with no such records is removed with no daemon at all.

## Exit codes

| Code | Meaning | Raised by |
| --- | --- | --- |
| `0` | Success | — |
| `1` | Generic operational failure | Every code not listed below |
| `2` | Usage or configuration error | `WTM_CONFIG_INVALID`, `WTM_WORKSPACE_NOT_FOUND`, `WTM_NOT_INITIALIZED` |
| `3` | A safety policy blocked the requested action | `GIT_MAIN_WORKTREE`, `GIT_WORKTREE_LOCKED`, `GIT_DIRTY_STAGED`, `GIT_DIRTY_UNSTAGED`, `GIT_UNTRACKED`, `GIT_UNMERGED`, `GIT_HEAD_NOT_REMOTE_PERSISTED`, `WTM_OPERATION_CONFLICT`, `RESOURCE_PATH_DENIED`, `GC_ACTIVE_WORKTREE_PROTECTED` |
| `4` | The daemon is unavailable for an operation that requires it | `WTM_DAEMON_UNAVAILABLE` |
| `5` | Protocol or adapter incompatibility | `ADAPTER_PROTOCOL_INCOMPATIBLE`, `ADAPTER_INVALID_RESPONSE` |

An envelope carrying several errors exits with the highest of their codes.

`WTM_OPERATION_CONFLICT` is in the safety class rather than the generic one because it means the
same thing a Git blocker does: nothing was changed, and there is somewhere concrete to look — the
error names the holding PID, when it took the lease, and, when that holder is provably gone, the
stage it died in.

`wtm exec` is the one command whose exit code is not this table: it passes the child's own status
through, and reports a signalled child as `128 + signal`.

## Storage

### `wtm disk`

Reports logical use, WTM-owned resources and reclaimable estimates, split three ways: `owned`
and `unknown` for the objects in adapter-managed sandboxes, and `worktree` for what
`[resources]` has put inside this worktree. The third is measured but never collected, and a
symbolic link is counted as the link it is, not as the file in the main worktree it points at.

### `wtm gc`

Default safe GC only. It plans by default and applies the same guarded plan under `--apply`.

```bash
wtm gc
wtm gc --dry-run
wtm gc --apply
```

Dependency cache GC requires adapter-native cleanup plans and is never included in default GC.

GC never walks a Git working tree, so the resources `[resources]` creates inside a worktree are
outside every plan. `gc` warns which ones those are rather than leaving the silence to be read
as "there is nothing else"; removing the worktree removes them.

## Registration

### `wtm forget [selector]`

Retires a workspace registration. Rows only — it never deletes a file.

```bash
wtm forget                    # the workspace containing the current directory
wtm forget old-migration      # by name, id, or path
wtm forget live-workspace --force
```

A registered root can stop existing: a finished migration deleted, a clone moved, a volume gone
for good. `wtm doctor` reports the absence on every run, and this is what answers it. A
registration whose directory is still on disk is refused without `--force`, because retiring it
loses its endpoint leases and process records. Registering again is one `wtm init`.

The selector decides what is retired:

| Selector | Retires |
| --- | --- |
| omitted | the workspace containing the current directory |
| a workspace name or id | that workspace, with every repository in it |
| a path that is exactly a registered repository root | that repository alone |
| any other path | the workspace containing it |

A repository can be retired on its own because the workspace-sized instrument is often the
wrong one: finished migrations whose directories are gone sit inside a workspace whose other
repositories are in daily use. A path that is both a repository root and the workspace root
retires the workspace, since retiring the repository alone would leave nothing behind it.

## Daemon

```bash
wtm daemon install
wtm daemon uninstall
wtm daemon status
wtm daemon serve
```

`serve` is the internal foreground command used by launchd and development tests.

`install` reports one of four states:

| State | Meaning |
| --- | --- |
| `installed` | No LaunchAgent was registered; one is now. |
| `reinstalled` | The definition changed and the service was replaced. |
| `restarted` | The definition was already correct, and the service was restarted so that the executable now running is the one just installed. |
| `already-installed` | Another `install` won the race and its service is loaded. |

`restarted` is the ordinary result of installing a new build over an old one. The plist names
the executable by path, so a new build leaves the definition identical — without the restart,
launchd goes on running the previous binary and the install changes nothing you can observe.

`status` reports these fields:

| Field | Meaning |
| --- | --- |
| `state` | `loaded` when launchd knows the job, `installed-not-loaded` when the plist is on disk but launchd does not know it, `absent` when there is neither. |
| `runState` | launchd's own word for the job: `running` while a process is alive, `not running` while the job is loaded but idle, `null` when launchd does not know the job. |
| `label` | The launchd label this `HOME` publishes under, `dev.wtm.daemon.<digest>`. |
| `plistPath` | The LaunchAgent definition named by that label, always inside this `HOME`. |
| `reachable` | Whether the daemon answered on its socket. launchd reports a service as running the moment it forks, which says nothing about whether a command would work. |

Every one of them describes the same agent: the label is derived from the resolved `HOME`, and
`state`, `runState` and `plistPath` are all read for that label. A constant label made them
describe different agents — under a second `HOME`, `state` and `runState` came from the first
`HOME`'s LaunchAgent while `plistPath` named a file that had never been loaded.

## Skill

```bash
wtm skill print
wtm skill install
wtm skill install --global
```

The canonical source is `skills/wtm/SKILL.md`.

`skill install --global` installs into `~/.agents/skills` instead of the current workspace.

## JSON guarantee

All operational commands support `--json` unless their purpose is raw stream output (`logs --follow`) or fixed canonical text (`skill print`). Stable fields are versioned with `schemaVersion`.

Human-readable text is not an API.
