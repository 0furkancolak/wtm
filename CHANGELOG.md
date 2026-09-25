# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

Targeted at **`v0.2.0`**. This project is still `0.x`: the public API and the on-disk state contract
are unstable, and a breaking change may land in a minor release without a deprecation window.

### Added

- `worker_vars` on a task (and `wtm task set --worker-var`): names from the task's resolved
  environment that WTM passes to a `wrangler dev` worker as `--var NAME:VALUE`. wrangler builds a
  worker's `env` from its config `vars` and `.dev.vars`, never from the process environment, so a
  CORS allowlist or port WTM derived used to reach the wrangler process and stop there. The worker
  kept a symlinked `.dev.vars`'s static origins, and a browser on the WTM-leased port was refused
  by CORS. argv tasks only: values are passed one argument each and are never shell-parsed.
- `wtm doctor` has a `worker-env` check, and `wtm explain` a `<task>.worker_env` decision. Both say
  which WTM variables a worker's own files (`vars`, `.dev.vars`, `.env`) also define and that
  nothing forwards. This includes a `wrangler.json` that app code reads directly. Files are read
  for variable names only.
- `variables.toml`, the checked-in public half of `.env` some apps keep, is now a declaration
  file. CORS detection and `wtm init`/`wtm detect` read it ahead of the `.env` example files:
  names from `[vars]` and every `[env.<name>.vars]`, and safe port or URL values from `[vars]`
  and the `development`/`dev`/`local` tables. The app's tooling fills only variables the
  environment leaves empty, so WTM's value wins without any `worker_vars`. CORS variables are
  also detected in a task's own `cwd`. A monorepo app in `apps/api` gets the allowlist under the
  name its own `variables.toml` or `.env.example` declares, and other tasks don't.
- `WTM_DAEMON_TIMEOUT` (exit 4): the daemon accepted a request but did not answer in time, and
  may still complete it.
- Managed runs record how they ended: `exitCode` or `exitSignal` on `wtm ps` records and on
  `wtm status` processes (migration 019). `RUNTIME_START_FAILED` names the exit status and points
  at `wtm logs <task>`.
- `wtm ps --all` lists every recorded run.

### Changed

- `wtm resolve`, `wtm status` and `wtm doctor` (and `wtm tui`, which polls the last two) no longer
  lease ports. They answer from the leases a feature already holds. A worktree that never ran a
  task used to hold a port for every `[ports.*]` endpoint as soon as an agent ran `wtm status` in
  it. That used up the range and pushed features off their preferred ports. `wtm resolve` on an
  endpoint nothing has leased yet fails with `WTM_TEMPLATE_UNRESOLVED`, naming the endpoint and
  suggesting `wtm start <task>`. `wtm start`, `wtm run`, `wtm exec`, `wtm env` and `wtm explain`
  still lease.
- `wtm ps` lists live runs, and each stopped task's latest run when that run failed, instead of
  every run ever recorded across the workspace. In a busy workspace that was dozens of rows per
  task, labelled only by worktree id, and a crash was easy to miss among clean stops.
  `data.omitted` counts what was left out; `--all` restores the full list.

### Fixed

- A feature's ports could move while its tasks were running. When the worktree holding the
  feature's shared leases left Git's listing (removed outside `wtm remove`, or renamed, which on a
  case-insensitive disk can be a change of case alone), reconciliation released the leases. The
  next allocation then found the preferred port busy with the feature's own task and took another
  port. The leases now pass to a live worktree on the same branch.
- A shell whose working directory still spelled a renamed worktree's old path resolved to the old,
  orphaned worktree record. It then became the owner of the feature's new leases, which the next
  reconcile released. WTM now resolves such a directory through its real path, and never records a
  new lease on a dead worktree.
- `wtm status` reported a crashed run as `stopped`, the same word as a deliberate stop. It is now
  `failed`.
- A run that ended while no daemon was watching (daemon restarted, upgraded or crashed) was always
  recovered as `STOPPED`, even when it had crashed. Recovery now reads the anchor's completion
  marker and records `FAILED` with the exit status.
- `wtm ps`, `wtm start` and `wtm stop` records no longer include the start reservation's
  `cleanupOwnerToken`.
