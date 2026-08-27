# Adapter Protocol

## Goal

A new language, framework or build system must be supportable without rebuilding the WTM daemon.

## Adapter kinds

Adapters can describe capabilities such as:

```text
package-manager
framework
build-system
runtime
task-runner
toolchain
cache
custom
```

Core behavior is capability-based rather than kind-based.

## Built-in and external adapters

Both implement the same logical interface:

```text
metadata
detect
plan
doctor
cleanup-plan
```

Built-in adapters are TypeScript modules. External adapters are executables named:

```text
wtm-adapter-<name>
```

## External transport

One process per request:

```text
WTM spawn adapter
  -> JSON request on stdin
  <- JSON response on stdout
  <- diagnostics on stderr
adapter exits
```

No long-running plugin process, HTTP server or gRPC runtime is required.

## Protocol version

```json
{
  "protocol": { "major": 1, "minor": 0 },
  "operation": "metadata"
}
```

Rules:

- major mismatch: incompatible;
- adapter older minor: allowed when required fields are supported;
- adapter newer minor: unknown optional fields ignored only where the schema marks forward compatibility safe.

## Metadata

Example response:

```json
{
  "protocol": { "major": 1, "minor": 0 },
  "adapter": {
    "id": "cargo",
    "name": "Cargo",
    "version": "1.0.0",
    "kind": "package-manager",
    "provides": [
      "rust.package-manager",
      "rust.build-system",
      "deps.install"
    ]
  }
}
```

## Detection

WTM supplies context so the adapter does not need to rediscover workspace topology.

Request:

```json
{
  "operation": "detect",
  "workspace": { "root": "/Users/me/dev" },
  "repository": {
    "root": "/Users/me/dev/app",
    "mainRoot": "/Users/me/dev/app"
  },
  "worktree": {
    "root": "/Users/me/dev/.worktrees/app-auth",
    "id": 7,
    "branch": "feat/auth"
  }
}
```

Response:

```json
{
  "detected": true,
  "confidence": 1,
  "evidence": [
    { "kind": "file", "value": "Cargo.toml" }
  ]
}
```

Detection is side-effect free.

## Planning

Adapters return resources, capabilities, task contributions and safe declarative actions.

Example:

```json
{
  "resources": [
    {
      "name": "cargo-target",
      "type": "build-output",
      "path": "target",
      "policy": "isolated",
      "retention": "ephemeral"
    }
  ],
  "actions": [
    {
      "type": "exec",
      "argv": ["cargo", "fetch"],
      "cwd": "{worktree.root}",
      "timeoutMs": 600000
    }
  ],
  "tasks": {},
  "capabilities": {
    "deps.install": {
      "action": "cargo.fetch"
    }
  }
}
```

Task contributions are keyed task definitions. Commands use argv arrays by default; shell strings require an explicit `shell: true`. Adapters may also declare task `cwd`, `background` and `singleton` behavior. Tasks are registered by core and are not executed merely because a plan is applied.

For V1.0 compatibility, a plan that omits `tasks` is accepted and normalized to an empty task map.

The adapter does not mutate the repository during `plan`.

## Action vocabulary

V1 declarative actions:

```text
ensure-directory
symlink
copy
clone
write-generated-file
reserve-endpoint
exec
register-runtime-namespace
```

Deletion actions are only legal inside `cleanup-plan` and must target a resource already owned/approved by WTM.

## Plan merge

A polyglot repository can activate several adapters:

```text
Bun + Next + Cargo + uv + Go + Docker + Make
```

WTM merges the plans, detects conflicts and applies explicit config precedence.

If two adapters give incompatible policy to the same resource, WTM emits a plan conflict rather than silently choosing.

## Capabilities

Framework adapters depend on semantic capabilities rather than adapter names.

Example:

```text
Next -> requires javascript.package-manager
```

Providers can include:

```text
bun
pnpm
npm
yarn
```

User override:

```toml
[capabilities]
"javascript.package-manager" = "bun"
```

## Trust model

Built-in adapters are trusted as part of WTM releases.

External adapters installed into user-controlled WTM directories can be trusted at installation time.

Repository-local executable adapters are **not executed automatically**. Trust records store adapter ID, canonical path and SHA-256. A changed binary requires renewed trust.

## Timeouts

Default adapter RPC budgets:

```text
metadata      1000 ms
detect        2000 ms
plan          5000 ms
doctor        5000 ms
cleanup-plan  5000 ms
```

Long-running package commands are returned as core-managed `exec` actions and therefore do not keep the adapter process alive.

## Built-in V1 adapter set

Detection/basic policies should cover:

- Make;
- Bun;
- pnpm;
- npm;
- Next.js;
- uv;
- pip/venv fallback detection;
- Cargo;
- Go;
- Docker Compose.

Gradle, Maven and .NET can follow with the same protocol without modifying the architecture.
