# ADR 0006: Bun Development Tooling with Node-Compatible Runtime Code

## Decision

Use Bun 1.3+ for workspace management, dependency installation, project scripts and tests. Keep shipped runtime packages compatible with Node.js 24 LTS and avoid Bun-only runtime APIs in the CLI, core, daemon and public protocol packages.

## Context

WTM needs a fast TypeScript development loop and a single workspace tool. Bun provides workspaces, a lockfile, script execution and a built-in test runner. Node.js remains the V1 runtime baseline because launchd installations and npm/Homebrew distribution must not require Bun on end-user machines.

## Consequences

- contributors use `bun install`, `bun run ...` and `bun test`;
- tests import from `bun:test` and do not require Vitest;
- production packages use Node.js 24 APIs and are typechecked against the supported runtime contract;
- pnpm, npm and Bun remain separate ecosystems detected by WTM adapters;
- Bun-only production APIs require a future compatibility decision rather than entering accidentally.