- A runtime command whose request timed out, or whose connection dropped mid-request, was
  reported as `WTM_DAEMON_UNAVAILABLE` ("WTM daemon is unavailable."), even though the daemon was
  running and often finished the request. `wtm daemon status` then showed it as reachable a moment
  later. A timeout is now `WTM_DAEMON_TIMEOUT`. A dropped connection says the request may have
  taken effect.
- `wtm start`, `wtm restart` and `wtm stop` waited only 5 seconds for the daemon. That is shorter
  than a `stop` inside a 5s `grace_period`, or a `start` queued behind the previous run's exit, so
  the first call after a crash could fail while the second succeeded. They now wait 60 seconds.

## [0.2.0-rc.2] - 2026-09-23

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

### Fixed

- The Make adapter's `workspace-here:<target>` task named `-f {workspace.root}/makefile` for a
  file called `Makefile` on a case-insensitive filesystem (the macOS default), because probing
  `makefile` with a read succeeded there. The name is now matched against the directory listing,
  so the `-f` path is always the spelling on disk.
- The test suite no longer depends on the machine it runs on. Several CLI tests reached the
  developer's own running daemon or opened their real state database (which panicked Bun's SQLite
  binding and took `main.test.ts` down with it), and a daemon scenario put its socket under
  macOS's long per-process `TMPDIR`, past the 104-byte socket address limit. All of them now use
  paths the test owns.

## [0.2.0-rc.1] - 2026-09-23

Targeted at **`v0.2.0`**. This project is still `0.x`: the public API and the on-disk state contract
are unstable, and a breaking change may land in a minor release without a deprecation window.

### Added

- `wtm ci watch`, `wtm ci status` and `wtm ci unwatch`: the daemon follows a commit's GitHub Actions
  runs through `gh` on a bounded budget, and `ci status` returns the result with a short,
  secret-masked summary of each failed job's log from local state, so an agent keeps working
  instead of waiting on CI.
- `wtm create <branch> --repos web,api,worker` creates the branch in several repositories of a
  workspace as one feature, with a start commit pinned per repository, every refusal decided
  before Git writes, and a `create` lease on each member. A partial creation is journalled, and
  `wtm create <branch> --resume` finishes it by inspecting each member's real Git state; it never
  re-runs an uncertain step blindly and never deletes anything. Migration 014 adds the feature
  and creation journal tables.
- Local Linux x64 `.tar.gz` construction with bounded ELF architecture inspection, exact archive
  members, executable permissions and SHA-256 output. The published release target set remains
  Darwin arm64/x64. Header inspection refuses FIFO/device inputs without waiting for a writer.
- Configurable `safety.untracked_symlinks = "ignore" | "review" | "block"`, resolved from the
  selected worktree's configuration. Symlink targets are not followed, inspection failures stop
  analysis, and `GIT_UNTRACKED_SYMLINKS` is distinct from ignored/untracked content. This policy
  does not force Git removal or unlink files.
- Windows anchor log authorization through bounded asynchronous SID/ACL inspection, with fresh
  evidence for mutations, empty-file authorization before writes and retained child ownership
  through cancellation. Windows remains experimental pending native acceptance.
- Linux mount-boundary evidence in cleanup estimates, including same-device bind mounts.
  Missing or changing evidence produces an unknown estimate rather than a removal permission.
- Failed UDP probes release their socket before the next probe. Log recovery tolerates bounded
  rename/reopen gaps while preserving ownership, generation and exact process identity checks.
- Release gates reject malformed performance counters and empty, duplicate or unpublished
  archive selections. Valid prerelease performance exceptions remain explicit.
- Batched endpoint bind probing: one bounded helper per allocation for Node and standalone
  installations, preserving preferred ports, stable leases and transactional collision checks.
- Opt-in estimated memory admission for queued tasks: global `jobs.memory` budget/headroom,
  per-task `memory_estimate_mib` and `queue_env` worker settings. Migration 013 preserves
  estimates and legacy unknowns; held slots retain reservations through cancellation/restart.
  Atomic FIFO claims consider available memory, with `memory_budget` diagnostics and explicit
  missing/unfit estimate errors. This is not an OS-enforced RAM cap or measured RAM savings.
- Bounded HTTP readiness for `start`/`restart --wait --timeout`: strict healthcheck config,
  process/completion evidence, JSON observations and connection-scoped IPC cancellation.
  Normal start reports NOT_CHECKED. Timeout/disconnect ends observation without stopping
  the managed service. Real HTTP/TCP integration and Linux x64 native lifecycle tests pass;
  independent observer review is complete; other native platform gates remain open.
