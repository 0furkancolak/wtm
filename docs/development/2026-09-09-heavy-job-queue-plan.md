# Shared heavy-job queue implementation plan

Goal: complete TODO 45's fixed-concurrency slice without replacing foreground run or the existing process supervisor.
Spec: `todo.md`, item 45, and the explicit continuation request on 2026-09-09.
Architecture: the existing per-user daemon dispatches a persistent SQLite FIFO. Atomic database guards cover slots, idempotency, same-worktree exclusion and destructive repository leases. The supervisor remains the authority for process identity and group termination.

## Boundaries and decisions

- Continue the clean `codex/todo-safety-docs-parity` checkout at `7962428`; `816fb11` is present. The follow-up request authorizes committing and pushing this development branch. PR, merge and release remain outside this task.
- Engine agent owns state, migration 012 and daemon. CLI agent owns Commander integration, CLI tests and usage docs/skill. Root owns shared protocol/config, source evidence, coordination, verification and commits. At most two subagents run; heavy checks are root-only and sequential.
- Tasks explicitly opt in with `queue = true`, cannot have `background = true`, and require a finite positive timeout of at most 24 hours. This makes accidental dev-server slot exhaustion bounded.
- Only daemon global config sets `[jobs].max_concurrent_heavy` (default 1, range 1–64); repository config cannot enlarge the shared limit. Queue scope is local host identity and OS user within one state database; separate state directories are independent, not an OS-enforced quota.
- IPC commands: `jobs.enqueue/list/status/logs/result/cancel`; retain JSON envelope schemaVersion 1. Enqueue arguments include a client-generated or supplied idempotency key. Durable acceptance is distinct from successful completion. Retrying a key with different intent conflicts.
- Public job states: QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED, TIMED_OUT, INTERRUPTED. Slot ownership survives unknown process identity and incomplete cleanup, independently of status. Never replay an uncertain side-effecting command after restart.
- Preserve numeric exit result and signal. Bind the managed process before GO. Cancellation/timeout require whole-group disappearance before freeing the slot. Repository remove/GC and dispatch must exclude one another transactionally.
- Persist fingerprints rather than resolved argv/environment secrets. Resolve the task again before launch; reject changed task configuration. Bound queue rows, retained terminal history and log sizes.
- Source evidence includes Git index/HEAD and tracked/untracked working contents with file metadata, not just HEAD. Scan is bounded and fails closed. Ignored dependencies, external inputs and filesystem race limits are explicitly outside the evidence scope; no claim of an immutable build sandbox. Recheck before start, after exit and when consuming results.

## Execution

- [x] Record baseline tests and inspect fresh native process identity failures.
- [x] Root: failing shared schema/config/source-evidence tests, then implement those contracts.
- [x] Engine: failing real SQLite FIFO/idempotency/slot/removal tests and scheduler lifecycle tests; implement state + daemon on existing supervisor.
- [x] CLI: failing enqueue/query/result/JSON/docs-parity tests; implement thin CLI and agent workflow.
- [x] Review each other's implementation independently; root coordinates fixes and integration.
- [x] Run targeted tests, then lint, typecheck, full tests, e2e, perf and package verification sequentially; diagnose failures without weakening safety. Full/native gates remain unsuccessful as recorded in the analysis; running them is not a passing release gate.
- [x] Update analysis/TODO only for demonstrated criteria, document measurement recipe and missing platform evidence, commit small local slices using configured Git identity.

## Measurement boundary

The user's Claude/Codex machine is inaccessible. Here `ps` currently fails with `fatal library error, lookup self`; `/proc/meminfo` is container/host context and is not evidence about user sessions. Verify PID/proc visibility directly and keep local fixtures separate from a native before/after two-session memory experiment.
