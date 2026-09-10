---
name: wtm-worktree-runtime
description: Use when developing, testing, diagnosing, creating, analyzing, or cleaning up Git worktrees in a workspace managed by WTM. Prefer WTM for ports, environment, workspace tasks, runtime processes, and safe worktree removal instead of manual per-worktree setup.
---

# WTM Worktree Runtime

## Goal

Operate a WTM-managed Git worktree without manually selecting ports, copying environment files, rediscovering parent workspace commands, or bypassing worktree safety.

## Start every WTM workflow

Run:

```bash
wtm doctor --json
wtm status --json
```

Use the platform check in `wtm doctor --json` to identify the active backend and its paths.
macOS uses a per-user LaunchAgent, Linux a systemd user service, and the experimental Windows
backend a per-user Scheduled Task and named pipe. Windows implementation and test coverage
do not imply that its native validation is complete; report capability failures as returned.
Do not translate another platform's paths or service commands by hand.

Use the same WTM subcommands from PowerShell and Git Bash; their quoting, environment
assignment and path syntax differ. Prefer configured argv-array tasks and WTM's own `status`,
`ports`, `ps`, `stop`, and `doctor` commands. Avoid shell-specific `kill`, `pkill`, or `lsof`
workarounds. Use `wtm daemon status --json` to inspect the service, `wtm daemon install` when
installation is authorized, and `wtm skill install` for the documented skill installer.

If WTM says the current directory is not initialized, do not invent WTM configuration. Report it or, when initialization is part of the user's request, run:

```bash
wtm init --yes --json
```

## Development and tests

Prefer WTM task execution over invoking a project command directly:

```bash
wtm run <task>
```

### Heavy builds, tests, and typechecks

Use the shared job queue when the task is explicitly configured with `queue = true` and a
finite `timeout` (for example `timeout = "10m"`). Queue support applies to configured tasks;
do not guess that an inherited adapter task is queueable. A long-running development server
belongs under `wtm start <task>` and must not be marked queueable.

```bash
wtm run typecheck --enqueue --idempotency-key <unique-request-key> --json
```

1. Choose and save a unique request key **before** sending. Store `data.jobId` after acceptance.
   Reuse that request key only when retrying this same submission after an ambiguous response;
   use a new key for a genuinely new run. If WTM generated a key, an ambiguous failure returns
   it in the error context. A successful enqueue response means the job was accepted, not that
   the task passed. The daemon continues after the submitting CLI exits.
   Deduplication lasts only while the job record is retained; an old key can run again after
   pruning. Never retry an expired key as though it guarantees exactly-once execution.
2. Continue with code reading, planning, or independent work in another worktree. While a job
   is queued or running, do not edit its input files, shared configuration, dependency files,
   or another worktree's files if the task reads them. Coordinate with other agents that can
   write those inputs; the submission's HEAD alone does not identify the source being tested.
3. Check status when useful, with at least 10 seconds between checks and longer intervals for
   long jobs. Inspect a bounded log tail when diagnosing progress. Do not create a tight polling
   loop or occupy a tool call waiting while independent work remains.

   ```bash
   wtm jobs status <job-id> --json
   wtm jobs logs <job-id> --tail 100 --json
   ```

   For a queued job, read `data.job.waitingReason` as the current scheduling observation:

   | Value | Meaning |
   | --- | --- |
   | `concurrency` | Global slots are occupied, including slots held until process cleanup is verified. |
   | `worktree_busy` | The FIFO head shares a worktree with a job that still holds a slot. |
   | `fifo` | An earlier queued job must be considered first. |
   | `dispatch_pending` | Awaiting scheduler dispatch and preflight checks; launch is not guaranteed. |
   | `memory_budget` | The configured estimate cannot fit current memory/headroom evidence; continue independent work without bypassing the queue. |

   The value is `null` outside `QUEUED`. Older daemons may omit the field; an omitted reason
   is unknown. Continue independent work at the same polling interval; these observations do
   not establish available RAM or a successful task result.

4. Before any dependent step or claim that a test/build passed, read the result:

   ```bash
   wtm jobs result <job-id> --json
   ```

   Require `ok: true`, `data.terminal: true`, `data.successful: true`,
   `data.job.state: "SUCCEEDED"`, `data.job.exitCode: 0`, and
   `data.job.slotHeld: false`, `data.sourceValidity: "UNCHANGED"`. Pending, failed, cancelled, timed-out, interrupted,
   changed-source and unknown-source results are not successful validation. Preserve their
   exit code and diagnostics. After editing inputs again, the old result cannot validate those
   edits; submit a new job when validation is needed.
5. Cancel an obsolete queued/running job explicitly:

   ```bash
   wtm jobs cancel <job-id> --json
   ```

   Cancellation can remain pending while WTM verifies process-tree termination; inspect its
   state and `slotHeld`. Do not kill managed processes yourself to release a slot.

