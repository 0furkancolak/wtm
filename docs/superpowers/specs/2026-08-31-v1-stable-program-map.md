# WTM v0.2.0 — Program Map

> **Release target changed, 2026-08-31 (user ruling).** This map was written as the road to
> `v1.0.0`; the tag that ships when these increments are done is **`v0.2.0`**, not `v1.0.0`.
> Nothing about the *scope*, ordering, or the increment boundaries changes — only the version the
> finished work is released under. Read every "v1" and "stable" below as naming this body of work,
> not a semver promise: `0.2.0` is still `0.x`, so the public API and the on-disk state contract
> stay explicitly unstable and a breaking change does not need a major bump. The filename keeps its
> original slug so existing links and the ledger's `Program map:` reference do not rot.

## Status

Draft — 2026-08-31. Derived from `todo.md`. Increment specs are written and approved one at a time;
this file only fixes the decomposition, ordering, and the boundaries between increments.

## Purpose

`todo.md` lists 42 numbered items plus testing and release checklists. They are not equal in kind:
some are destructive-safety correctness work, some are portability, some are packaging and prose.
This map groups them into increments that can each be specified, planned, implemented, and released
independently, in an order where every increment leaves the product shippable.

## Ordering principle

The order in `todo.md` ("Önerilen geliştirme sırası") is preserved, with one refinement: the two
`v0.1.0-rc.1` field findings that are pure packaging/prose work (36, 37) are pulled forward, because
they are cheap, they block the next tag, and they touch no subsystem that later increments rewrite.

## Increments

### Increment A — Destructive-operation safety core

Covers `todo.md` items 1, 2, 3 and the "Removal" and "Remote safety" testing checklists.

- 2. Cross-process repository operation leases (`repository_operation_leases`, `WTM_OPERATION_CONFLICT`).
- 1. Runtime-aware `wtm remove` lifecycle built on top of those leases.
- 3. Remote freshness / explicit `--refresh-remotes`.

These three are one increment because item 1's acceptance criteria ("iki farklı terminalden aynı
anda tetiklense race condition oluşmuyor") cannot be met without item 2, and item 3 changes the same
analysis payload that item 1 re-runs before and after cleanup.

Exit: `wtm remove` never orphans a managed process, never deletes a worktree after a failed cleanup,
blocks on identity change, is safe under concurrent CLI/daemon invocation, is recoverable after a
daemon crash, and reports remote-knowledge provenance in JSON.

### Increment B — Next-tag packaging and first-run correctness

Covers items 36, 37, 39, 40, 41 and parts of the "Distribution / install" checklist.

- 36. Gatekeeper/quarantine guidance until notarization lands.
- 37. README quick start that works on a clean workspace; `Unknown task` lists known tasks.
- 39. Socket path length diagnostic; no build-time paths in user-facing errors.
- 40. Per-`HOME` launchd label; self-consistent `daemon status`.
- 41. Unregistered-worktree diagnosis and automatic reconciliation when the daemon returns.

Exit: a user who downloads the archive from a browser, follows the README top to bottom in a clean
workspace, under a long `HOME`, with a second `HOME` on the same machine, hits no wall.

### Increment C — Platform abstraction and Linux backend

Covers item 9 (macOS + Linux halves) and the Linux rows of the platform checklist.

Exit: core packages contain no OS-specific import; Linux x64 CI green; macOS regression-free.

> **Split into C1 and C2, 2026-09-01.** The exit above mixes two claims that are provable in
> different places. "Core packages contain no OS-specific import" and "macOS regression-free" are
> decided entirely on the development machine. "Linux x64 CI green" cannot be: there is no Linux
> kernel here, so the only instrument that can answer it is a CI run. Landing both together would
> mean a commit whose macOS half is proven and whose Linux half is a claim awaiting a push — and
> the two halves would be indistinguishable to anyone reading the history. They are therefore two
> increments, and the boundary is *what can be verified where*, not what is convenient to write.
>
> **C1 — the platform seam.** `PlatformRuntime` and its ports extracted; macOS moved behind them
> with no behaviour change; the Linux backend written to completion everywhere it is decidable
> without a Linux kernel (path policy, socket policy, unit-file rendering, `/proc` parsing, the
> `systemctl --user` command set) and driven by fixtures and injected runners, exactly as the
> launchd backend is already driven today. **C1 makes no claim that WTM runs on Linux.** Its exit
> is: core holds no macOS-specific import, the full suite is green on macOS with no behaviour
> change, and a structural test fails if OS-specific knowledge re-enters core.
>
> **C2 — Linux in CI.** An `ubuntu` job in the CI matrix, the integration behaviour only a real
> kernel decides (inotify, real `/proc`, a real `systemctl --user`, a real 108-byte socket), the
> Linux binary targets, and whatever the first red run finds. Exit: Linux x64 CI green.
>
> The ordering matters for a second reason. Extracting a seam with only one implementation behind
> it is the ordinary way to build the wrong seam, so C1 does not stop at the interface: it lands
> the second implementation's *decidable* half at the same time, which is what forces the seam to
> be shaped by two platforms rather than by one platform's habits.

### Increment D — Windows backend

Covers item 9's Windows half, including the daemon-lifecycle decision (Scheduled Task vs per-user
background process vs service wrapper), named pipes, and Job Objects.

Exit: Windows x64 CI green; JSON contract and command names identical across platforms.

### Increment E — Multi-platform release pipeline

Covers items 29, 28, 30, 31, and item 4 (performance release gate parity).

Exit: one matrix produces all five artifacts with checksums and provenance; the release gate's
effect on publication is deterministic and documented identically in workflow and docs.

### Increment F — Public presentation

Covers items 22, 23, 24, 25, 26, 27, 32, 33 and the docs/code parity tests 34, 35.

Exit: README, About, topics, docs, examples, and the Agent Skill describe the real, tested platform
matrix; a parity test fails when a documented command does not exist.

### Increment G — macOS notarization

Covers item 5 and closes item 36's temporary workaround.

Exit: stable macOS artifacts pass Gatekeeper on a clean machine; publication is blocked without
successful notarization.

### Increment H — v1 experience completion

Covers items 6 (`wtm create`), 7 (cleanup candidate ranking), 8 (allowed remote refs config),
10 (readiness/healthcheck), 11 (shell completion), 42 (idle RSS budget decision).

### Increment I — Differentiators (post-v1)

Covers items 12–15 and 16–21. Not required for `v1.0.0`.

## Cross-cutting rules for every increment

1. Spec first: a design document in `docs/superpowers/specs/`, then a task plan in
   `docs/superpowers/plans/`, then implementation. No code before its plan step exists.
2. Test-first inside each task: a failing test that names the real behaviour, then the implementation.
3. Every new user-visible failure carries a stable `WTM_`/`GIT_` code registered in the protocol
   error catalogue and documented in `docs/18-errors-json-contract.md`.
4. JSON output is a compatibility contract: additive changes only, guarded by contract tests.
5. `bun run lint`, `bun run typecheck`, and the affected test suites pass before a task is complete.
