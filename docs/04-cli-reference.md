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
--no-ai-skill     skip local Agent Skill installation
--no-detect       write only a name and a version, reading no repository
--json            machine-readable result
```

`--yes` records explicit acceptance of WTM's non-destructive defaults in the result contract as
`data.confirmation.defaultsAccepted`. V1 init is non-interactive, so this flag never approves destructive work.

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
| `git` | Whether every registered repository is still on disk |
| `config` | Whether the configuration resolves, and whether `[ports].range` can offer the ports it prefers |
| `adapters` | Which built-in adapters are in force, and why a detected one was left out |
| `resources` | How many declared resources are in place, and why one is not |
| `ports` | How many endpoints the workspace holds, and whether two worktrees hold the same one |
| `process-records` | How many supervised tasks are running, and which records name a process that is gone |

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
```

## Safe removal

### `wtm remove <selector>`

Runs analysis and only removes when all safety blockers pass.
The required selector accepts a registered numeric worktree ID, branch name, absolute path, or path relative to the current repository. Use `--json` for the stable V1 envelope.

V1 intentionally does **not** provide a loss-bypassing `--force` option.

If blocked, output includes concrete remediation categories such as:

```text
BLOCKED: uncommitted changes
  commit them, stash them outside WTM, or explicitly revert them yourself

BLOCKED: 2 commits are not present on an allowed remote ref
  push the branch first: git push -u origin HEAD
```

WTM never runs the suggested commit/push/reset/clean action automatically.

## Storage

### `wtm disk`

Reports logical use, WTM-owned resources and reclaimable estimates.

### `wtm gc`

Default safe GC only. It plans by default and applies the same guarded plan under `--apply`.

```bash
wtm gc
wtm gc --dry-run
wtm gc --apply
```

Dependency cache GC requires adapter-native cleanup plans and is never included in default GC.

## Daemon

```bash
wtm daemon install
wtm daemon uninstall
wtm daemon status
wtm daemon serve
```

`serve` is the internal foreground command used by launchd and development tests.

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
