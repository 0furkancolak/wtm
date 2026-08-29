# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

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

### Changed

- The npm package ships only what `bin` and `main` resolve, so it no longer carries unreachable
  bundles, duplicate migrations or this project's internal planning ledger: 5.0 MB unpacked
  becomes 2.5 MB. Only the version field of the manifest reaches the bundles.

### Notes

- No public release, npm version, GitHub Release or Homebrew tap exists yet. The channels are
  prepared and verified locally; publication happens only when a matching tag workflow succeeds.
- Stable releases are refused unless the executable is Developer ID signed. Prereleases may ship
  ad-hoc signed.
