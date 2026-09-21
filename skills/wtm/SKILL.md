---
name: wtm-worktree-runtime
description: Use when the working directory contains or sits under a wtm.toml, when the user mentions WTM or the wtm command, or when developing, testing, starting dev servers, creating, analyzing or removing Git worktrees in a WTM-managed workspace, including while a push, pull request or CI run is pending.
---

# WTM Worktree Runtime

## What WTM is

WTM (Worktree Runtime Manager) runs many Git worktrees of a workspace side by side on one machine.

- **Workspace**: a directory with `wtm.toml`, holding one or more repositories. A **worktree** is one
  checkout of a repository; a **feature** is a branch, across every repository that has it.
- A per-user **daemon** (launchd, systemd user service, or experimental Windows Scheduled Task)
  supervises managed processes and owns the SQLite state store.
- Each feature gets its own **ports** and resolved **environment**; tasks come from `wtm.toml`,
  from each worktree's `Makefile` (`make:<target>`) and the workspace root's (`workspace:<target>`).
- Heavy finite tasks go through a machine-wide **job queue** with concurrency and memory admission.
- **Removal** refuses whenever work would be lost.

## This file is the complete reference

Use this file to run WTM; do not research WTM elsewhere. For every WTM action:

1. Find the command in the command map below.
2. Run it with `--json`.
3. If `ok` is `false`, act on `errors[].code` and `errors[].remediation` (its `argv` is the exact
   command to run next).

Open the README, `docs/` or `--help` only when an error names a command or flag this file does
not contain.

Envelope: `{ schemaVersion: 1, ok, command, scope, data, warnings[], errors[] }`, each error
`{ code, message, severity, context, remediation? }`. Exit classes: `0` success, `1` operational
failure, `2` usage or configuration, `3` safety refusal or conflict, `4` daemon unavailable,
`5` protocol or adapter incompatibility. Decide on `errors[].code`, not on the exit number.

## Command map

