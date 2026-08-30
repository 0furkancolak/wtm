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
8. CLI/runtime override.

**Adapter suggestions never override explicit user configuration.**

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
```

`main`/`worktree` are mutually exclusive with `run`.

`shell` is required when a command is written as a single string and rejected when a command is written as an argv array.

`expose` is accepted by the configuration schema but has no CLI dispatch effect in V1: it does not create a top-level `wtm <task>` word. Tasks are always addressed by name through `wtm run`, `wtm start`, `wtm restart` or `wtm resolve`.

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

A symbolic link a resource creates does not block `wtm remove`: the link holds no content of
its own, and whatever it points at lives outside the worktree and survives. A copied or cloned
resource is real content in the worktree, and does block, like any other untracked file.

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
