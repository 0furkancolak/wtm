# Configuration Specification

## Files and precedence

Resolved configuration follows this precedence, from lowest to highest:

1. built-in defaults;
2. adapter suggestions;
3. `~/.config/wtm/config.toml`;
4. registered global-only workspace configuration;
5. workspace `wtm.toml`;
6. nested `wtm.toml` files between workspace root and repository;
7. repository `.wtm.toml`;
8. CLI/runtime override — a worktree's `wtm task set` records (see [Tasks](#tasks)).

**Adapter suggestions never override explicit user configuration.**

## File encoding

Configuration files are UTF-8. A file that begins with a UTF-8 byte order mark is read as though
it did not: the mark is removed before the document is parsed, and the file on disk is left exactly
as its author saved it. Several editors write the mark by default and none of them display it, so
rejecting such a file would mean a syntax error pointing at a line that is visibly correct.

The mark is only removed from the *beginning* of a file. Anywhere else it is a character inside the
document, and TOML rejects it there — removing it would change what the configuration says in order
to make it parse.

Line endings make no difference. LF and CRLF are both accepted, and a value, a table or a
provenance line number is the same under either, so the same `wtm.toml` behaves identically whether
it was last saved on Windows or on a Unix-like system.

The single exception is a line ending **inside** a multi-line basic string (`"""…"""`), where it is
part of the value rather than a separator and travels with the file: a configuration saved with
CRLF gives such a value a `\r\n` where an LF-saved copy gives it a `\n`. WTM does not normalise it,
because rewriting the inside of a quoted value would change what the configuration says. A value
that needs one exact ending should use the `\n` escape in a single-line string, which means the
same thing on every platform.

## Local vs global configuration

### Global user configuration

```text
~/.config/wtm/config.toml
```

Contains machine-level defaults: daemon settings, port ranges, default capabilities and logging policy.

### Local workspace configuration

```text
<workspace>/wtm.toml
```

Contains workspace-level tasks, resource policy and repository overrides.

### Optional repository configuration

```text
<repo>/.wtm.toml
```

Useful when a repository wants to carry its WTM conventions with the source.

### Global-only initialized workspace

`wtm init --global` does not write project files. It stores a workspace configuration under the WTM user data directory and registers the selected root. This is useful for third-party repositories or directories the user does not want to modify.

## Minimal configuration

```toml
version = 1

[workspace]
name = "dev"
```