| Command | Use it to |
| --- | --- |
| `wtm doctor [selector] --json` | Diagnose the workspace, daemon and platform backend. |
| `wtm status [selector] --json` | Read identity, state, endpoints, processes and resources. `--global` aggregates registered workspaces. |
| `wtm explain [selector] --json` | See why WTM resolved a value, and from where. |
| `wtm plan [selector] --json` | See the declarative changes WTM would make, without applying them. |
| `wtm env [selector] --json` | Read the resolved environment delta. |
| `wtm ports [selector] --json` | Read endpoint leases (the ports). |
| `wtm resolve <task> --json` | Read a task's exact argv, working directory and environment without running it. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm run <task>` | Run a task in the foreground. `--enqueue --idempotency-key <key> --json` queues a heavy one. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm start <task>` | Start a long-running task under supervision. `--wait --timeout <duration> --json` waits for its healthcheck. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm stop [task]` | Stop one managed task, or all of this worktree's. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm restart <task>` | Stop and start a managed task; accepts `--wait --timeout`. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm ps --json` | List WTM-managed process groups. |
| `wtm logs [task]` | Read managed task logs; `--follow` streams raw output. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm exec -- <argv>` | Run raw argv in this worktree with its resolved environment. `--worktree <selector>` (`--repo <name>`), before `--`, targets another worktree. |
| `wtm ci watch --json` | Start following HEAD's CI runs in the background; returns at once. `--pr <number>` labels the pull request. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm ci status --json` | Read the latest CI watch result from local state, with failed-job log summaries; never touches the network. `--all` lists every worktree in the workspace. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm ci unwatch --json` | Stop a worktree's pending CI watch. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm task set <name> --task-json <definition> --json` | Override one task for this worktree; wins over `wtm.toml` and any adapter-derived task of the same name. `--worktree <selector>` (`--repo <name>`) targets another worktree. |
| `wtm task list --json` / `wtm task show <name> --json` | Read this worktree's task overrides. |
| `wtm task unset <name> --json` | Remove a worktree's override; `wtm.toml`/an adapter decides the task again. |
| `wtm task export <name>` | Print a worktree's override as a `[tasks.<name>]` block, to paste into `wtm.toml` if it should apply everywhere. |
| `wtm jobs list --json` | List recent queued jobs (`--limit <count>`). |
| `wtm jobs status <job-id> --json` | Read a job's state and cleanup status. |
| `wtm jobs result <job-id> --json` | Read a finished job's result and verify its source evidence. |
| `wtm jobs logs <job-id> --tail <lines> --json` | Read a bounded tail of a job's output. |
| `wtm jobs cancel <job-id> --json` | Cancel a queued job or stop its process tree. |
| `wtm create <branch> --json` | Create a registered worktree for a branch. `--from <ref>`, `--repos <a,b>` (from the workspace root), `--resume`. |
| `wtm analyze [selector] --json` | Report removal safety; `--all`, `--cleanup-candidates`, `--refresh-remotes`. |
| `wtm remove <selector> --json` | Remove a worktree safely; `--refresh-remotes`, `--resume` (only when an error asks for it). |
| `wtm gc --json` | Plan resource garbage collection; `--apply` performs the guarded plan. |
| `wtm disk --json` | Report logical and allocated resource usage. |
| `wtm forget [selector] --json` | Retire a registration whose directory is gone; `--force` if it still exists. |
| `wtm init [path] --yes --json` | Initialize and register a workspace; `--no-detect`, `--max-depth <n>`, `--ai-skill`. |
| `wtm detect [path] --json` | Read what repositories declare; `--write` appends missing tables to `wtm.toml`. |
| `wtm daemon install --json` | Install and start the per-user daemon service. |
| `wtm daemon uninstall --json` | Remove the daemon service. |
| `wtm daemon status --json` | Inspect the daemon service. |
| `wtm daemon serve` | Run the daemon in the foreground (isolated testing only). |
| `wtm adapter list --json` | List trusted external adapters. |
| `wtm adapter trust <adapter-id> <executable>` | Trust an adapter executable by SHA-256. |
| `wtm skill print` | Print this skill. |
| `wtm skill install` | Install this skill into the workspace; `--global` for `~/.agents/skills`. |
| `wtm completion <shell>` | Print a bash, zsh or fish completion script. |

Selectors differ by command:

- `doctor`, `status`, `explain`, `plan`, `env`, `ports`: a registered workspace name or a path;
  without one they use the workspace containing the current directory. A branch is not a selector here.
- `analyze`, `remove`: one worktree, by registered number, branch, absolute path, or path relative
  to the current repository.
- `resolve`, `run`, `start`, `stop`, `restart`, `logs`, `exec`: `--worktree <selector>` takes the
  same forms as `analyze`, and `--repo <name>` names the repository when the branch exists in
  several. Without it they act on the worktree containing the current directory. From a workspace
  root they require `--worktree`.
- `ps`: no worktree selector; it lists the whole workspace.

## Start of a conversation

Run `wtm doctor --json` once. Run `wtm status --json` when you need identity, ports or
processes. Repeat them only after a WTM error, or as the completion check at the end.

Doctor's platform check names the backend and its paths; do not translate another platform's
paths or service commands by hand. The same subcommands work from PowerShell and Git Bash, whose
quoting and path syntax differ. Windows support is experimental; report capability failures as
returned.

If WTM says the directory is not initialized, do not invent configuration. Report it, or, when
initialization is part of the request, run `wtm init --yes --json`.

## Finding a task

Run `wtm resolve <name> --json` with the most likely name. An unknown name fails with
`errors[0].context.knownTasks`, which lists every task of this worktree; pick from it. This covers
`wtm.toml`, `make:<target>` and `workspace:<target>` tasks, so you do not need to read `wtm.toml`,
a `Makefile` or `package.json` to find task names.

