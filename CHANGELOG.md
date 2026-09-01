# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

Targeted at **`v0.2.0`**. This project is still `0.x`: the public API and the on-disk state contract
are unstable, and a breaking change may land in a minor release without a deprecation window.

<!-- gatekeeper-quarantine:start -->
### Before you run a macOS binary downloaded through a browser

A browser stamps `com.apple.quarantine` on what it saves, and these executables are only ad-hoc
signed, so macOS sends `SIGKILL` at `exec`. The process dies before any WTM code runs: exit 137,
nothing on stdout, nothing on stderr, and no error WTM is able to report about itself. Clear the
attribute from the downloaded file first:

```bash
xattr -d com.apple.quarantine wtm
```

Installing with `curl` and `tar` as the README describes is unaffected — neither writes the
quarantine attribute. This note is a workaround for a defect and is removed once the stable macOS
binaries are Developer ID signed and notarized.
<!-- gatekeeper-quarantine:end -->

### Added

- **A platform seam, and a Linux backend behind it that has not yet run on Linux.** On macOS
  nothing about this release behaves differently: the launchd lifecycle, the paths, the socket and
  the process identity are the same code, moved. What changed is that the operating system is now a
  parameter. A new `@wtm/platform` package answers four questions — where files go, how long a Unix
  socket address may be, how to recognise a process WTM started, and how to register a service —
  and `@wtm/core` no longer contains a macOS-specific import, literal or spawned command, which a
  structural test now enforces.

  A complete Linux implementation of those four ports ships with it: XDG paths
  (`XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, honoured only when absolute), the
  108-byte `sun_path` limit, a systemd user unit named per `HOME` with the `systemctl --user`
  command set that drives it, and process identity read from `/proc/<pid>/stat` rather than `ps`.
  It is exercised against captured kernel fixtures and an injected fake `systemctl`, exactly the
  way the launchd backend has always been exercised against a fake `launchctl`.

  **That is not a claim that WTM runs on Linux.** There is no Linux CI job, no Linux binary, and
  nothing here has ever run on a Linux kernel; `package.json` still declares `"os": ["darwin"]` for
  that reason, and its description and keywords still say macOS. The next increment runs it on a
  kernel and changes all three together with the evidence. `README.md` states the position, and
  `docs/05-daemon-and-macos-runtime.md` — whose filename is now historical — documents both
  backends and marks what is unverified.
- `wtm doctor` reports a `platform` check: the selected runtime, the service manager it will use,
  the resolved data, log and socket roots, and the socket address limit in force. It is `pass` or
  `error`, and `error` only when WTM has no backend for the host.
- `WTM_PLATFORM_UNSUPPORTED` (exit 2). Starting WTM on a platform it has no backend for — today,
  Windows — is refused with a coded error naming the increment that will add it, rather than with
  the message "WTM V1 daemon requires macOS", which was becoming false.
- `wtm daemon status` and `install` report `definitionPath`, the platform-neutral name for the
  file WTM published. `plistPath` is retained beside it on macOS with the same value and marked
  deprecated; it is absent on Linux, where the definition is not a plist.
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
- A preflight on the daemon socket path. macOS caps a Unix socket address at 104 bytes, and a
  `HOME` deep enough to breach it used to surface as `listen EINVAL`. Both `wtm daemon serve` and
  `wtm daemon install` — and the CLI's connect side, so `wtm ps` explains itself too — now measure
  the address in bytes before binding and refuse with the new `WTM_SOCKET_PATH_TOO_LONG` code
  (exit 2) naming the measured length, the limit, and how much shorter the home directory has to
  be. The published path and the private path actually bound are both measured, so the check
  cannot be one byte optimistic.
- Two `doctor` checks. `socket-path` reports the headroom left under that limit while there is
  still headroom, rather than only once the daemon cannot start; it is the first check that
  describes the host rather than a workspace. `registration` answers whether this directory is
  inside a registered worktree and, separately, whether the daemon is reachable — two problems
  with different fixes that `doctor` used to be unable to tell apart.
- `wtm daemon status` reports the launchd `label` it is describing, and `docs/04-cli-reference.md`
  gains the output-field table the command never had.
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
- `Unknown task: <name>` now lists the tasks that do exist, ranked by closeness to what was typed
  and capped at ten with an `and N more` tail; the full list is in the error's `context` for
  `--json` consumers. In a workspace with no tasks at all the message says how to define one
  instead of printing an empty list. No command enumerates tasks, so this error was the only place
  the information could reach anyone.
- The README quick start defines a task before resolving one, so following it top to bottom in a
  clean workspace with no `Makefile` and no adapters produces no error. It used to run
  `wtm resolve dev` fifty lines before the README explained that tasks have to be defined. A test
  now executes the quick start's own commands against a temporary workspace, reading them out of
  `README.md` rather than carrying a copy.
- No user-facing failure prints a stack trace or a path from the machine that built the release.
  `wtm daemon serve` wrote `error.stack` to stderr beside the clean envelope it already printed,
  and anything escaping the CLI entry point became an unhandled rejection Node rendered in full.
  Stacks still reach the daemon's log file, which is where they are worth having.
- Two `HOME`s on one machine no longer report each other's daemon. The launchd label is derived
  from the resolved `HOME` (`dev.wtm.daemon.<digest>`) instead of being a constant, which is what
  makes `state`, `runState`, `plistPath` and `reachable` describe one agent — and what lets a
  second `HOME` install at all, since a launchd service name is `gui/<uid>/<label>`. An
  installation made under the earlier bare label is taken over on the next `install` or `status`
  when its plist is this `HOME`'s: the old service is booted out, the old plist removed, and the
  operation locks and transaction journals named after the old label swept, because the label
  change is what would otherwise strand them. A bare-label agent belonging to another `HOME` is
  left strictly alone.
- A worktree created with `git worktree add` while the daemon was down is no longer invisible
  until someone re-runs `wtm init`. A read command that lands in an unregistered directory
  reconciles the containing repository in process — the repository, not the whole workspace, which
  is `init`'s job and too expensive for a read path — then answers, warning `WTM_DAEMON_UNAVAILABLE`
  that it did so. The read never fails because the fallback failed. Once the daemon is back it
  reconciles at startup as it always did, so no manual `init` is needed either way.
- `wtm env` in a directory WTM has not registered reports `WTM_WORKSPACE_NOT_FOUND` (exit 2) and
  the message naming `wtm init`, instead of flattening both into `GIT_REPOSITORY_DEGRADED` and
  "Diagnostic data source failed." The diagnostics envelope now preserves an error that carries a
  schema-valid code, an explicit severity and a message — and still redacts and bounds it, so it
  gains its identity back without gaining an exemption.
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
