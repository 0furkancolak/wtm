# Process, Port and Runtime Management

## Prepare is not start

New worktree lifecycle:

```text
DISCOVERED -> ALLOCATED -> PREPARING -> READY
```

`READY` means identity/config/plan is ready. It does not mean dev servers are running.

Default:

```toml
[runtime]
auto_prepare = true
auto_start = false
```

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
wtm start dev
wtm dev              # if exposed/background task
wtm exec -- command
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
wtm dev
wtm dev
```

does not start two copies. The second call reports the existing process. Explicit `wtm restart dev` replaces it.

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