## New worktrees

Create worktrees with `wtm create <branch> --json`, not `git worktree add`. The new worktree is
registered and gets its ports; it needs no `wtm init`. Pass `--worktree <branch>` (with `--repo
<name>` for a multi-repository feature) to run commands there; do not `cd`. A failed
multi-repository create is finished with the `--resume` command its error returns.

## Waiting on CI and other slow external checks

When a push, pull request, deploy or review starts a check that takes minutes:

1. After a push or opening a pull request, run `wtm ci watch --json` once (`--worktree <branch>`
   for another worktree, `--pr <number>` when there is one). It returns at once.
2. Make your next tool call the next independent piece of work: the next item in its own
   `wtm create` worktree, a failing test, documentation, a review of your own diff.
3. At each boundary between pieces of work, look once: `wtm ci status --json`. It reads local state
   and replaces `gh pr checks`, `gh run view` and `gh run view --log-failed`.
4. `pending`: keep working. `failure`: read `runs[].jobs[].logSummary`, fix on the same branch,
   push, and `wtm ci watch` again. `unavailable` or `WTM_CI_UNAVAILABLE`: follow `remediation`; when
   `gh` is missing, tell the user. `no_runs`: the commit started no workflow; say so.
5. When the check is the only thing left (for example "merge once green") and no other work
   exists, report the pending check and what you will do when it finishes, then end your turn.
6. For checks WTM does not watch (deploys, reviews, non-GitHub CI), note what you wait on and look
   once per boundary with that tool.

Waiting on a check inside a tool call (`sleep`, `--watch`, `gh run watch`, a polling loop) blocks
the whole session; step 5 is the replacement for it.

## Development and tests

Prefer WTM task execution (`wtm run <task>`) over invoking a project command directly. For raw argv,
use `wtm exec -- <argv>`.

### Heavy builds, tests and typechecks

Queue a task only when it is configured with `queue = true` and a finite `timeout`. Do not assume
an inherited adapter task is queueable. A development server belongs under `wtm start` and is never
queueable.

```bash
wtm run typecheck --enqueue --idempotency-key <unique-request-key> --json
```

1. Choose the request key **before** sending and store `data.jobId` after acceptance. Reuse the key
   only to retry this same submission after an ambiguous response; a new run gets a new key. An
   ambiguous failure returns a WTM-generated key in its error context. Acceptance is not success.
   The job continues after the CLI exits. Deduplication lasts only while the job record is
   retained, so an old key can run again after pruning.
2. Continue independent work (as for CI above). While the job is queued or running, do not edit its
   input files, shared configuration, dependency files, or another worktree's files the task
   reads; coordinate with other agents that write them.
3. Check at intervals of at least 10 seconds, longer for long jobs; never in a tight loop.
   `wtm jobs status <job-id> --json` and `wtm jobs logs <job-id> --tail 100 --json`. A queued job's
   `data.job.waitingReason`:

   | Value | Meaning |
   | --- | --- |
   | `concurrency` | Global slots are occupied, including slots held until process cleanup is verified. |
   | `worktree_busy` | The FIFO head shares a worktree with a job that still holds a slot. |
   | `fifo` | An earlier queued job must be considered first. |
   | `dispatch_pending` | Awaiting dispatch and preflight checks; launch is not guaranteed. |
   | `memory_budget` | The memory estimate does not fit current memory and headroom; do not run the command directly instead. |

   It is `null` outside `QUEUED`; an omitted value (older daemon) is unknown. None of these values
   establish available RAM or a result.
4. Before a dependent step, or before claiming a test or build passed, run
   `wtm jobs result <job-id> --json` and require all of: `ok: true`, `data.terminal: true`,
   `data.successful: true`, `data.job.state: "SUCCEEDED"`, `data.job.exitCode: 0`,
   `data.job.slotHeld: false`, `data.sourceValidity: "UNCHANGED"`. Anything else — pending,
   failed, cancelled, timed out, interrupted, changed or unknown source — is not a pass; keep its
   exit code and diagnostics. Edits after submission need a new job.
