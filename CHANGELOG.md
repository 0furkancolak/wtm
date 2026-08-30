# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

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