Auto detection is enabled by default. `wtm init` reads each repository and writes what it
finds into this file — see [Detection](#detection).

## Recommended workspace example

```toml
version = 1

[workspace]
name = "workspace"

[discovery]
repos = true
worktrees = true
max_depth = 5

[prepare]
mode = "lazy"

[ports]
strategy = "stable-dynamic"
range = "3000-4999"

[ports.web]
preferred = 3000

[ports.api]
preferred = 4000

[environment]
WTM_ID = "{id}"
WTM_REPO = "{repo.name}"
WTM_BRANCH = "{branch}"
COMPOSE_PROJECT_NAME = "{workspace.name}-{repo.name}-wt{id}"

[repos.web]
path = "web"

[repos.web.environment]
PORT = "{port.web}"
API_URL = "http://localhost:{port.api}"

[repos.api]
path = "api"

[repos.api.environment]
PORT = "{port.api}"
CORS_ORIGINS = "{cors.origins}"

[resources.env]
path = ".env"
policy = "symlink"
source = "{main.root}/.env"
optional = true

[tasks.dev]
description = "Start development"
expose = true
main = ["make", "dev"]
worktree = ["make", "dev-with-worktree-{id}"]
cwd = "{workspace.root}"
background = true
singleton = true
grace_period = "5s"

[tasks.test]
description = "Run tests"
expose = true
run = ["make", "test"]
cwd = "{workspace.root}"

[events."worktree.created"]
tasks = ["deps.install"]
```

## Templates

Supported template variables in V1:

```text
{workspace.root}
{workspace.name}
{repo.root}
{repo.name}
{main.root}
{worktree.root}
{id}
{key}
{slug}
{branch}
{branch.slug}
{port.<name>}
{cors.origins}
{env.<NAME>}
```

`{branch}` is the branch name — `feat/login`, not `refs/heads/feat/login`.

Templates are resolved by WTM before process spawn. Missing required variables are configuration errors; WTM does not silently substitute an empty string.

## Identity

```toml
[identity]
strategy = "persistent"
reuse_ids = true
```

Each worktree has:

```text
id   = 7
key  = "repo-stable-id:7"
slug = "nafru-feat-auth"
```

`id` is stable while the worktree record exists. A removed worktree ID may be reused only when `reuse_ids = true`; the internal UUID is never reused.

## Port strategies

Endpoints are allocated per **feature**, not per worktree: a branch checked out across
several repositories is one feature, and every worktree of it resolves `{port.<name>}` to the
same port. That is what lets a web application address the API of its own branch. A worktree
with no branch (a detached HEAD) is a feature of one.

A feature is still "one workspace, one branch". `wtm create --repos` records that group with a
persistent id when it creates it, but the grouping rule itself does not change: a worktree on the
same branch that WTM did not create joins the feature exactly as before.

Every named endpoint may publish itself:

```toml
[ports.web]
env = "PORT"      # the variable this port is exported under, in every repository
origin = true     # counts toward the CORS allowlist; default true
```

`env` here names the variable workspace-wide, which is enough for a workspace of one
repository. Where two repositories both read `PORT` and each means its own endpoint, scope it
with [`[repos]`](#repositories) instead.

`preferred` is the port tried first. It must fall inside `[ports].range`; a preference outside
the range is refused with `WTM_CONFIG_INVALID` rather than silently ignored, because a
workspace that asked for 3000 and got 20000 has nothing to read that explains it.

### Stable dynamic

```toml
[ports]
strategy = "stable-dynamic"
range = "20000-50000"
```

Allocation is persisted and reused when the OS port is available.

### Offset

```toml
[ports]
range = "3000-3999"

[ports.web]
strategy = "offset"
preferred = 3000
stride = 10
```

Worktree 7 resolves to 3060 — `preferred + stride * (id - 1)` — before collision fallback. A
worktree whose offset lands past `range.max` falls back to anywhere in the range; a `preferred`
that starts outside it is refused.

### Fixed

```toml
[ports.metrics]
strategy = "fixed"
port = 9090
```

A fixed endpoint is the workspace's decision, so WTM neither leases it nor moves it.

## Repositories

A workspace holds several repositories, and most of what is worth configuring belongs to one
of them.

```toml
[repos.api]
path = "api"                       # relative to the workspace root; defaults to the table name

[repos.api.environment]
PORT = "{port.api}"                # this repository's own endpoint
CORS_ORIGINS = "{cors.origins}"

[repos.web]
path = "web"

[repos.web.environment]
PORT = "{port.web}"                # the same variable, a different endpoint
VITE_API_URL = "http://localhost:{port.api}"
```

An entry matches a repository by `path`, resolved against the workspace root and compared to
the repository's main working tree; without a `path`, the table's own name is matched against
that directory's name. Two entries that name the same repository are refused.

Environment layering, from weakest to strongest:

1. what WTM derived (endpoint ports, the CORS allowlist)
2. `[environment]`
3. `[repos.<name>.environment]`
4. `[tasks.<name>.env]`

## CORS

```toml
[cors]
enabled = true
env = ["CORS_ORIGINS"]
origins = ["https://staging.example"]
```

An API whose port changes per feature needs an allowlist that changes with it. WTM composes
one from every endpoint marked as an origin, and publishes it under the variables the
repository already declares in `.env.example`, `.env.sample`, `.env.template`,
`.env.defaults`, or `.env` — matching `CORS_ORIGIN`, `CORS_ORIGINS`, `CORS_ALLOWED_ORIGINS`,
`ALLOWED_ORIGINS`, and the same spellings behind a project prefix.

Only variable *names* are read from those files; no value is ever parsed out of them. Naming
`env` here replaces detection; `enabled = false` turns it off — `{cors.origins}` still
resolves, so a configuration that names the variables itself should set it.

`wtm init` does exactly that: it writes the variables it found into
`[repos.<name>.environment]` and sets `enabled = false`, so the file says what happens.

When the daemon's global [`[proxy]`](#local-reverse-proxy) is enabled, the allowlist gains a
second origin per endpoint — the proxy hostname alongside the dynamic-port one, for every
endpoint that already counts toward the allowlist (`origin != false`; an endpoint that opted out
of a browser origin gets neither). Both are legitimate ways to reach the same running task, so
both are published: `http://localhost:<port>` and `http://<service>.<slug>.wtm.localhost:<proxy
port>`. See [`docs/07`](07-process-port-runtime.md#local-reverse-proxy) for the hostname format;
this is purely additive and only applies when `[proxy] enabled = true`, so `[cors]` itself needs
no configuration to get it.

## Detection

`wtm init` and `wtm detect` read each repository and write what they find as configuration.

| Read | For |
| --- | --- |
| `.env.example`, `.env.sample`, `.env.template`, `.env.defaults` | Variable names, and values that are a port or a loopback/service URL |
| `.env` | Variable names only |
| `package.json` | `scripts.dev`/`start`/`serve` port flags, workspace layout |
| `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` | Published ports, and URL-valued `environment` entries |
| `Makefile`, `makefile`, `GNUmakefile` | A `PORT = …` assignment |

A value that is not a port (1–65535) or a bare `http(s)` address is dropped at the reader,
query strings included. Nothing else ever leaves those files.

What is written:

- `[ports]` `range`, wide enough to contain every port the repositories asked for
- `[ports.<name>]` `preferred`, per repository
- `[repos.<name>]` `path`, and `[repos.<name>.environment]` with the port variable, the CORS
  variables, and every address that resolved to another repository
- `[cors] enabled = false`, when the allowlist variables were written explicitly

An address resolves to another repository when its host is that repository's compose service
name, or when its port is the port that repository asks for. Failing both, a variable whose
own name contains a repository's name is written with a comment saying it was a guess.

Neither command edits a line already in the file. `wtm init` writes only a file it creates;
`wtm detect --write` appends only tables the file does not already define, and reports the
rest. `wtm init --no-detect` skips it entirely.

## Tasks

Array form is preferred because it avoids shell quoting ambiguity:

```toml
[tasks.test]
run = ["pnpm", "test"]
cwd = "{worktree.root}"
```

Shell form is allowed explicitly:

```toml
[tasks.legacy]
run = "source scripts/env.sh && make dev"
shell = true
```

Task fields:

```text
description       string
expose            boolean
run               string|string[]
main              string|string[]
worktree          string|string[]
shell             boolean
cwd               template path
background         boolean
singleton          boolean
grace_period       duration
timeout            duration
on_failure         fail|warn|continue
requires           capability[]
env                 map<string,string>
healthcheck         optional HTTP readiness configuration
idle                optional automatic suspension of a managed long-running task
queue               boolean, opt in a finite task to the shared queue
memory_estimate_mib  positive integer, estimated peak for the whole task/worker tree
queue_env           environment overrides applied only to enqueued execution
```

`main`/`worktree` are mutually exclusive with `run`.

`shell` is required when a command is written as a single string and rejected when a command is written as an argv array.

`expose` is accepted by the configuration schema but has no CLI dispatch effect in V1: it does not create a top-level `wtm <task>` word. Tasks are always addressed by name through `wtm run`, `wtm start`, `wtm restart` or `wtm resolve`.

### Overriding a task per worktree

`wtm task set <name> [flags]` writes a whole task definition into the state database, scoped to
the worktree it is run in. It wins over the same name in every file layer above and over an
adapter-derived task of the same name — precedence rung 8, [Files and precedence](#files-and-precedence).
The override replaces the task wholesale: a field a prior file layer set but the override leaves
out does not survive, the same way a later file layer's own value replaces an earlier one's rather
than merging into it.

```bash
wtm task set dev --run 'npm run dev -- --port {port.web}' --shell --background
wtm task set dev --task-json '{"run":["node","server.js"],"background":true}'
wtm task list
wtm task show dev
wtm task unset dev
wtm task export dev            # prints the row as a [tasks.dev] block, to paste into wtm.toml
```

`wtm explain` names a task's source as `db` when a `wtm task set` record decided it, ahead of
`wtm.toml` and any adapter. Removing a worktree (`wtm remove`) deletes its overrides, the same way
it deletes the worktree's CI watches: worktree rows are never hard-deleted from the state
database, so a stale override for a gone worktree would otherwise persist forever.

### Adapter task namespaces (make)

The `make` adapter contributes up to three task families for one root target, never by copying or
symlinking the Makefile it read:

```text
make:<target>            worktree's own Makefile,   cwd = worktree root
workspace:<target>       workspace root's Makefile, cwd = workspace root
workspace-here:<target>  workspace root's Makefile, cwd = worktree root
```

`workspace-here:<target>` exists for a root target whose recipe shells into a specific
repository (`cd api && npm run dev`): running it with the workspace root as `cwd` always reaches
the workspace's own checkout of `api`, never the worktree's. It resolves to `make -f
<workspace root>/<Makefile name> <target>` — an explicit `-f` path, so `make`'s own cwd-relative
file lookup never runs and a worktree that also has its own Makefile can't shadow the root one.

Because the recipe still runs with the worktree as `cwd`, any relative path it references
(`$(ROOT_DIR)`, `../.cache/state`) resolves against the wrong root unless the Makefile is written
in terms of two variables WTM injects for exactly this: `WTM_WORKTREE_ROOT` and
`WTM_WORKSPACE_ROOT`. No other variable is injected — a Makefile that needs something more
specific has to derive it from these two itself.

Port leases reach `workspace-here:<target>` the same way they reach every other task (the
automatic `[port.*]`/`PORT`-style environment, layered beneath the task's own `env`): WTM cannot
detect a hardcoded port inside a Makefile recipe, so a target whose command line always passes a
fixed `--port` will keep using it regardless of the lease WTM assigned.

### HTTP readiness

```toml
[tasks.dev.healthcheck]
type = "http"
url = "http://127.0.0.1:{port.web}/health"
timeout = "30s"
interval = "500ms"
```

The URL uses the task's template context. Only HTTP and HTTPS URLs without credentials or
fragments are accepted. `timeout` defaults to 30 seconds and accepts positive `ms`, `s`
or `m` durations up to five minutes; `interval` defaults to 500 ms and accepts 100 ms
through 30 seconds. Duration values must resolve to whole milliseconds. Unknown fields
and probe types are rejected. TCP, process and command probes are not implemented.

Only `wtm start dev --wait` and `wtm restart dev --wait` perform the probe. A 2xx response
is successful; redirects are not followed and response bodies are not buffered. Probes
run within one bounded observation, without a persistent health monitor. The optional
CLI `--timeout` overrides the configuration for that observation. An invalid healthcheck
is rejected before a wait operation launches or stops a process.

### Automatic idle suspension

A long-running managed task can opt into being stopped after a period with no WTM interaction:

```toml
[tasks.dev.idle]
enabled = true
timeout = "30m"
```

`enabled` defaults to `false`: nothing WTM starts is suspended unless its own task says so. There
is no root `[runtime.idle]` table and no workspace-wide switch — the root schema is strict and
deliberately has no `runtime` table (see [`docs/07`](07-process-port-runtime.md#prepare-is-not-start)),
and a global switch would need a heuristic for which tasks are interactive enough to spare. A dev
server somebody watches, or a debug session, simply never writes this block.

`timeout` is required when `enabled = true` and accepts `ms`, `s`, `m` or `h` durations that
resolve to whole milliseconds, from 1 second to 24 hours. The one-second floor is the sweep's own
granularity: idleness is decided by a periodic check, and a window finer than that check cannot be
honoured. A window elapses, and the task is stopped on the next check.

`idle` is rejected on a task with `queue = true`, whatever `enabled` says. A queued task already
ends inside its own finite `timeout` and is not a `wtm start`-managed process at all, so an idle
window on one would be a promise the queue does not keep.

Suspension is an ordinary stop — the same SIGTERM, grace period and SIGKILL `wtm stop` performs,
the same `STOPPED` state, the same `[events."runtime.stopped"]`. There is no new state and no new
command. The reason is written into the task's own log stream, so `wtm logs <task>` says why it
stopped and which window it exceeded, and `wtm start <task>` starts it again exactly as it starts
any singleton task that is not running.

**What "idle" means here is narrow, and the narrowness is the point.** WTM observes only its own
interactions with a task — the start or restart that launched it, a readiness wait, `wtm ps`,
`wtm logs`. Requests arriving at the task's own port are invisible to it, whether they arrive
directly or through the local reverse proxy (below): the proxy forwards bytes to a running task,
it does not report them to the idle tracker. A task serving a browser or an API client for an
hour, with nobody touching WTM meanwhile, reads as idle and will be suspended. Opt a task in only
when a stop it did not ask for is acceptable; see
[`docs/07`](07-process-port-runtime.md#automatic-idle-suspension).

### Shared heavy-job memory admission

In the daemon's global configuration, optionally enable memory admission alongside concurrency:

```toml
[jobs]
max_concurrent_heavy = 2

[jobs.memory]
budget_mib = 8192
reserve_mib = 2048
```

Both quantities use MiB (1,048,576 bytes). `budget_mib` is required and positive; `reserve_mib`
defaults to 1024 and may be zero. Each is capped at 1,048,576 MiB. Omitting `jobs.memory`
keeps concurrency-only behavior. Restart the daemon to apply global policy changes;
workspace/repository files cannot raise this shared limit.

```toml
[tasks.build]
run = ["cargo", "build"]
queue = true
timeout = "10m"
memory_estimate_mib = 2048

[tasks.build.queue_env]
CARGO_BUILD_JOBS = "2"
```

Estimate the whole task tree at the configured worker count. `queue_env` requires `queue=true`,
uses the existing environment/template resolver, and overrides task `env` only on enqueued
execution. Foreground run, start and resolve keep their ordinary environment. WTM does not
guess a universal worker option: configure the build tool's actual worker setting. Changing
that setting or the estimate invalidates a queued command's fingerprint.

Admission requires an explicit positive task estimate when memory policy is enabled.
The estimate must fit both the configured budget and known physical/OS-constrained capacity
after headroom. Missing or permanently unfit estimates are refused before acceptance.
The SQLite claim also accounts for all held estimates and the current available-memory sample
after headroom. Full held estimates are subtracted conservatively even though available memory
already reflects current task use, reserving future worker growth; this can underutilize RAM.

Memory observation failure defers launches. Strict FIFO does not let smaller followers
overtake a memory-blocked head. Jobs rendered impossible by a policy change fail before launch
with the corresponding memory error recorded; cancelled/running/uncertain jobs retain their
reservations until process cleanup is proved. Legacy queued jobs without estimates fail when
memory admission is enabled; legacy held jobs keep blocking admission until cleanup is proved.

The daemon samples Node's available/constrained memory at admission/dispatch and explicit
queries, using the existing queue wakeup while jobs remain. There is no process-tree RSS scan
or extra polling service. Dev servers and other apps reduce the observed available memory
without owning a finite-job slot. This is estimated admission, not an OS-enforced limit;
tasks, other apps and direct commands can grow after a sample. Native platform validation
and real two-AI RAM/swap measurements are still required before claiming measured savings.

## Local reverse proxy

In the daemon's global configuration, optionally turn on the local reverse proxy (todo item
12's "12b" slice):

```toml
[proxy]
enabled = true
port = 19999
```

`enabled` defaults to `false` — this opens a loopback network listener, so, like idle suspension
above, it is explicit opt-in rather than a default behavior. `port` defaults to `19999`, chosen to
sit just outside `[ports]`'s own default dynamic band (`20000-50000`) so the proxy's own port can
never collide with one WTM allocates for a task. Restart the daemon to apply a change here, the
same as `[jobs]` above: this is a daemon setting, read once at startup, not a per-workspace one —
a workspace's own `wtm.toml` may declare `[proxy]` too, but only the value in the global
configuration file is read, for the same reason only the global file's `[jobs]` is.

Once enabled, every active endpoint lease is reachable at
`http://<service>.<slug>.wtm.localhost:<port>`, where `<service>` is the lease's own name
(`web`, `api`, ...) and `<slug>` is derived from the worktree's branch. See
[`docs/07`](07-process-port-runtime.md#local-reverse-proxy) for the exact hostname format, the
collision rule, and — stated plainly, not buried — what binding a fixed, non-privileged port
instead of port 80 means for the URL a person actually types.

## Dev overlay

Todo item 46's MVP slice, next to `[proxy]` above because it is injected by it:

```toml
[proxy]
enabled = true

[dev-overlay]
enabled = true
```

`enabled` defaults to `false`, the same explicit opt-in as `[proxy]` and `[jobs]`. Read from the
same global configuration file, restart-to-apply, for the same daemon-wide reason `[proxy]` is:
this is not a per-workspace setting.

`[dev-overlay]` only has anything to act on wherever `[proxy]` is actually running — the fragment
is injected by the proxy's own response handling, not by a separate listener. `[dev-overlay]
enabled = true` with `[proxy]` disabled or unset is not a configuration error: it is simply inert,
since there is no proxied response left for it to inject into. See
[`docs/07`](07-process-port-runtime.md#dev-overlay) for what the injected fragment shows, exactly
what response types it never touches, and what part of todo item 46 this slice does not
implement.

## Resource budgets

In the daemon's global configuration, optionally cap how many processes WTM will supervise at
once and set a floor on host available memory (todo item 19):

```toml
[budgets]
max_processes = 20
min_available_memory_mib = 512
```

Both fields are optional and independent; leaving either out leaves that limit unenforced. Like
`[jobs]` and `[proxy]` above, `[budgets]` is a daemon-wide setting read once from the global
configuration file — restart the daemon to apply a change, and a workspace's own `wtm.toml`
cannot raise or lower it.

`max_processes` counts every process the daemon is currently managing, across every worktree —
not per-workspace. `min_available_memory_mib` uses MiB (1,048,576 bytes) and is a floor on the
host's reported *available* memory, reusing the same host-memory reading `[jobs.memory]` uses
above; it is not a cap on WTM's own memory usage; see
[`docs/07`](07-process-port-runtime.md#resource-budgets) for why a usage cap is not something
WTM can honestly promise. Both checks run only on a `start`/`restart` that would create a
net-new managed process — replacing an already-running instance of the same task never counts
against either limit — and refuse with `RUNTIME_PROCESS_BUDGET_EXCEEDED` or
`RUNTIME_MEMORY_BUDGET_EXCEEDED` respectively (see
[`docs/18`](18-errors-json-contract.md)). Disk usage and OS-enforced hard limits (cgroups, Job
Objects, `rlimit`) are explicitly out of scope for this table; see `docs/07` for why.

## Events

An event runs the tasks named in its table, in the worktree the event is about, resolved
exactly as `wtm run` would resolve them.

| Event | When it fires | Announced |
| --- | --- | --- |
| `workspace.discovered` | The first time WTM records this workspace | Once per workspace |
| `repo.discovered` | The first time WTM records this repository | Once per repository |
| `worktree.discovered` | A worktree found during a repository's first reconcile | Once per worktree |
| `worktree.created` | A worktree that appeared while WTM was watching | Once per worktree |
| `worktree.ready` | Resources for the worktree have been prepared | Once per worktree |
| `worktree.removed` | A worktree Git no longer reports; runs in the repository's main worktree | Every time |
| `runtime.started` | A supervised task started through the daemon | Every time |
| `runtime.stopped` | A supervised task stopped through the daemon | Every time |

`worktree.discovered` and `worktree.created` are mutually exclusive: a worktree fires exactly
one of them.

Once-only events are recorded in WTM's state, not in memory, so restarting the daemon does not
announce them again — otherwise an event bound to `deps.install` would install dependencies on
every reboot. A workspace registered before this version announces `workspace.discovered` and
`repo.discovered` once, on the daemon's next pass. `wtm forget` clears a workspace's records
along with the workspace, so registering that directory again starts over.

A task started by an event does not itself dispatch events, so `[events."runtime.started"]`
cannot set itself off. A task that fails to start is reported and does not fail the event; an
event that fails does not fail the reconcile that raised it, because one workspace's event must
not take every other workspace's daemon down with it.

An event that could not be dispatched at all — a configuration that does not resolve, a
resource that could not be created — withdraws its announcement and is tried again on the next
pass. An event that *did* run and whose task then failed keeps it: the event happened, and
running the task again by itself would be worse than reporting that it failed.

The tasks an event names must exist in every repository the event can fire for, because
`[events]` belongs to the workspace. Naming a task only one repository defines means the others
report a task that will not start.

Event names contain a dot, so the table key must be quoted. `[events.worktree.created]` is parsed as a nested table and rejected.

Example:

```toml
[events."worktree.created"]
tasks = ["deps.install"]
```

Heavy runtime tasks should not be attached to `worktree.created` by default.

## Resources

Policies:

```text
shared
native-cache
clone
isolated
symlink
copy
ephemeral
external
ignore
```

Example:

```toml
[resources.seed_db]
path = ".data/dev.sqlite"
policy = "clone"
source = "{main.root}/.data/dev.sqlite"
retention = "ephemeral"
```

`path` is relative to the worktree; `source` is a template, and must name something inside the
workspace. WTM creates whatever is declared and missing — which is what a linked worktree's
`.env` is for. When: under `[prepare] mode = "lazy"`, the default, before the first task runs
in that worktree; under `"eager"`, as soon as the daemon learns the worktree exists. Lazy is
what keeps twenty speculative branches cheap; eager is for a workspace whose `.env` must be
there before anybody opens an editor. Either way `worktree.ready` fires once, when it is done.

Nothing is ever replaced. A resource is created only when:

- the path resolves strictly inside its own worktree and names no `.git` component;
- no directory on the way to it is a symbolic link, group-writable, or another user's;
- Git does not track it;
- nothing is there already — a file the worktree has is left exactly as it is;
- its source exists, inside the workspace. A source that is missing is an error, unless the
  resource is `optional = true`, which reports it as `missing` and carries on.

`shared`, `native-cache`, `external`, and `ignore` name something WTM does not own, so it
creates nothing for them and only reports whether it is there.

`wtm status` lists every declared resource and whether this worktree has it, and `wtm doctor`
reports the ones that could not be created, with the reason.

A symbolic link a resource creates does not add a WTM content blocker by default. The
untracked-symlink policy below can explicitly warn or block even for resource-owned links.
Copied or cloned resources are real content; removal's resource cleanup and final Git safety
gate determine whether they can be removed.

## Git safety

```toml
[git]
allowed_remote_refs = [
  "refs/remotes/origin/*",
  "refs/remotes/upstream/*",
]
```

Which remote-tracking refs count as "this work is safely somewhere else". `wtm analyze` and
`wtm remove` refuse to delete a worktree whose HEAD is not reachable from one of them
(`GIT_HEAD_NOT_REMOTE_PERSISTED`), so this list is the definition of the safety net — see
[Git safety and worktree analysis](10-git-safety-worktree-analysis.md#unpushed-definition).

The default is `["refs/remotes/origin/*"]`. Setting the key replaces that default outright rather
than adding to it: a workspace that pushes to `upstream` as well as `origin` has to name both, and
one that deliberately trusts only a single mirror can narrow it to exactly that ref. Because it
resolves through the ordinary precedence above, a repository carrying its own `.wtm.toml` can
tighten or loosen what the workspace decided, and `wtm explain` reports the winning value under
`git.allowed_remote_refs` with the file and line it came from.

Every pattern must:

- start with `refs/remotes/`, since only a remote-tracking ref is evidence of a push;
- use at most one `*`, and only as the final character — `refs/remotes/origin/*` is a pattern,
  `refs/remotes/*/main` is not;
- be one of at least one entry — an empty list is refused rather than read as "trust nothing",
  which would silently make every worktree undeletable.

A pattern that breaks these rules is refused at config load as `WTM_CONFIG_INVALID`, naming the
offending pattern, rather than surfacing later as a crash from inside the analysis.

The segment after `refs/remotes/` also names which remotes `--refresh-remotes` fetches from, so
narrowing this list narrows what a refresh talks to.

### Untracked symbolic links

```toml
[safety]
untracked_symlinks = "ignore"
```

| Value | WTM analysis and removal policy |
| --- | --- |
| `ignore` (default) | A Git-untracked symlink adds no WTM warning or blocker. |
| `review` | Adds `GIT_UNTRACKED_SYMLINKS` as a warning and yields `REVIEW` when no blocker exists. |
| `block` | Adds `GIT_UNTRACKED_SYMLINKS` as a blocker; removal exits 3 before runtime cleanup. |

The setting uses the same built-in/global/workspace/nested/repository configuration layers
as remote-ref safety, including `.wtm.toml` overrides and `wtm explain` provenance. Missing
values preserve the parent layer; invalid values are `WTM_CONFIG_INVALID`. The policy
applies only to Git's untracked entries. Ignored content and ignored-symlink behavior are
unchanged; tracked edits remain blockers. File contents and link targets are not read or
modified to evaluate a symlink. Inspection errors other than disappearance fail closed.

Warnings do not introduce a confirmation prompt or override another blocker. Explicit
`block` is not deferred to resource cleanup, even for a WTM-owned link. The final safety
analysis repeats the policy, catching links created during cleanup and links replaced by
ordinary untracked files. `ignore`/`review` do not force deletion: Git's final unforced
worktree removal can still refuse an arbitrary untracked symlink. WTM does not unlink such
links or add `--force` to bypass that refusal.

## Capability provider override

```toml
[capabilities]
"javascript.package-manager" = "bun"
"python.environment-manager" = "uv"
```

This resolves ambiguous ecosystems without hard-coding framework-to-package-manager relationships.

## Config provenance

Every resolved value should retain its source. `wtm explain` can therefore show:

```text
task.dev.worktree
  make dev-with-worktree-{id}
  source: /Users/me/dev/wtm.toml:37
```

This provenance should also exist in JSON diagnostics.
