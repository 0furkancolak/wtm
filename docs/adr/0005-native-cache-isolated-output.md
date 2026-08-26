# ADR 0005: Native Shared Caches, Isolated Mutable Outputs

## Decision

Prefer native package/compiler caches and keep branch-dependent writable build outputs isolated. Do not symlink all worktrees to one `node_modules`, `.venv`, `.next` or `target` directory.

## Consequences

- dependency versions can diverge safely between branches;
- storage reuse comes from tools designed to provide it;
- GC can reason about outputs separately from shared stores;
- APFS clone is available only for explicitly safe clone resources.