- Bounded metadata-only disk estimates in cleanup ranking, after existing safety/activity
  tiers. Partial/unknown scans are distinct from zero, and estimates never authorize removal.
- Queue records expose current `waitingReason` in list/status/result/cancel: concurrency,
  same-worktree occupancy, FIFO position, memory admission or pending dispatch. This observation
  shares the claim policy and does not reserve a slot.
- Persistent FIFO heavy-task queue on the existing daemon and SQLite state. `wtm run <task>
  --enqueue` returns a durable job ID; `wtm jobs list/status/logs/result/cancel` manages it.
  Tasks opt in with `queue = true` and a finite timeout. Daemon global
  `[jobs].max_concurrent_heavy` defaults to one across repositories in the same host/user/state
  scope; this is concurrency admission, not a hard RAM limit. Foreground `run` and background
  `start` retain their existing roles.
- Atomic queue claims, idempotency keys, repository lease exclusion, bounded logs/history,
  durable completion evidence and conservative restart reconciliation. Unconfirmed process
  cleanup holds its slot. Source/config fingerprints prevent stale results being reported as
  current validation; ignored/external inputs and filesystem snapshot races remain outside
  that evidence. Agent Skill documents submit/continue/verify and bounded status checks.
- State migration 012 binds future recovery to a private digest of the host and user identity.
  First upgrade adopts legacy state under the existing host-local assumption; legacy host
  provenance cannot be reconstructed. Native queue/process verification remains required;
  the current development container refuses Unix socket listeners.
- Separate ignored-file counts, paths, and classification in worktree analysis, with
  `GIT_IGNORED_CONTENT` (exit 3). Consumers aggregating local-only content must now read both
  `untracked` and `ignored`. Runtime cleanup continues to defer only fully reclaimable content
  and rechecks safety before removing the worktree. Invalid UTF-8 Git paths and filesystem
  inspection errors fail closed instead of making local content appear absent.
- CLI documentation checks cover command and option references in the README, CLI reference,
  Agent Skill, and example Markdown files. Fixed the README installation command to
  `wtm skill install`.

- **Linux x64 native validation.** An `ubuntu-latest` x64 job runs `lint`, `typecheck`, the full
  suite, `test:e2e`, `build`, `package:verify` and `binary:verify`. These gates passed for
  `75a8626` in [run 34457543774](https://github.com/0furkancolak/wtm/actions/runs/34457543774),
  with 1627 full-suite passes and 15 existing skips. Later changes require their own native
  evidence; the current local full/e2e/performance gates are not green. The job builds a
  real ELF and exercises it against a real repository: the daemon serves over its socket end to
  end, `wtm start` launches and supervises a managed task through the process anchor, and a trusted
  external adapter runs through its guarded child.

  The manifest now declares `"os": ["darwin", "linux", "win32"]`. Windows has a configured
  native CI job but remains experimental with failing gates; manifest eligibility is not native
  acceptance. See SUPPORT.md for the current evidence and distribution boundaries.

  Four things this deliberately does **not** claim. **Nothing is released for Linux** — the release
  workflow, required published artifacts, signing rule and Homebrew formula are still macOS-only,
  so a verified Linux installation currently starts from source; npm publication is unverified. **Not arm64**: there is
  no Linux arm64 runner and no Linux arm64 build. **Not musl or Alpine**: `ubuntu-latest` is glibc.
  And **the systemd lifecycle is not integration-tested** — a CI runner has no logind user session,
  so install → enable → start cannot be exercised there, and `HOME` isolation cannot manufacture
  one. What CI proves about it is that the CLI reaches the systemd backend, drives `systemctl`, and
  reports an unreachable user manager as a named condition. That is a written limitation rather
  than a skipped test.
- `WTM_WATCH_UNAVAILABLE` (exit 2). A registered root that cannot be put under a filesystem watch
  used to produce an anonymous error and a silent retry five times a second, forever, for a
  condition only a human can clear. It now carries a code, the reading that produced it, and the
  remedy for the host: on Linux an `ENOSPC` is the inotify watch budget rather than the disk, and
  the message names `fs.inotify.max_user_watches`. The retry backs off to one attempt a minute, so
  a raised limit is picked up without restarting the daemon, and the daemon keeps serving and
  reconciling while a root is unwatched.
- **A platform seam: the operating system is a parameter, not an assumption.** On macOS
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
  Its unit tests run against captured kernel fixtures and an injected fake `systemctl`, exactly the
  way the launchd backend has always been tested against a fake `launchctl`; the CI job above is
  what runs it on a kernel.

  `docs/05-daemon-and-macos-runtime.md` — whose filename is now historical — documents the
  macOS/Linux backends and the experimental Windows backend.
- `wtm doctor` reports a `platform` check: the selected runtime, the service manager it will use,
  the resolved data, log and socket roots, and the socket address limit in force. It is `pass` or
  `error`, and `error` only when WTM has no backend for the host.
- `WTM_PLATFORM_UNSUPPORTED` (exit 2). Starting WTM on a platform it has no backend for
  is refused with a coded error, rather than with
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
  `010`) serializes `remove` and `gc` per repository across separate CLI processes and the
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
- `--worktree <selector>` and `--repo <name>` on `resolve`, `run`, `start`, `stop`, `restart`, `logs`
  and `exec` target another worktree without `cd`, through the selector `analyze` and `remove` use.
  From a workspace root, the commands refuse without `--worktree` and list the candidates.

