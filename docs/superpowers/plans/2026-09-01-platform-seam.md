# Increment C1 — Task plan

Spec: `docs/superpowers/specs/2026-09-01-platform-seam-design.md`.

Waves are set by **file ownership**, not by topic. Two tasks never own one file. Increment A's
cross-task defects all came from file overlap, and Increment B's only collision was the lead editing
a file assigned to an agent, so the rule is stated per task and not left implicit.

Every task: a failing test that names the real behaviour first, then the implementation. `bun run
lint` and `bun run typecheck` clean before the task is done. A task that finds the spec wrong
**reports it and stops** rather than deviating quietly — the spec was wrong twice in Increment B and
both times the agent catching it was worth more than the agent working around it.

## Lead step 0 — the package skeleton

Lead-owned. `packages/platform/package.json`, `packages/platform/tsconfig.json`,
`packages/platform/src/ports.ts` (type-only: `PlatformRuntime`, `PlatformPaths`,
`SocketAddressPolicy`, `ProcessPlatform`, `ServiceBackend` and their satellites), root
`package.json` `typecheck`/`build` wiring, `WTM_PLATFORM_UNSUPPORTED` added to
`packages/protocol/src/errors.ts`.

No implementations. Wave 1 fills the subdirectories.

## Wave 1 — the three independent ports

Each task owns one subdirectory of `packages/platform/src/` and **must not edit
`packages/platform/src/index.ts`**; the lead wires the barrel after Wave 2.

### C1-1 — Path policy

Owns `packages/platform/src/paths/**`.

Implement `PlatformPaths` for both platforms per spec D3. `home` and `env` are arguments, never
read from the process, so the Linux resolver is constructed and tested on this macOS host.

Test: each XDG variable absolute / relative / unset; macOS ignoring all four; `socketRoot` falling
back to `dataRoot` when `XDG_RUNTIME_DIR` is absent.

### C1-2 — Socket policy, and core loses `paths/daemon-socket.ts`

Owns `packages/platform/src/socket/**`, `packages/core/src/paths/daemon-socket.ts` (deleted),
`packages/core/src/paths/__tests__/daemon-socket.test.ts` (moved), `packages/core/src/index.ts`,
and the import sites in `packages/cli/src/{main.ts,state-diagnostics.ts,commands/daemon.ts}`,
`packages/daemon/src/{runtime-factory.ts,server.ts,launchd.ts}`,
`packages/cli/src/__tests__/socket-path.test.ts`,
`packages/daemon/src/__tests__/socket-path-limit.test.ts`.

Move the measurement machinery and `DaemonSocketPathTooLongError` with **no behaviour change**;
`daemonDataDirectorySegments` is deleted, not moved. Limit becomes per-platform: 104 / 108.

Constraint: the import-site edits are mechanical. `runtime-factory.ts` and `main.ts` keep computing
paths exactly as they do today — Wave 3 moves them onto `PlatformPaths`, and doing it here would
mean two tasks rewriting the same lines for different reasons.

### C1-3 — Process inspection

Owns `packages/platform/src/process/**` and the `inspectProcess` / `inspectProcessIdentity` /
`inspectProcessGroup` bodies in `packages/daemon/src/process-supervisor.ts` with their tests.

macOS: the existing `ps` code, moved verbatim — same argv, same regexes, same
`stableEnvironment()`. Linux: `/proc`, per spec D5, including the last-`)` parse, zombies,
`<btime>:<starttime>`, and a failure that is a failure rather than an absence.

Does **not** touch `process-anchor.ts` (spec D5 states why), and does **not** delete
`packages/core/src/runtime/process-identity.ts`. Core's copy dies in C1-5, which owns the lease
logic that consumes it and owns core's barrel — the alternative was two Wave 1 tasks editing
`packages/core/src/index.ts` concurrently, which is the exact overlap these waves exist to prevent.
Until then core keeps a module the platform package has superseded; C1-5 removes it.

## Wave 2

### C1-4 — Service backend descriptor

Owns `packages/daemon/src/launchd.ts` and whatever it becomes, `packages/daemon/src/index.ts`,
`packages/daemon/package.json` exports, `packages/platform/src/service/**`, and every launchd test
file.

Generalise the transactional publisher over `ServiceBackend` (spec D6). macOS descriptor = today's
behaviour, byte-identical. Linux descriptor = systemd user unit + `systemctl --user`, driven by the
injected runner.

**The pre-existing launchd tests keep their assertions.** Imports and symbol names may change;
anything else is a hidden regression and gets reported instead.

This task has the wave to itself: it is 2580 lines of lock, journal and recovery logic, and it is
the increment's largest risk.

### C1-5 — Core de-platformed, and a test that keeps it that way

Owns `packages/core/src/analysis/operation-lease.ts` and its tests,
`packages/core/src/runtime/process-identity.ts` (deleted, handed over by C1-3) and its test,
`packages/core/src/index.ts`, `packages/core/src/__tests__/platform-independence.test.ts` (new),
and the lease call sites in the CLI and daemon that must now pass a reader.

Remove `installProcessStartIdentityReader`; `operation-lease` takes the port. Write the D8
structural test, including the reviewed `external-adapter.ts` exception list with a reason per
entry.

Verify the guard by **performing the failure**: reintroduce a macOS literal into core, confirm the
test fails and names the file, then remove it and confirm green. Report the observed failure
message.

## Lead step 1 — wire the barrel

`packages/platform/src/index.ts` and `selectPlatformRuntime`.

## Wave 3

### C1-6 — Daemon on the platform runtime

Owns `packages/daemon/src/main.ts`, `packages/daemon/src/runtime-factory.ts` and their tests.

`defaultProductionRuntimePaths` derives from `PlatformPaths` — note `socketPath` no longer comes
from `dataRoot`. `assertSupportedRuntime` accepts `linux` and refuses `win32` per spec D9.

### C1-7 — CLI on the platform runtime, and the `platform` doctor check

Owns `packages/cli/src/{main.ts,diagnostics.ts,state-diagnostics.ts,commands/daemon.ts}`, their
tests, and `docs/04-cli-reference.md`.

Add the `platform` entry to `doctorChecks` and its finding (spec D10). Replace `launchd is only
available on macOS.` with a platform-aware message. Own the docs table in the same task — it went
stale in Increment B precisely because the task that added checks did not own the file.

## Wave 4

### C1-8 — Documentation

Owns `README.md`, `CHANGELOG.md`, `docs/05-daemon-and-macos-runtime.md`,
`docs/18-errors-json-contract.md`, `todo.md`.

Document the seam, the Linux path/service policy as *designed but unverified on a kernel*, and
`WTM_PLATFORM_UNSUPPORTED`. Tick only what is true. Add `todo.md` item 44 (shared-`HOME` lease
hazard, spec D5).

`package.json`'s `os` field and the macOS wording in the description and keywords **do not change**
(spec D11).