The queue accepts at most 128 pending/slot-owning jobs and at most 384 total records. Enqueue
opportunistically prunes finished history toward 256 jobs and a seven-day retention period;
unverified cleanup prevents deletion. Each job stream rotates at 1 MiB with one archive, and
log queries return at most 32 KiB per stream before applying the requested line count.
Inspect failures while their records/logs remain available; older full output is not retained.

Source evidence covers Git tracked/untracked file bytes, index and HEAD, and file identity /
modification metadata. Existing-file change-and-revert operations change that metadata too.
It does not measure ignored dependencies or external inputs. Snapshot scans are bounded
(10,000 files, 64 MiB, 4 seconds per snapshot) and reject symlinks/submodules rather than
pretending to validate their contents. A scan is not an atomic snapshot; transient files
created and deleted between observations may escape it. `UNCHANGED` is scoped evidence, not
an immutable worktree guarantee. Keep input writers coordinated and do not claim it covers
unmeasured dependencies.
Ancestor metadata is conservative: creating ignored output inside a tracked source directory
can invalidate the result. Do not dismiss a changed result merely because tracked bytes match.

The queue coordinates WTM submissions across repositories for the same host, OS user and
state store. The database has one machine/user owner, claimed before process recovery;
foreign-host/user state is refused. Use host-local state when HOME is shared, and do not
remove its ownership record to bypass a refusal. Separately configured state stores have
independent limits. Optional global `jobs.memory` uses each queued task's `memory_estimate_mib`,
available memory and headroom. Estimate the whole worker tree, and use the task's `queue_env`
for its actual tool-specific worker settings. This overrides ordinary task environment only
in the queue; `wtm resolve` still describes the ordinary task. `memory_budget` means wait for
memory/evidence; do not bypass it by running the same heavy command directly. Missing or
permanently unfit estimates are explicit errors; inspect configuration before retrying.
Neither concurrency nor estimated memory admission is a hard RAM limit. Directly launched
commands bypass the queue. This skill neither intercepts
all terminal commands nor automatically wakes an agent when a job completes. Agent-specific
notifications/hooks require a separate verified integration.

The first upgrade adopts older unscoped state under the existing host-local-state assumption.
Its old records cannot prove their originating host. Upgrade only state already local to
this host; do not treat legacy shared-host adoption as verified or supported.

For a long-running task WTM should supervise, and for raw argv that is not a configured task:

```bash
wtm start <task>
wtm exec -- <argv>
```

When a dependent step needs an HTTP service to be ready, configure its task healthcheck
and use `wtm start <task> --wait --timeout 30s --json` (or `wtm restart <task> --wait --json`).
Require `ok:true` and `data.readiness.state: READY` before proceeding. An ordinary start
reports `NOT_CHECKED`; a live PID alone does not prove application readiness. Timeout,
failed evidence and client cancellation are unsuccessful observations and leave the service
running. Readiness is an observation of that endpoint and managed process at that time,
not a guarantee of future health. Inspect `wtm logs <task>` and stop explicitly when needed.

When a task behaves unexpectedly, inspect its resolved context before changing project files:

```bash
wtm resolve <task> --json
wtm env --json
wtm ports --json
```

## Tasks WTM already knows

A workspace's tasks come from `wtm.toml` and from what the repository already describes:

- `make:<target>` runs a target of this worktree's own `Makefile`.
- `workspace:<target>` runs a target of the workspace root's `Makefile`, at that root, across every repository under it.

Resolve a task rather than guessing a command; `wtm resolve <task> --json` reports the exact argv, working directory, and environment.

## Ports and CORS

WTM allocates an endpoint per configured name, per feature — a branch, across every repository that has it checked out. Two worktrees of one feature therefore agree on every port, which is how a web application addresses the API of its own branch.

- Read a port with `{port.<name>}` in `wtm.toml`.
- Publish it per repository with `[repos.<name>.environment]`, not `[environment]`, when more than one repository reads the same variable name (`PORT` usually is).
- Read the browser origins of the feature with `{cors.origins}`.
- `preferred` must fall inside `[ports].range`; widen the range rather than removing the preference.

## Configuration WTM writes for itself

`wtm init` reads each repository — `.env.example`, `package.json`, compose files, `Makefile` — and writes what it finds into `wtm.toml`: the port each repository wants, the variable it wants it under, its CORS allowlist variable, and any address that points at another repository in the workspace.

```bash
wtm detect --json          # what the repositories declare now, and the TOML that says it
wtm detect --write --json  # append the tables wtm.toml does not have yet
```

- Run `wtm detect` after adding a repository to the workspace, or after a repository starts reading a new address or port.
- Read `data.additions` for the exact TOML, and the envelope's `warnings` for what was left alone and why.
- Neither command edits a line already in the file. If detection is wrong, correct `wtm.toml` — it is the source of truth, and detection defers to it.
- Values are read only from `.env` example files, and only when they are a port or a bare `http(s)` address. Do not expect WTM to carry any other value, and do not put a secret where it would have to.

