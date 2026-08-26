# ADR 0003: Do Not Own Git Hooks for Primary Worktree Discovery

## Decision

WTM does not install/replace `core.hooksPath` as its primary discovery mechanism.

## Context

Git `post-checkout` runs after worktree add, but users may already use Husky, Lefthook or custom hooks. WTM must also detect worktrees created while its hook is absent/disabled.

## Consequences

- fewer conflicts with repository tooling;
- raw Git/GUI/agent worktrees are detected uniformly;
- hook integration may exist later as an optional acceleration, never the source of truth.
