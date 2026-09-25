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

A feature's leases are the exception. They are recorded on one worktree of the feature and read by
every worktree on the same branch, so when that one worktree leaves Git's listing while a live
worktree of the workspace is still on its branch, reconciliation hands the leases to that sibling
(the one with the lowest path) instead of releasing them. Releasing them took the ports away from
tasks still running on them, and the next allocation found the preferred port busy with those same
tasks and moved the feature. A renamed worktree is the common case: on a case-insensitive disk a
change of case alone is a rename, and the renamed worktree takes its own ports back.

When do leases change:

- A new lease is taken only by a command that is about to run something: `wtm start`, `wtm
  restart`, `wtm run`, `wtm exec`, and the daemon's eager preparation (`[prepare] mode = "eager"`).
  `wtm env` and `wtm explain` also lease, because they answer with the values a task would get.
  An answer that leased nothing would either fail on `{port.x}` or print a number the next
  `wtm start` could change, and `wtm env`'s output is often used to run a server outside WTM.
  `wtm resolve`, `wtm status`, `wtm doctor`, `wtm plan`, `wtm ports` and `wtm tui` never do.
  Before these reports stopped leasing, a worktree that never ran a task held a port for every
  `[ports.*]` endpoint as soon as an agent asked about it.
- `wtm gc --apply` gives back the leases of a feature none of whose worktrees has ever run a
  managed task, unless something is listening on one of its ports. That covers what older
  versions' reports took, and what `wtm env`/`wtm explain` took for a feature that was never
  started. A feature that has run a task keeps its leases.
- The first lease for a feature covers every `[ports.*]` endpoint, not only the ones the task uses.
  This keeps the guarantee that every repository of a feature sees the same `{port.<name>}`, and
  that `{cors.origins}` names every origin of the feature.
- A feature's existing active lease is reused as it is, without a bind probe. The port a running
  task holds is busy by definition, and probing it would move the feature away from its own task.
- New leases are recorded on a live worktree of the feature, never on an `ORPHANED` or
  mid-teardown one that reconciliation would release on its next pass. A shell whose working
  directory still spells a renamed worktree's old path resolves to the worktree Git lists now,
  through the directory's real path.

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

## Local reverse proxy