## Rules

- Do not manually choose a port managed by WTM, and do not read one out of a running process; ask `wtm resolve`/`wtm ports`.
- Do not copy `.env` files between worktrees unless WTM's resolved resource plan explicitly requires it.
- Do not symlink/shared-write `node_modules`, `.venv`, `.next`, `target`, `build`, or similar directories as a workaround.
- Do not bypass a workspace-level Makefile/task convention by guessing a relative path; use WTM task resolution.
- Prefer `wtm run`/`wtm start`/`wtm exec -- ...` when environment/runtime ownership matters.
- Use `--json` for reasoning and automation; human text is not a stable machine contract.

## Worktree analysis

Before proposing cleanup or deletion, run:

```bash
wtm analyze --json
```

Treat every `safety.blockers` item as authoritative for the WTM deletion path.

Every analysis carries `remoteKnowledge`. `confidence: "LOCAL_ONLY"` means the remote-persistence
verdict came from local refs that may be days old — a branch deleted on the remote still looks
persisted. Before deleting on that evidence, re-check with a fetch:

```bash
wtm analyze <selector> --refresh-remotes --json
```

That uses the network. Do not run it on every analysis; run it before a removal whose safety turns
on `remotePersistence`.

## Removal safety

Use:

```bash
wtm remove <selector>
wtm remove <selector> --refresh-remotes   # fetch --prune first, then decide
wtm remove <selector> --resume            # only after WTM asks for it, see below
```

`remove` stops this worktree's managed tasks, deletes the resources WTM materialized in it, and
releases its ports before Git deletes anything. Do not stop tasks or delete resource directories by
hand first.

Queued jobs and occupied job slots are a separate precondition: any such job in the repository
blocks removal, cleanup and registration retirement. Let it finish or explicitly cancel it
through `wtm jobs cancel <job-id> --json`, then confirm the terminal state and `slotHeld: false`
before retrying. Removal does not silently cancel jobs.

Never replace a blocked WTM removal with:

```bash
git worktree remove -f ...
```

Read `errors[].code` and handle the refusal, do not work around it:

| `errors[].code` | Exit | What it means, and what to do |
| --- | --- | --- |
| `GIT_DIRTY_*`, `GIT_UNTRACKED`, `GIT_IGNORED_CONTENT`, `GIT_UNMERGED`, `GIT_HEAD_NOT_REMOTE_PERSISTED`, `GIT_WORKTREE_LOCKED`, `GIT_MAIN_WORKTREE` | 3 | Real work would be lost. Report the blocker and its remediation. Ignored content is separate from untracked content; inspect both `workingTree.paths.ignored` and `workingTree.paths.untracked`. |
| `GIT_UNTRACKED_SYMLINKS` | 3 | Configured `safety.untracked_symlinks = "block"` protects these links, including resource-owned ones. Report the listed paths; do not unlink them or weaken the policy to make removal pass. Under `review`, the same code is advisory in `warnings`, not a failed command. |
| `WTM_OPERATION_CONFLICT` with `context.jobId` | 3 | A queued job or held slot protects this repository. Inspect the job; let it finish or cancel it explicitly and verify slot release before retrying. `--resume` does not bypass this conflict. |
| `WTM_OPERATION_CONFLICT` with `context.holderPid` | 3 | Another process holds a repository operation lease. Inspect `holderPid` and `acquiredAt`; do not retry in a loop. |
| `WTM_OPERATION_CONFLICT` with `context.abandoned: true` | 3 | The previous removal's process died at `context.stage`. This is the only case for `--resume`; the error's remediation carries the exact command. |
| `WTM_DAEMON_UNAVAILABLE` | 4 | The daemon owns running processes here and cannot be reached. Start it with `wtm daemon install` — never `kill`/`pkill` them yourself. |
| `RUNTIME_STOP_FAILED` | 1 | Managed process records outlived their stop. The worktree is intact. Check `wtm ps --json` and `wtm doctor --json`. |

A success reports what the runtime gave back in `data.cleanup`: `stoppedProcesses`,
`releasedEndpoints`, `collectedResources`, and `retainedResources` with the reason each survived.
A `shared` resource surviving one worktree is correct, not a failure.

If WTM reports uncommitted/untracked work or local-only commits, report the blocker and the suggested remediation. Do not automatically commit, push, reset, clean, or discard changes unless the user explicitly requested that separate Git action.

## Diagnostics

If daemon/runtime state appears stale:

```bash
wtm daemon status --json
wtm doctor --json
```

Do not work around WTM by hard-coding ports/env unless the user specifically asks to bypass WTM.

## Completion check

Before claiming the development environment is ready:

```bash
wtm doctor --json
wtm status --json
```

If you started a managed task, verify its state through WTM rather than assuming the child command survived.