### Changed

- The WTM Agent Skill is now an agent's complete WTM reference, so a conversation no longer spends
  tokens rediscovering WTM from the README, `docs/` or `--help`. It opens with what WTM is, the
  JSON envelope and exit classes, and a map of every visible command, and it teaches task discovery
  through `wtm resolve`'s `context.knownTasks` and worktree creation through `wtm create`. A new
  section tells an agent to keep working instead of waiting on CI inside a tool call. A test fails
  when a CLI command is missing from the map or the skill grows past 24 KiB.
- `analyze` and `remove` share one worktree selector: `analyze` accepts a directory name and refuses
  an ambiguous selector instead of taking the first match; a number and a directory name naming
  different worktrees are ambiguous for both; `remove`'s selector error reports `matches` as a list
  and `matchCount`.

### Fixed

- `wtm doctor` on a machine with no registered workspace, such as one that has never run
  `wtm init`, now says why the daemon is down when it has recorded a failed start. The failure
  still exits 2 with `WTM_NOT_INITIALIZED`, and the daemon's own code, how long it has been
  failing and its remedy are carried beside it as a warning. Before, `doctor` stopped before
  reading anything, and with no state database there was nothing for it to read.
- Correct the performance report entrypoint import so measurement can start; ordinary tests
  now exercise its actual JSON output and blocker exit code using fixture measurements.
- Preserve the canonical pathname during private-directory opened-handle validation so Windows
  ACL ownership checks do not receive an empty path. Git CLI fixtures resolve Git from PATH
  and use a portable Node foreground task, preserving their existing assertions.
- Job finalization honors cancellation committed during asynchronous source validation,
  retaining numeric exit evidence without reporting the cancelled job as successful.
  Authenticated timeout precedence and terminal result immutability are preserved.
- Durable task completion preserves null exit codes and signals. The supervising anchor's
  separate exit status no longer replaces a signal-ended task's missing numeric code or
  invents an exit code for a task refused before launch.
- Resource guards explicitly close inode pins after GC, including failures and one-shot
  authorization. Closing drains in-flight checks and rejects later use without weakening
  path identity checks; callers of `createResourceGuard` must close their guard in `finally`.
- Native queue fixtures execute fingerprinted script files instead of JavaScript embedded in
  template argv. SQLite upgrade and ignored-removal assertions match migration 012 and
  `GIT_IGNORED_CONTENT`, retaining exact safety checks.
- Managed completion and generation reads verify the regular path before and after opening,
  and compare it with the held descriptor. Symlinks and swapped files are refused even when
  the platform's `O_NOFOLLOW` does not prevent following a link.
- **The file-identity check that guards every destructive operation did not hold on Linux.** WTM
  answers "is the object at this path still the object I inspected?" by comparing `(dev, ino, uid)`,
  in fourteen files: the destructive-operation core behind `wtm remove`, the resource sandbox, the
  GC's quarantine protocol, the adapter trust store, and the service publisher's transactional
  rename. APFS never hands a deleted inode number back; ext4 and tmpfs hand it back immediately, so
  delete-then-recreate at the same path produced an object the check called identical — and for the
  precise attack it exists to stop, substituting a file between check and use, it returned the wrong
  answer. The predicate now holds an open descriptor on the pinned object and additionally requires
  the link count to be non-zero, so an object that was unlinked can never be mistaken for one that
  was not, whatever number the filesystem reissues. Six tests had been asserting exactly this and
  were failing on Linux; not one of them was relaxed. A measurement test records what the running
  filesystem actually does with a reused inode, so this stops being an inference on either platform.