Todo item 12's "12b" slice: a local reverse proxy that gives each `(service, worktree)` pair a
stable hostname instead of a port number that changes when the lease that backs it is
re-allocated. Off by default — see [`docs/03`](03-configuration-spec.md#local-reverse-proxy) for
the `[proxy]` table that turns it on.

```text
http://web.auth.wtm.localhost:19999
http://api.auth.wtm.localhost:19999
```

### Hostname format

`<service>.<slug>.wtm.localhost`, where:

- `service` is an endpoint lease's own `name` field — the same `web`/`api` names shown in
  "Endpoint leases" above and configured under `[ports.<name>]`.
- `slug` is the owning worktree's `branch`, sanitized to a DNS-safe label: lowercase,
  `[a-z0-9-]` only, every other character collapsed to `-`, repeated `-` collapsed to one,
  leading/trailing `-` trimmed. `fix/auth-bug` and `release/2026.09` become `fix-auth-bug` and
  `release-2026-09`. A worktree with no branch (detached `HEAD`) falls back to its own id.

`.wtm.localhost` needs no `/etc/hosts` entry and no DNS server anywhere. RFC 6761 §6.3 reserves
`.localhost` to resolve to loopback for every conforming resolver, and says so explicitly for any
depth of subdomain under it ("any domain name ending in '.localhost'"), which is what lets
`web.auth.wtm.localhost` resolve without WTM registering anything with the system. `wtm` is one
extra label of WTM's own choosing, so `*.wtm.localhost` cannot collide with a hostname a
repository's own tooling picks under plain `*.localhost`.

### Collision handling

Two worktrees can sanitize to the same slug — `fix/auth-bug` and `fix-auth-bug` both become
`fix-auth-bug`. When that happens, mirroring the "WTM registry collision check" language above:
the worktree WTM has held longest (the lowest `numericId`) keeps the plain slug, and every other
member of the group appends `-<suffix>`, where `<suffix>` is the first 6 hex characters of
`sha256(worktreeId)` — deterministic, so it does not change across a daemon restart, and short
enough to stay readable. This keeps the earliest worktree's hostname stable: a bookmarked URL for
it does not break just because a second, later branch happens to sanitize the same way.

The routing table itself lives in daemon memory, rebuilt from the existing endpoint-lease and
worktree records on every proxied request rather than cached — see `packages/daemon/src/proxy-routes.ts`.
There is no new SQLite table and no migration: this is the same lease/worktree data `wtm ports`
already reads, read again.

### What this does not do

**It does not bind port 80.** Doing that needs root/setcap/authbind on Linux and administrator
rights on Windows, and this unit does not attempt either. The proxy listens on one fixed,
non-privileged port instead (`[proxy] port`, default `19999` — chosen to sit just outside
`[ports]`'s own dynamic band so the two can never collide), which means the URL a person actually
types still carries `:<proxy-port>`. That is the same honest way this document's own idle-
suspension section above states what it cannot observe: this unit delivers a stable, memorable
*hostname* in place of a dynamic port number, not the fully port-free address bar item 12's
headline goal describes. HTTPS/local certificates and port-allocation backward compatibility are
separate, later pieces of that same item and are not part of this one; CORS origin
auto-integration, unlike those two, is already done — see [CORS](03-configuration-spec.md#cors).

**It binds loopback only** — `127.0.0.1`, and `::1` when the host supports IPv6 — never a
wide-open address. A machine-wide proxy that bound every interface would expose every developer's
dev server on the local network, which is not a tradeoff this feature makes.

**Every request's `Host` header is validated before anything is proxied.** A header that does not
end in `.wtm.localhost`, or one that does but names no active route, is refused with a plain 4xx
before any backend is contacted. The proxy is a router for WTM's own hostnames, never an open
relay for an arbitrary `Host` header.

**It does not feed WTM's idle-suspension activity clock.** Traffic arriving through the proxy is
exactly the kind of traffic the "Automatic idle suspension" section below already says WTM cannot
observe — the proxy forwards bytes, it does not touch a task's activity clock, and resume is still
never triggered by traffic. A task reached only through the proxy, with nobody running a WTM
command, is still idle as far as that feature is concerned.

### Dev overlay

Todo item 46's MVP slice: with `[dev-overlay] enabled = true` (see
[`docs/03`](03-configuration-spec.md#dev-overlay)), the proxy injects a small, unobtrusive HTML
fragment into every proxied `text/html` response — a fixed-position, closed-by-default `<details>`
element naming the repository, branch, worktree number and directory, and service, plus links to
every other active endpoint sharing the same feature: the same workspace *and* the same branch
(including sibling repositories'), so a developer looking at three or four running `web`s at once
can tell which tab is which and jump between the endpoints of the one feature that tab belongs to.
Sibling resolution is feature identity, not a port scan or a whole-workspace listing — a worktree
elsewhere in the workspace on an unrelated branch is never shown, and a detached-`HEAD` worktree
(no branch to share) is only ever a sibling of itself. Off by default, like `[proxy]` itself.

The injection point is the proxy's own response handling in `packages/daemon/src/proxy.ts`
(`ProxyServer`'s `htmlInjector` option), not a per-framework adapter (Astro integration, Vite
plugin, Next dev middleware) — decided this way specifically to keep the mechanism
framework-agnostic and single-point, resolving the "enjeksiyon katmanı" decision todo item 46 left
open. Because the fragment is injected by the proxy, `[dev-overlay]` only has anything to act on
wherever `[proxy]` itself is running: `[dev-overlay] enabled = true` with `[proxy]` disabled or
unset is not a configuration error, it is simply inert — there is no proxied response for it to
inject into.

**What stays untouched, on purpose:**

- Any response whose `content-type` is not `text/html` — JSON, assets, anything else — is
  streamed straight through exactly as it always was, byte-for-byte, with no buffering. Only an
  HTML response is buffered whole (to splice text in before `</body>`), and only when the overlay
  is enabled.
- A response whose `content-encoding` names a compression scheme (`gzip`, `br`, ...) is left
  untouched even when the overlay is enabled: splicing text into a compressed body would corrupt
  it, and a dev server overwhelmingly serves HTML uncompressed in practice.
- With `[dev-overlay]` disabled (the default), a proxied HTML response is identical to what
  `ProxyServer` produced before this feature existed — same streaming code path, nothing buffered.
- The overlay's own data is sourced from the same state-store queries the proxy's routing table
  already reads (`listWorktrees`, `listEndpointLeases`, via `buildProxyRoutes`), plus
  `listRepositories` for a display name and the store's existing managed-process query for a
  read-only "currently supervised" task list — there is no new contract parallel to `wtm status
  --json`'s shape, and no new SQLite table. See `packages/daemon/src/dev-overlay.ts`.

**The agent-writes/user-checks checklist (todo item 46b, W11-1):** an agent leaves test/review
steps with `wtm checklist set --item "..." --json` (see [`docs/04`](04-cli-reference.md#dev-overlay-checklist)),
scoped to one worktree and persisted with the same replace-not-merge convention `wtm task set`
uses — the whole list is replaced on every `set`, never merged item-by-item. The overlay renders
each item as a real `<input type="checkbox">`, and the user checking one in the browser writes
`checked` back into `ChecklistStore` through a small JSON API the proxy serves directly, at the
reserved path prefix `/__wtm/checklist` (`ProxyServerOptions.overlayApi` in `proxy.ts`) — never
forwarded to any backend, exactly like the injection path above. This is the only way the toggle
can reach WTM's state DB at all: the browser can only ever reach this loopback proxy, never the
daemon's Unix socket the CLI itself talks to. The double-underscore prefix follows the same
convention other dev tooling uses to reserve paths (Vite's `/@vite/`, Astro's `/_astro/`); a real
backend route that happens to collide with this exact path is a known, out-of-scope limitation of
this MVP. There is no push notification when a box is checked — no SSE, no WebSocket — an agent
that wants to know later polls with `wtm checklist list --json`. The checklist's own persisted
record follows item 49's `task_overrides` pattern (`packages/core/src/state/checklist.ts`), not a
new storage model, per item 46's own note.

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

## Automatic idle suspension

A managed task can opt into being stopped after a period with no WTM interaction, per task, in its
own configuration (`[tasks.<name>.idle]`, see
[`docs/03`](03-configuration-spec.md#automatic-idle-suspension)):

```toml
[tasks.dev.idle]
enabled = true
timeout = "30m"
```

Off unless written. There is no root `[runtime.idle]` table, for the same reason stated at the top
of this document: the root config schema is strict and has no `runtime` table, and automatic
lifecycle decisions are per task rather than per workspace.

How it works, and what it deliberately reuses:

- A periodic sweep in the daemon compares, for each `RUNNING` managed process whose task opted in,
  how long it is since WTM last observed that task against the configured window.
- Suspension goes through the supervisor's ordinary stop path — SIGTERM, grace period, SIGKILL,
  the same process-group and identity verification — and the process ends in the existing
  `STOPPED` state. There is no new lifecycle state, no new terminal condition, and
  `[events."runtime.stopped"]` fires as it does for `wtm stop`.
- **Resume needs no new mechanism.** A singleton task that is not running is started by the next
  `wtm start <task>` or `wtm restart <task>`; that is the resume path, and it is the only one.
  Resume is never triggered by traffic — not directly, and not through the local reverse proxy
  documented above: the proxy forwards bytes to a running task's port and refuses a request for
  anything else, and it never starts a task or touches this activity clock.
- The reason is written as one line into the task's own log stream, so `wtm logs <task>` says the
  task was stopped for inactivity and cites the window it exceeded. Nothing new appears in
  `wtm ps` or `wtm status`: a suspended task is a stopped task.
- The activity clocks live in daemon memory only. There is no new table, no new column and no
  migration. A daemon restart therefore restarts every window from the moment the sweep next sees
  the process — an accepted tradeoff, not a defect: it errs towards leaving a task running.

Two populations are outside this by construction rather than by exception. `wtm run` and
`wtm exec` foreground processes are not supervised at all — they run in the CLI's own process and
have no managed-process record for a sweep to find. Heavy-queue jobs cannot carry an idle window,
because the configuration schema refuses `idle` beside `queue = true` and the policy reader refuses
it again; a queued job ends inside its own finite timeout and is the heavy-job queue's business.

### What WTM can actually observe

**Idleness here means "no WTM interaction", not "no traffic".** The daemon sees a start, a restart,
a readiness wait, a `wtm ps` and a `wtm logs`. It does not see HTTP requests arriving at the
task's own port: the local reverse proxy documented above sits in front of the *hostname*, not the
idle tracker, and forwarding a request through it is not a WTM interaction any more than a browser
hitting the port directly would be. A task that serves a browser or an API client steadily for an
hour — whether reached by its raw port or through the proxy's hostname — while nobody runs a WTM
command, is idle as far as this feature is concerned and will be stopped.

This is the same class of statement as the one the heavy-job queue makes about memory below: the
mechanism is honest about what it measures, and documentation and messages must not imply a
traffic-aware idleness WTM does not have. Opt a task in when an unasked-for stop is acceptable and
`wtm start` is a cheap way back; leave interactive and debug tasks opted out, which is the default.

## Logs

Managed task stdout/stderr is redirected to WTM log files. `wtm logs` reads from disk; the daemon does not accumulate unlimited output in memory.

## Heavy job memory admission

The shared heavy-job queue (`wtm run <task> --enqueue`, config in
[`docs/03`](03-configuration-spec.md#shared-heavy-job-memory-admission), CLI in
[`docs/04`](04-cli-reference.md)) can gate admission on memory as well as concurrency. That
admission reads two numbers only: the task's declared `memory_estimate_mib` and the host's
current `available`/`constrained` memory (`process.availableMemory()` /
`process.constrainedMemory()`, in `packages/daemon/src/job-memory.ts`). It never walks the
process tree of a running or candidate job to sum resident set sizes.

Two reasons, not one:

- **Cost.** Reading a process's own memory counters is cheap; enumerating an entire process
  group and reading each descendant's counters is not, and the enumeration mechanism and its
  cost differ per platform (`/proc` on Linux, `task_info` on macOS, PSAPI/`NtQuerySystemInformation`
  on Windows). An admission check runs on every enqueue; its cost has to stay bounded and
  platform-uniform, which a per-process-tree scan is neither.
- **Accuracy.** Summing RSS across a process tree is not a physical-RAM figure even when it is
  cheap to compute: forked/copy-on-write pages and shared libraries are mapped into more than
  one process, so a naive sum double-counts them. Treating that sum as "how much RAM this job
  is using" overstates it, sometimes by a large margin.

This is why the admission stays estimate-plus-host-headroom, and why a future per-job memory
*reporting* feature (as opposed to admission) would still need to bound how often and how deep
it samples, and would still have to disclose the shared-page caveat above rather than present a
raw RSS sum as exact usage.

Estimate-based admission is explicitly **not an OS-enforced hard memory limit**. WTM does not
create a cgroup, Job Object or `rlimit` for a queued job, and does not kill a running job for
exceeding its declared estimate — the estimate only decides whether a *new* job is admitted.
Documentation and error messages must not claim otherwise, and no platform-specific hard-limit
support is promised until it is actually built and verified there. General process/disk budgets
(todo item 19) read the same host-memory accounting as this queue but stay a separate, narrower
budget on a separate schedule; item 19 does not get a second scheduler; both currently avoid
process-tree measurement for the same cost/accuracy reasons above.

## Resource budgets

Todo item 19. `[budgets]` (config in
[`docs/03`](03-configuration-spec.md#resource-budgets), codes in
[`docs/18`](18-errors-json-contract.md)) is a daemon-wide, host-scoped admission gate on
`start`/`restart`, in the same class as `[jobs]` and `[proxy]` above — a fact about the one
machine the daemon runs on, not about any one workspace. There is no root `[runtime]` table;
each of these three stays its own narrow root key.

Two independent limits, both optional and both off unless configured:

- **`max_processes`** counts every process the daemon is currently managing, host-wide
  (`ManagedProcessSupervisor.list()`, every worktree). A `start`/`restart` that would raise this
  count above the limit is refused with `RUNTIME_PROCESS_BUDGET_EXCEEDED`.
- **`min_available_memory_mib`** is a floor on host *available* memory — not a cap on WTM's own
  usage. WTM does not sum RSS across a process tree (the same cost/accuracy reasons the heavy-job
  queue's own memory admission avoids it, above), so there is no honest way to promise a usage
  cap; a floor on what the host reports as available is the number WTM actually has. It reuses
  the identical host-memory reading the heavy-job queue uses
  (`packages/daemon/src/job-memory.ts`'s `readHostJobMemory`), per the shared-accounting decision
  above — this is not a second scheduler or a second measurement, only a second caller of the
  same one. A `start`/`restart` that would leave available memory under the floor is refused with
  `RUNTIME_MEMORY_BUDGET_EXCEEDED`. When the reading is unavailable (`availableBytes: null`), the
  check fails open rather than refuse a start on a number the daemon does not have.

Both checks run only when a `start`/`restart` would create a **net-new** managed process — a
restart that replaces an already-active instance of the same task does not raise the host's
process count, so it is never refused by either limit; refusing it would block routine restarts
of a task already running well inside budget.

Explicitly out of scope for this unit, for the same "never claim a measurement WTM does not
take" reason as the OS-enforced-hard-limit disclaimer above:

- **Disk budgets.** Unlike a process start, there is no single admission choke point disk usage
  passes through — data is written throughout a task's run, not at one moment WTM could refuse.
  A meaningful disk budget needs its own design (a periodic sweep? a per-write check?) rather
  than reusing the process-start gate, and `packages/cli/src/commands/resource-production.ts`'s
  existing `measure()` function (already real, already used to report per-resource disk usage)
  is the accounting a future unit should read rather than add a second one.
- **Platform-specific OS-enforced hard limits** (cgroups, Job Objects, `rlimit`). No per-platform
  hard-limit support has been built or verified here; claiming one would repeat exactly the
  mistake the heavy-job queue's own disclaimer above warns against.

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

**Implementation status, 2026-09-21:** `processes` and `ports` are WTM-classified resources core
directly owns and cleans up today. `containers`/`networks`/`volumes` describe adapter-declared,
adapter-native resources — the same category [`docs/08`](08-storage-cache-gc.md#gc-scope) scopes
out of V1's GC mode ("Adapter-declared disposable build outputs and adapter-native dependency
cleanup plans are not part of this mode"). No adapter in this repo declares Docker
containers/networks/volumes as resources today, so there is no code path that deletes one, and
`DEGRADED_CLEANUP` has no Docker-provider trigger to reach it from. This table records the
intended shape once an adapter declares such resources, not current behavior; `todo.md` has no
item tracking the adapter-side work yet.
