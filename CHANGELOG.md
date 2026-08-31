# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

Targeted at **`v0.2.0`**. This project is still `0.x`: the public API and the on-disk state contract
are unstable, and a breaking change may land in a minor release without a deprecation window.

### Added

- `wtm remove` is runtime-aware. It now stops the worktree's WTM-managed processes, verifies from
  the state database that they are gone, deletes the resources WTM materialized inside the worktree,
  releases its endpoint leases, and only then re-analyzes and lets Git delete it. The success
  envelope carries a `cleanup` block — `stoppedProcesses`, `releasedEndpoints`, `collectedResources`
  and `retainedResources` with the reason each survived.
- Cross-process destructive-operation locking. A `repository_operation_leases` table (migration
  `010`) serializes `remove`, `gc` and `repair` per repository across separate CLI processes and the
  daemon, which a process-local mutex never could. A conflicting operation is refused with the new
  `WTM_OPERATION_CONFLICT` code (exit 3) naming the holding PID and when it took the lease.
- `wtm remove <selector> --resume`. Each stage of a removal is journalled on the lease, so a removal
  whose process died leaves a row naming the stage it stopped in. `--resume` adopts that lease and
  runs the lifecycle again; a plain re-run refuses rather than continuing a half-finished cleanup by
  accident. A lease is adoptable only when its owner is provably gone — a recycled PID is caught by
  comparing the process start time, not the number.
- `--refresh-remotes` on `wtm analyze` and `wtm remove`. It runs `git fetch --prune` for every remote
  an allowed remote-ref pattern selects, once per distinct repository, before any analysis. `--prune`
  is what makes it worth having: without it a branch deleted on the remote leaves its tracking ref
  behind and HEAD still looks remote-persisted. A failing fetch fails the command rather than
  quietly continuing on stale refs.
- `remoteKnowledge` on every worktree analysis — `source`, `refreshed`, `refreshedAt`, `confidence` —
  so a caller can tell a `LOCAL_ONLY` remote-persistence verdict from a `REFRESHED` one. Analysis
  itself still has no path that can reach the network.

### Fixed

- A worktree that had ever run a task could not be removed. The resources WTM itself materialized in
  it are untracked content to Git, so the first safety gate refused before the cleanup stage that
  exists to delete them — `cleanup.collectedResources` could only ever be `0`. That gate now defers
  a `GIT_UNTRACKED` blocker whose every path lies inside something WTM is about to collect, and
  refuses on anything else. Deferral authorizes nothing: the second analysis, which runs after
  cleanup and gates the deletion, is unchanged.
- Removing a worktree no longer orphans its managed processes or strands their ports. Stopping is
  the daemon's job — WTM never signals a supervised process from a second process — so a worktree
  with live process records and an unreachable daemon is refused with `WTM_DAEMON_UNAVAILABLE`
  instead of being deleted out from under them.
- A blocked `wtm remove` reports the analysis warnings it used to drop, which is exactly when a
  missing base ref or a gone upstream is worth reading.
- `WorktreeRemovalBlockedError` no longer carries `WTM_REMOVE_BLOCKED`, which was never a member of
  the protocol enum and would have failed envelope validation had it reached one.
- The CLI's error mapping had drifted four codes behind the protocol enum, so
  `WTM_OPERATION_CONFLICT` and the three daemon codes were flattened to `GIT_REPOSITORY_DEGRADED`
  and lost their exit codes. `docs/18-errors-json-contract.md` and the enum are now held together by
  a test.

## [0.1.0-rc.1] - 2026-08-30

### Added

- Local-first worktree discovery, configuration, runtime tasks, diagnostics, and safe removal.
- SQLite state, endpoint leases, daemon reconciliation, process supervision, and macOS LaunchAgent lifecycle.
- Built-in and explicitly trusted external adapter support.
- Guarded WTM resource materialization and garbage collection.
- Agent Skill integration, isolated end-to-end safety coverage, and release performance reporting.
- Standalone macOS executable built with Node SEA: the pinned Node 24 runtime, the SQL migrations and
  the agent skill are embedded, state is stored through `node:sqlite`, and no Node, Bun or native
  addon is required on the target machine.
- Reproducible release archives with `SHA256SUMS`, a tag/version and artifact gate
  (`bun run release:gate`), and a Homebrew formula rendered from real checksums
  (`bun run formula:render`).
- Tag-gated release workflow that builds natively on macOS arm64 and x64, attests the artifacts,
  and publishes to the GitHub Release, npm and the Homebrew tap only for `v*` tags.

### Fixed

- `wtm status`, `doctor`, `explain`, `plan`, `env` and `ports` read the persistent workspace
  registry. They previously ran against an empty data source and reported
  `WTM_NOT_INITIALIZED` even directly after a successful `wtm init`.
- `wtm run <task>` runs a configured task in the foreground. The command was implemented and
  tested but never registered on the CLI, so the documented foreground path did not exist.
- Public documentation, the bundled Agent Skill and the examples no longer describe commands the
  CLI does not have.
- `make install` restarts a daemon that is already running. The definition names the executable by
  path, so installing a new build left launchd serving the previous binary indefinitely.
- Registering a workspace writes `wtm.toml` and nothing else. `wtm init` also wrote an
  `.agents/skills/wtm/` tree into the repository; the Agent Skill is now opt-in through
  `wtm init --ai-skill` or `wtm skill install`.
- A workspace registered while the daemon is running is watched immediately, instead of staying
  undiscovered until the next daemon restart.
- `wtm status` run outside every known worktree reports no worktree, instead of answering with a
  different worktree's branch, state and ports.
- Endpoint leases are released whenever a worktree is found absent, not only on its first
  transition, so a removed worktree no longer holds its ports permanently.
- `wtm forget <path>` retires a single repository, leaving the rest of its workspace registered.
- A command whose reader closes the pipe exits quietly rather than printing an `EPIPE` stack trace.
- Repository reads that time out are retried serially with a wider bound, and an unreadable
  repository is diagnosed from an actual probe rather than assumed to be a permission problem.

### Changed

- The npm package ships only what `bin` and `main` resolve, so it no longer carries unreachable
  bundles, duplicate migrations or this project's internal planning ledger: 5.0 MB unpacked
  becomes 2.5 MB. Only the version field of the manifest reaches the bundles.

### Notes

- This is a prerelease. Its executables are ad-hoc signed, not Developer ID signed: macOS may
  require an explicit approval the first time one runs. Stable releases are refused by the release
  gate unless the executable is Developer ID signed.
- Install from the GitHub Release archives, from npm under the `next` dist-tag, or from source with
  `make install`. No Homebrew tap exists yet: the formula job runs for stable tags only.
- macOS only, on both Apple silicon and Intel.