- **`systemctl --user` could never have worked, on any Linux host.** The runner passed `execFile` an
  `env` of five names, which *replaces* the environment rather than extending it, so `systemctl`
  lost `$DBUS_SESSION_BUS_ADDRESS` and `$XDG_RUNTIME_DIR` and could not find the user bus. The bus
  variables and the unit-lookup variables (`HOME`, `XDG_CONFIG_HOME`) now pass through from the WTM
  process, and a name that is absent stays absent — sd-bus reads an empty
  `DBUS_SESSION_BUS_ADDRESS` as a configured address that does not work, which is worse than none.
- An unreachable user service manager is one named condition on both platforms. Linux reported it as
  `WTM_DAEMON_REQUEST_FAILED` at exit 1; it is now `WTM_DAEMON_UNAVAILABLE` at exit 4 with the
  message `The systemd user domain is unavailable.` — the same code and status macOS has reported
  for the identical launchd condition since before the seam existed. systemd does not spend an exit
  status on a bus failure, so the command runner classifies it, in the layer that already knows
  `systemctl` 5 and `launchctl` 113 both mean "no such service". macOS never produces the new
  classification, so its command sequence is byte-identical.
- External adapters could not run on Linux. The adapter executes from an unlinked private copy
  addressed as `/dev/fd/<n>`, and being anonymous is the security guarantee; on Linux `/dev/fd` is
  `/proc/self/fd`, whose magic symlinks read `"… (deleted)"` once the file is unlinked, so Node's
  ESM resolver failed its `realpath` while `stat` and `open` on the same descriptor still worked.
  The child exited 1 with empty stderr and every failure flattened into `External adapter request
  failed.` Twenty-five tests were red and none of them carried any information about why.
- `wtm remove --help` constructed a daemon client and dialled the socket in order to print static
  text. Nothing downstream of `--help` can reach the daemon, so the connection had no reader even
  when it succeeded — and its silence is why the behaviour survived: two tests passed only because
  the developer's machine happened to have a daemon running, and turned red on the identical commit
  once it stopped. Help invocations no longer count as runtime invocations, pinned by a test that
  counts connections arriving at a real listening socket.
- On Linux, a `/proc` entry that cannot be read is treated as "not a member of this group" rather
  than failing the whole scan. `ENOENT` was already handled — a process exiting mid-walk is
  ordinary — but an `EACCES` or `EPERM` on another user's entry made every group inspection fail,
  and a failed inspection stops the supervisor from killing a group it should kill. macOS has had
  the right semantics for free, because `ps` simply omits rows it may not see.
- `linuxSocketPathLimitBytes = 108` is measured rather than cited. On the Linux job a Node child
  sweeps address lengths from 96 to 128 bytes and asserts where `listen` and `connect` draw the
  line. It is measured on `ubuntu-latest` x64 glibc under Node 24 and nowhere else; what it buys is
  notice — a kernel or libc that moved the boundary becomes a red build naming the constant instead
  of a daemon that refuses a path it could have bound.
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
- A non-socket file at the daemon's socket path no longer leaves the daemon restarting forever. On
  one machine a 0-byte file at `.tmd.sock` kept it down for seven days, silently, and grew
  `daemon.error.log` to 162 MB. WTM's own leftover close-shield placeholder — ours, empty, `0600`,
  one link, at least 30 s old — is now reclaimed. Anything else — a file other than WTM's own
  empty, 0600, single-link placeholder at least 30 s old, a directory, a symlink, or another user's
  file — stops the daemon with `WTM_IPC_PATH_UNUSABLE` (exit 2), naming the path, what occupies it
  and what to do. Each startup outcome is recorded in `daemon-status.json` beside the daemon's
  logs: `wtm doctor`, when run in a directory WTM has registered, says why an unreachable daemon is
  down and since when, and `wtm daemon install` warns when the daemon it installed did not start,
  with the reason. A repeated startup failure writes its stack frames once rather than on every
  launch, a registered repository missing from disk is one line instead of a stack trace, and the
  daemon's own logs are rotated at startup so no failure grows them without bound.
