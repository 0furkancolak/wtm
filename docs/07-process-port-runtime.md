# Process, Port and Runtime Management

## Prepare is not start

New worktree lifecycle:

```text
DISCOVERED -> ALLOCATED -> PREPARING -> READY
```

`READY` means identity/config/plan is ready. It does not mean dev servers are running.

By default WTM prepares a worktree automatically and never starts runtime tasks automatically. This is built-in behavior, not a configuration key: the root config schema is strict and has no `runtime` table. Preparation eagerness is configured through `[prepare] mode`: `lazy`, the default, prepares before the first task runs in the worktree; `eager` prepares as soon as the daemon learns the worktree exists. Both are idempotent — preparation creates only what is not there — and both announce `worktree.ready` once.

This makes 20 inactive worktrees cheap.

## Endpoint leases

Ports are persisted as leases owned by a worktree/resource.

```text
owner: worktree:<uuid>
service: web
protocol: tcp
port: 23671
```

Allocation flow:

```text
lookup previous stable assignment
 -> WTM registry collision check
 -> OS bind probe
 -> allocate inside transaction
 -> persist lease
```

WTM guarantees no collision among active WTM-managed leases. External processes are detected through the OS probe and cause reallocation.

A lease belongs to a worktree, so a worktree Git no longer reports gives its ports back: reconciliation releases every active lease of a worktree it marks `ORPHANED`. Otherwise a workspace that opens and finishes ten branches ends up holding ten dead leases inside a fixed band, and `wtm ports` lists addresses for directories that are gone. Releasing is reversible — a worktree that reappears reactivates its own lease and keeps its port, unless something else has taken it meanwhile.

One allocation sends at most 256 candidates to one short-lived helper, inside the same
SQLite transaction that checks leases and persists the selected endpoint. The compatible
existing lease is considered first, then the configured preference and ascending range.
Other active leases are excluded before probing. The helper binds/closes candidates
sequentially and returns positional booleans, so host/protocol identity is preserved.
Node and standalone installations both support this path; older injected single-candidate
probes remain supported with a bounded search.

The entire helper has a two-second deadline and is killed if it exceeds it. Requests use
bounded stdin (128 KiB) to avoid Windows command-line limits; responses are bounded to 4 KiB.
A failed, incomplete or malformed response cannot authorize a lease or partially update an
existing one. No helper service or cached availability is added. These are observations:
an unrelated process can still bind after the helper releases a port and before the task
starts. The SQLite transaction only serializes WTM's own leases.

## Stable dynamic strategy

Default:

```toml
[ports]
strategy = "stable-dynamic"
range = "20000-50000"
```

`preferred` is attempted for the main worktree or as a hint, not treated as a universal fixed port.

## Process ownership

Only processes started through WTM are managed.

```text
wtm start dev        # managed background task
wtm run dev          # configured task in the foreground
wtm exec -- command  # raw argv in the foreground
```

A process started manually with raw `make dev` is external. WTM does not scan the entire process table and "adopt" arbitrary processes.

## Process groups

Managed background tasks are started as a new process group/session so child processes can be stopped together.

```text
wtmd
  └── task process group
       └── make
            ├── next
            ├── api
            └── worker
```

Stop behavior:

1. verify process identity;
2. send SIGTERM to the process group;
3. wait configured grace period;
4. send SIGKILL only to the verified group if still alive;
5. update state.

Stored identity includes PID, process-group ID, start time and executable/command fingerprint. PID alone is not sufficient because PIDs are reused.

## Singleton tasks

Default background task policy is one managed instance per task per worktree.

Calling:

```bash
wtm start dev
wtm start dev
```

does not start two copies. The second call reports the existing process. Explicit `wtm restart dev` replaces it.

## Readiness observations

An HTTP healthcheck and `wtm start dev --wait` (also supported by restart) request a bounded
readiness observation after launch. Normal start reports `NOT_CHECKED`. A successful wait
requires a 2xx response plus the same live PID/group/start-time/fingerprint and no authenticated
completion evidence before and after the probe. An anchor PID alone is insufficient.

The observation runs outside the supervisor lock and cannot mark a replacement task ready.
Timeout, IPC cancellation and disconnect release its HTTP request and timers; they leave the
managed service running. IPC cancellation is scoped to the submitting connection and remains
available when its normal request capacity is full. Unrelated requests keep their existing
five-second transport deadline. Readiness has a separate bounded deadline plus launch allowance.
There is no persisted health state or periodic health monitor. See the configuration and CLI
references for durations and result/error states.

## Logs

Managed task stdout/stderr is redirected to WTM log files. `wtm logs` reads from disk; the daemon does not accumulate unlimited output in memory.

## Docker Compose namespace

A worktree-specific environment value is recommended:

```text
COMPOSE_PROJECT_NAME={workspace.name}-{repo.name}-wt{id}
```

This isolates Compose containers and networks.

Host-exposed ports are WTM endpoints:

```yaml
services:
  web:
    ports:
      - "${WEB_PORT}:3000"
```

Internal-only services such as PostgreSQL/Redis should avoid host ports when all consumers live inside the Compose network.

## Database strategies

WTM supports, but core does not implement database-specific administration for:

1. container per worktree;
2. shared database server with worktree-specific database/schema through a task/adapter;
3. external/shared dev database passed through configuration.

## Cleanup

When a known worktree disappears:

```text
READY/RUNNING -> ORPHANED -> CLEANING -> REMOVED
```

Cleanup owns only WTM-classified resources:

```text
processes    stop
ports        release
containers   delete
networks     delete
volumes      retain by default
```

Persistent volumes are never deleted by default.

If Docker or another provider is unavailable, state becomes `DEGRADED_CLEANUP`; the resource ownership record is retained for retry rather than forgotten.
