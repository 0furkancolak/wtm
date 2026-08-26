# ADR 0001: TypeScript-First Implementation

## Decision

Implement WTM V1 in TypeScript on Node.js 24 LTS. Do not introduce Rust in the initial architecture.

## Context

WTM is an AI/developer CLI with configuration, Git process execution, filesystem events, JSON protocols and orchestration logic. Shared types between CLI, daemon and adapter protocol have high value. Node's macOS directory watcher already uses FSEvents.

## Consequences

- lower contributor barrier;
- one language for CLI/core/daemon/protocol;
- runtime RSS is higher than a tiny Rust daemon but bounded by explicit performance gates;
- a future Rust helper is allowed only behind a narrow interface after profiling proves need.
