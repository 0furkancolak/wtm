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

If WTM says the current directory is not initialized, do not invent WTM configuration. Report it or, when initialization is part of the user's request, run:

```bash
wtm init --yes --json
```

## Development and tests

Prefer WTM task execution over invoking a project command directly:

```bash
wtm run <task>
```

For a long-running task WTM should supervise, and for raw argv that is not a configured task:

```bash
wtm start <task>
wtm exec -- <argv>
```

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

## Removal safety

Use:

```bash
wtm remove <selector>
```

Never replace a blocked WTM removal with:

```bash
git worktree remove -f ...
```

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