- An unsafe private directory no longer leaves a supervised daemon restarting every 10 s. This
  covers WTM's data root, its database directory and the daemon's socket directory, when one is a
  symbolic link, not a directory, another user's, or readable by others. Such a directory used to
  fail startup without a code, so launchd and systemd retried it forever. It now stops the daemon
  with the new `WTM_PRIVATE_DIRECTORY_UNSAFE` code (exit 2), naming the path and the reason. A
  directory that is only readable by others also gets `chmod 700 <path>` as the remediation. A
  directory that could not be read at all, or changed while it was checked, is still retried,
  because that can clear on its own. So is one WTM has yet to create inside a directory that is
  not the user's, such as a home directory whose volume is not mounted yet.
- A `wtm daemon serve` refused because a daemon is already serving (usually one run by hand next to
  the service) no longer overwrites that daemon's record in `daemon-status.json`. `wtm doctor` used
  to blame the service's next failure on that refusal.

### Changed

- Both service definitions now retry a failed daemon every 10 s (launchd `ThrottleInterval` 10;
  systemd `RestartSec=10` with `StartLimitIntervalSec=0`) and set `WTM_DAEMON_SUPERVISED=1`. A
  supervised daemon exits 0 on a startup failure only a person can fix (exit class 2), so the
  supervisor stops restarting it; anything else is still retried. Re-run `wtm daemon install` to
  pick up the new definition.

### Added

- `wtm task set/list/show/unset/export`: a worktree-scoped task record that overrides the same
  task name in `wtm.toml` and any adapter-derived task. It wins over file configuration, `wtm
  explain` always names the database as the source of an overridden field, and `wtm task export`
  round-trips a record back to a `[tasks.<name>]` block. There is no separate trust ledger for
  this: the write already goes through the access-controlled local daemon socket, which is itself
  the trust decision. Migration 016 stores the override as the same validated task object
  `wtm.toml` would produce.
- `[tasks.<name>.idle]`: a `wtm start`-managed long-running task can opt into being stopped after
  a configurable period with no WTM interaction (`enabled = true`, `timeout = "30m"`). WTM
  observes only its own interactions with a task — a start, a readiness wait, `wtm ps`, `wtm
  logs` — never traffic at the task's own port, so this is deliberately narrow: a task serving a
  browser for an hour with nobody touching WTM reads as idle and is suspended. Suspension is an
  ordinary stop (the same SIGTERM/grace/SIGKILL path, the same `STOPPED` state, the same
  `[events."runtime.stopped"]`), and resume is free — the next `wtm start` starts it again like
  any other non-running singleton task. Per-task opt-in rather than a root `[runtime.idle]` table,
  since a root `[runtime]` table does not exist and a workspace-wide switch would need a
  heuristic for which tasks are safe to interrupt.
- `wtm init --preset <name>` seeds a brand-new `wtm.toml` from one of seven starters (`nextjs`,
  `nextjs-hono`, `bun-monorepo`, `docker-compose`, `python-uv`, `rust`, `go`), copied verbatim
  from `examples/<name>/wtm.toml` except for the workspace name. It never overrides repository
  detection: detection still runs first and the preset only seeds where detection found nothing
  to write; an unknown preset name is refused naming the known list.
- `wtm status --pr`: an optional section reporting the current worktree's pull request (number,
  URL, state, mergeability, rolled-up CI check status), gated behind the flag so `status` never
  touches the network otherwise. A branch with no open PR reports `null` rather than an error, and
  when the lookup itself cannot run (no CI provider for the remote, `gh` missing or
  unauthenticated) the command still succeeds, with the reason carried alongside a `null` result.
- `install.sh` (POSIX `sh`, macOS + Linux) and `install.ps1` (PowerShell 5.1+, Windows) at the
  repository root: a one-line `curl -fsSL .../install.sh | sh` / `irm .../install.ps1 | iex`
  install of a released standalone binary. Both resolve CPU architecture and the release tag,
  download the matching archive plus `SHA256SUMS`, refuse to extract anything on a checksum
  mismatch, and install into a user-owned prefix (`$HOME/.local/bin`, or
  `$env:LOCALAPPDATA\wtm\bin` on Windows). Re-running either script overwrites an existing install
  in place — that is the upgrade path. Neither registers the daemon; that stays `make install`'s
  job.