5. Cancel an obsolete job with `wtm jobs cancel <job-id> --json`. Cancellation can stay pending
   while process-tree termination is verified; check `slotHeld`. Never kill managed processes to
   free a slot.

Limits: 128 pending or slot-owning jobs, 384 records in total; finished history is pruned toward
256 jobs and seven days. Job streams rotate at 1 MiB with one archive; log queries return at most
32 KiB per stream. Inspect failures while their logs remain.

`UNCHANGED` is scoped evidence: Git tracked and untracked bytes, index, HEAD and file metadata,
bounded to 10,000 files, 64 MiB and 4 seconds per snapshot, refusing symlinks and submodules. It
does not cover ignored dependencies or external inputs, and ignored output created inside a
tracked directory can invalidate it. Do not dismiss a changed result because tracked bytes match.

The queue is shared by every submission of one host, OS user and state store; the state store
has one machine and user owner, and foreign state is refused. Use host-local state when HOME is
shared, and never delete the ownership record to bypass a refusal. Optional `jobs.memory` uses
each task's `memory_estimate_mib` (estimate the whole worker tree) and `queue_env` for
queue-only worker settings; missing or permanently unfit estimates are explicit errors. Neither
concurrency nor memory admission is a hard RAM limit, and commands launched directly bypass the
queue.

### Long-running services

Start with `wtm start <task>`. When a later step needs the HTTP service ready, configure the task's
healthcheck and run `wtm start <task> --wait --timeout 30s --json` (or `wtm restart <task> --wait
--json`); require `ok: true` and `data.readiness.state: "READY"`. A plain start reports
`NOT_CHECKED`, and a live PID is not readiness. Timeout, failed evidence and cancellation leave the
service running. Inspect `wtm logs <task>` and stop explicitly when needed.

When a task misbehaves, read `wtm resolve <task> --json`, `wtm env --json` and `wtm ports --json`
before changing project files.

## Ports and CORS

WTM allocates an endpoint per configured name, per feature, so two worktrees of one feature agree on
every port; that is how a web application reaches the API of its own branch.

- Read a port with `{port.<name>}` in `wtm.toml`.
- Publish it per repository with `[repos.<name>.environment]`, not `[environment]`, when several
  repositories read the same variable name (`PORT` usually is).
- Read the feature's browser origins with `{cors.origins}`.
- `preferred` must fall inside `[ports].range`; widen the range rather than removing the preference.

## Configuration WTM writes for itself

`wtm init` reads each repository (`.env.example`, `package.json`, compose files, `Makefile`) and
writes the port each repository wants, its variable, its CORS allowlist variable and any address
pointing at another repository into `wtm.toml`.

- Run `wtm detect --json` after adding a repository, or after one starts reading a new address or
  port; `wtm detect --write --json` appends the tables `wtm.toml` lacks.
- Read `data.additions` for the exact TOML, and `warnings` for what was left alone and why.
- Neither edits an existing line. If detection is wrong, correct `wtm.toml`: it is the source of truth.
- Values come only from `.env` example files, and only ports or bare `http(s)` addresses. Never put a
  secret where WTM would have to carry it.

## Rules

- Do not choose a port WTM manages, and do not read one out of a running process; use `wtm resolve`
  or `wtm ports`.
- Do not copy `.env` files between worktrees unless WTM's resolved resource plan requires it.
- Do not symlink or share `node_modules`, `.venv`, `.next`, `target`, `build` or similar directories.
- Do not bypass a workspace Makefile or task convention by guessing a relative path.
- Use `wtm run`, `wtm start` and `wtm exec -- ...` when environment or runtime ownership matters.
- Avoid `kill`, `pkill` and `lsof` workarounds; use `wtm ps`, `wtm stop` and `wtm doctor`.
- Use `--json` for reasoning; human text is not a stable contract.
- Do not hard-code ports or environment unless the user asks to bypass WTM.
- To fix one worktree's `cwd`, port template or argv for a task, use `wtm task set`
  (`--task-json` for full fidelity), not a hand edit to `wtm.toml`. Edit `wtm.toml` only when the
  fix should apply to every worktree of the workspace, not just this one.

