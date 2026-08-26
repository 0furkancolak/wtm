# ADR 0002: Event-Driven Reconciliation Instead of Polling

## Decision

Use macOS event-driven watching as a scheduling hint and reconcile against Git/config state. Do not poll source trees.

## Context

Filesystem notifications can be coalesced and callback filenames are not guaranteed. Git already exposes stable porcelain worktree topology.

## Consequences

- idle CPU stays low;
- correctness does not depend on one exact filesystem event;
- startup/explicit reconciliation repairs missed events;
- watcher implementation can later be replaced without changing Git/core logic.