- `wtm adapter untrust <adapter-id>` revokes every trust record for an adapter ID and reports `{
  removed: boolean }`, never erroring when nothing was trusted. Until now, ending trust
  deliberately (an adapter being retired, a repository-local decision reversed) had no CLI path
  even though the underlying binary never changed — only re-trusting under a new binary, or
  editing the state database by hand, could clear a record.
- A local reverse proxy backend (`[proxy]`, off by default): every active endpoint lease becomes
  reachable at `http://<service>.<slug>.wtm.localhost:<port>`, where `<slug>` is derived from the
  worktree's branch with deterministic collision disambiguation. The routing table is rebuilt from
  existing endpoint-lease/worktree state on every request rather than cached, the listener binds
  loopback-only, and every `Host` header is validated against an active route before anything is
  proxied. HTTPS/certificates and dev-overlay injection stay out of scope for this slice. When
  `[proxy]` is enabled, a leased endpoint's proxy hostname is also joined into that worktree's CORS
  allowlist alongside its dynamic-port origin.
- `[budgets]`: an optional, daemon-wide admission gate on `start`/`restart`. `max_processes` caps
  how many processes the daemon will supervise at once, host-wide; `min_available_memory_mib` is a
  floor on host *available* memory (not a cap on WTM's own usage — WTM does not sum RSS across a
  process tree, for the same cost/accuracy reasons the heavy-job queue's own memory admission
  already avoids it), reusing that same host-memory reading rather than a second accounting.
  Replacing an already-running instance of a task never counts against either limit — only a
  `start`/`restart` that would create a net-new process can be refused, with
  `RUNTIME_PROCESS_BUDGET_EXCEEDED` or `RUNTIME_MEMORY_BUDGET_EXCEEDED`. Disk budgets and
  OS-enforced hard limits (cgroups, Job Objects, `rlimit`) are explicitly out of scope: neither has
  a single admission choke point or platform verification behind it yet.
- `@wtm/adapter-sdk`, an internal package for writing external adapters: `defineAdapter` and
  `runAdapter` implement docs/06's stdin/stdout request loop so an adapter author does not
  hand-roll it, and its `./testing` subpath exports `invokeAdapter`, a development-time harness
  that runs a candidate adapter file and validates its response against the same protocol schemas
  WTM's daemon uses. A new `docs/19-adapter-authoring-guide.md` walks through writing, packaging
  and testing an adapter with it.