## Worktree analysis

Before proposing cleanup or deletion, run `wtm analyze --json` and treat every `safety.blockers`
item as authoritative.

Every analysis carries `remoteKnowledge`. `confidence: "LOCAL_ONLY"` means the remote-persistence
verdict came from local refs that may be days old; a branch deleted on the remote still looks
persisted. Before a removal whose safety turns on `remotePersistence`, re-check with
`wtm analyze <selector> --refresh-remotes --json` (network; not on every analysis).

## Removal safety

```bash
wtm remove <selector>
wtm remove <selector> --refresh-remotes   # fetch --prune first, then decide
wtm remove <selector> --resume            # only after WTM asks for it
```

`remove` stops the worktree's managed tasks, deletes the resources WTM materialized in it and
releases its ports before Git deletes anything. Do not stop tasks or delete resource directories by
hand first.

A queued job or occupied job slot in the repository blocks removal, cleanup and registration
retirement. Let it finish, or cancel it with `wtm jobs cancel <job-id> --json` and confirm the
terminal state and `slotHeld: false` before retrying. Removal never cancels jobs silently.

Never replace a blocked WTM removal with `git worktree remove -f`. Handle the refusal:

| `errors[].code` | Exit | What it means, and what to do |
| --- | --- | --- |
| `GIT_DIRTY_*`, `GIT_UNTRACKED`, `GIT_IGNORED_CONTENT`, `GIT_UNMERGED`, `GIT_HEAD_NOT_REMOTE_PERSISTED`, `GIT_WORKTREE_LOCKED`, `GIT_MAIN_WORKTREE` | 3 | Real work would be lost. Report the blocker and its remediation. Ignored content is separate from untracked content; inspect both `workingTree.paths.ignored` and `workingTree.paths.untracked`. |
| `GIT_UNTRACKED_SYMLINKS` | 3 | `safety.untracked_symlinks = "block"` protects these links, including resource-owned ones. Report the paths; do not unlink them or weaken the policy. Under `review` the same code is an advisory warning. |
| `WTM_OPERATION_CONFLICT` with `context.jobId` | 3 | A queued job or held slot protects this repository. Let it finish or cancel it and verify slot release. `--resume` does not bypass this. |
| `WTM_OPERATION_CONFLICT` with `context.holderPid` | 3 | Another process holds a repository operation lease. Inspect `holderPid` and `acquiredAt`; do not retry in a loop. |
| `WTM_OPERATION_CONFLICT` with `context.abandoned: true` | 3 | The previous operation's process died at `context.stage`. The only case for `--resume`; the remediation carries the exact command. |
| `WTM_DAEMON_UNAVAILABLE` | 4 | The daemon owns running processes and cannot be reached. Run `wtm daemon install`; never `kill`/`pkill` them. |
| `RUNTIME_STOP_FAILED` | 1 | Managed process records outlived their stop. The worktree is intact. Check `wtm ps --json` and `wtm doctor --json`. |

A success reports `data.cleanup`: `stoppedProcesses`, `releasedEndpoints`, `collectedResources` and
`retainedResources` with the reason each survived. A `shared` resource surviving one worktree is
correct.

For uncommitted or untracked work or local-only commits, report the blocker and its remediation. Do
not commit, push, reset, clean or discard changes unless the user explicitly asked for that Git
action.

## Completion check

Before claiming the environment is ready, run `wtm status --json` (and `wtm doctor --json` if a WTM
error occurred). If you started a managed task, verify its state through WTM rather than assuming
the child survived.
