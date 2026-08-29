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

Auto detection is enabled by default.

## Recommended workspace example

```toml
version = 1

[workspace]
name = "devnafru"

[discovery]
repos = true
worktrees = true
max_depth = 5

[prepare]
mode = "lazy"

[ports]
strategy = "stable-dynamic"
range = "20000-50000"

[ports.web]
preferred = 3000

[ports.api]
preferred = 4000

[environment]
WTM_ID = "{id}"
WTM_REPO = "{repo.name}"
WTM_BRANCH = "{branch}"
WEB_PORT = "{port.web}"
API_PORT = "{port.api}"
COMPOSE_PROJECT_NAME = "{workspace.name}-{repo.name}-wt{id}"

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
{env.<NAME>}
```

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

### Stable dynamic

```toml
[ports]
strategy = "stable-dynamic"
range = "20000-50000"
```

Allocation is persisted and reused when the OS port is available.

### Offset

```toml
[ports.web]
strategy = "offset"
preferred = 3000
stride = 10
```

Worktree 7 resolves to 3070 before collision fallback.

### Fixed

```toml
[ports.metrics]
strategy = "fixed"
port = 9090
```

Fixed endpoints are rejected if two concurrently active WTM owners request the same endpoint.

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

V1 events:

```text
workspace.discovered
repo.discovered
worktree.discovered
worktree.created
worktree.ready
worktree.removed
runtime.started
runtime.stopped
```

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