- Linux x64 and arm64 release archives, and a Windows x64 zip, join the existing macOS archives in
  the release workflow, each verified natively on its own platform before publishing
  (`verify-linux` on `ubuntu-24.04`/`ubuntu-24.04-arm`, `verify-windows` on `windows-latest`). No
  tag has shipped either yet — see [Platform support](README.md#platform-support) for what is
  actually published today.

### Fixed

- A command name that relies on `PATHEXT` (a `.cmd`/`.bat`/`.exe` resolved by extension rather
  than spelled out) now resolves on Windows the way a shell would resolve it, instead of only ever
  matching a literal, extensionless name.
- The Windows service lifecycle no longer assumes a POSIX uid anywhere in its construction.
- `wtm forget` resolves a selector with `node:path` instead of testing for a leading `/`, so an
  absolute Windows path (`C:\projects\repo`) is recognized as absolute instead of being glued onto
  the working directory into a path that names nothing and falls through to retiring the whole
  containing workspace.
- A private-directory refusal is now filed in the class it belongs to: `ENOTDIR` and `ELOOP` join
  the already-coded, human-fixable class instead of the uncoded, endlessly-retried one, so a
  supervised daemon stops on a condition only a person can clear instead of retrying it forever.
- The Windows release archive is now genuinely optional in the whole-release gate, matching
  `CLAUDE.md`'s "win32 CI is informational until todo item 9 lands" rule: a real tag whose Windows
  leg hit a still-open native failure no longer blocks the macOS and Linux archives it has nothing
  to do with. `release.yml`'s `verify-windows` job is `continue-on-error`, matching `ci.yml`'s own
  win32 leg.
- A worktree's local-reverse-proxy hostname no longer bakes in a literal `refs-heads-` segment —
  `WorktreeRecord.branch` carries the full ref from `git worktree list --porcelain`, not the short
  name, and the hostname slug now strips `refs/heads/` before it before slugifying.

Windows native test-parity work continued across this range beyond the fixes above (anchor
handshake timing budgets, ACL-based test fixtures, scenario timeout bounds, lifecycle-parity
coverage): internal test-infrastructure corrections that make the win32 CI leg measure the real
platform accurately, not new user-facing behavior on their own. See `CLAUDE.md`'s CI section for
the win32 leg's current (informational) status.

### Changed

- The unused `resources` table (migration 001) is dropped by migration 018. It had no production
  writer: the real resource-GC schema is `resource_sandboxes`/`resource_storage_objects`
  (migration 006), and connecting a writer to it is out of scope for this release (docs/13's
  "decision K12") because the only production resource pipeline, worktree-local `[resources]`
  preparation, must never call into the sandbox engine that a writer would need — doing so would
  let `gc` walk a Git working tree, which the sandbox guard explicitly refuses. No behavior change
  for any documented command.

### Added

- Scoop manifest rendering (`bun run scoop:render`, `scripts/render-scoop-manifest.ts`), mirroring
  the existing Homebrew formula pipeline: a checked-in template substituted from a real release
  checksum, JSON-validated before it is written, and a new `scoop-manifest` release job that
  renders it from the Windows archive's SHA-256 and pushes it to a bucket repository only when
  `SCOOP_BUCKET_TOKEN` is configured. Since `verify-windows` is informational, the job skips
  gracefully (with a warning) when a tag's Windows leg produced no archive; no Scoop bucket repo
  exists yet, so today the rendered manifest is only ever a build artifact.
- A dev overlay (`[dev-overlay]`, off by default, inert unless `[proxy]` is also enabled): the
  local reverse proxy injects a small identity/sibling-endpoints fragment into an HTML response,
  so a browser tab open on one of several worktrees' `web` services can be told apart from the
  others by more than a port number. Only `text/html`, uncompressed, non-streaming responses are
  buffered and spliced; every other response keeps the exact byte-for-byte path it always had,
  whether or not the overlay is configured. `[dev-overlay.repos.<name>].enabled` lets one
  repository opt out of an otherwise machine-wide default, or opt in under an otherwise-off one,
  independently of every other repository.
- `wtm checklist set/list/clear`: a worktree-scoped test/review checklist, editable from the CLI
  and, when the dev overlay is active, toggleable as real checkboxes directly in the injected
  fragment — the checkbox POSTs to a proxy-native `/__wtm/checklist` endpoint, so state round-trips
  without the browser ever reaching the daemon's Unix socket. Migration 017 adds the table.
- `wtm tui`: a terminal dashboard combining worktree/task status, a disk-usage and
  cleanup-candidate panel, and a log-tail view for the currently selected worktree, refreshed from
  the same daemon state every other command reads.
- `workspace-here:<target>`: a third `make` adapter task family alongside `make:<target>` and
  `workspace:<target>`. It runs a root Makefile target with the *worktree* as `cwd` instead of the
  workspace root, via an explicit `make -f <path>` rather than copying or symlinking the file —
  closing the gap where a root target whose recipe shells into a specific repository always
  reached the workspace's own checkout, never the worktree's. Only `WTM_WORKTREE_ROOT` and
  `WTM_WORKSPACE_ROOT` are injected.

### Notes

- This is a prerelease, and a narrower one than `v0.1.0-rc.1`: it was built and gated from a Linux
  sandbox with no macOS or Windows runner and no code-signing credentials available, so it ships a
  **Linux x64 archive only**. Its executable is unsigned; there is no macOS or Windows archive in
  this release at all, not merely an unsigned one.
- `bun run lint && bun run typecheck && bun run test` and `bun run test:e2e` all pass on this
  commit in that sandbox. GitHub Actions has been out of quota since 2026-09-21, so this build has
  no CI evidence layered on top of the local gate; see the `v*` tag's own Actions run for whether
  that has since changed.
- The real, stable `v0.2.0` — Developer ID signed and notarized macOS binaries, real macOS/Linux
  (arm64 included)/Windows CI evidence, and the first `npm publish` — needs `Apple`
  notarization credentials and an npm token that only the repository owner holds, plus the Actions
  quota outage clearing. See `todo.md`'s "Release checklist — v0.2.0" and "Kaptan'ın hesabına/
  donanımına bağlı kapılar" sections for the exact remaining list.

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
