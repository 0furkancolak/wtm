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
wtm explain --json
```

## Rules

- Do not manually choose a port managed by WTM.
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
