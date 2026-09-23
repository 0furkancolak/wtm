# Item 45 — Daemon Startup Crash Loop Implementation Plan

**Status: shipped.** This plan's checklist is complete; see `todo.md` (item 45) for the closing
note and commit list, and `git log` for implementation history. The design rationale below is kept
because other files in the repo cite this path.

**Goal:** After this change, a daemon that cannot start either recovers by itself or stops with one
actionable, coded reason. It no longer loops forever. `wtm doctor` and `wtm daemon install` both
say why it is down.

**Architecture:** There are four independent mechanisms, each of which closes one gap:
1. The Unix IPC publisher classifies whatever occupies the socket path. It reclaims only WTM's own
   stale close-shield placeholder and refuses everything else with `WTM_IPC_PATH_UNUSABLE`.
2. `daemon serve` knows whether a service manager is watching it. When one is and the failure is
   permanent, it exits 0 so the manager stops restarting it. Both service definitions state the
   same retry interval.
3. Every startup writes its outcome to one rewritten file, `daemon-status.json`. That file
   de-duplicates frames across launches and feeds `doctor` and `install`.
4. The daemon's own log files are rotated at startup.

**Tech Stack:** TypeScript on Node 24 / Bun 1.3, `bun:test`, zod, launchd plist and systemd unit
rendering.

**Spec:** `docs/superpowers/specs/2026-09-09-daemon-startup-crash-loop.md`. Read the "Revisions
after reading the code" section there (R1–R5) for the decisions this plan implemented in revised
form.

## What shipped, in outline

1. `WTM_IPC_PATH_UNUSABLE` registered as a stable error code, exit class 2
   (`packages/protocol/src/errors.ts`, `docs/18-errors-json-contract.md`).
2. The Unix IPC publisher classifies the socket-path occupant and reclaims only a stale
   close-shield placeholder (regular file, owned by the current uid, empty, mode 0600, one link,
   at least 30s old); everything else is refused with a coded error
   (`packages/platform/src/ipc/path-unusable.ts`).
3. A supervised daemon (`WTM_DAEMON_SUPERVISED=1`, set by both the launchd plist and the systemd
   unit) exits 0 on a permanent startup failure instead of looping; both service definitions retry
   at the same interval (plist `ThrottleInterval=10`, unit `RestartSec=10`,
   `StartLimitIntervalSec=0`).
4. Every startup outcome is recorded in `daemon-status.json` under the service `logRoot`, written
   temp-file-plus-rename at mode 0600, de-duplicating frames across launches.
5. Daemon log files are rotated at startup, reusing `ManagedLogStore`'s defaults (20 MiB, 3
   retained generations).
6. `wtm doctor` and `wtm daemon install` both surface the reason a daemon failed to start, sourced
   from `daemon-status.json`.

**Type consistency (kept for reference):** `DaemonStartupOutcome.remediation` and
`DaemonStatus.remediation` are `string[] | null` everywhere. `formatRemediation` is the only place
an argv becomes text, used by `doctor` and nothing else, because the install warning keeps the
argv.

**Explicitly out of scope, per the spec:** Windows IPC (`packages/platform/src/ipc/windows.ts` is
untouched), removing the close-shield placeholder mechanism, and a `wtm daemon logs` command.
