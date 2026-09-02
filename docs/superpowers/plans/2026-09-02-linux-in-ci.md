# Plan — Increment C2, Linux in CI

Spec: `docs/superpowers/specs/2026-09-02-linux-in-ci.md`

## Shape

Seven tasks in one wave, then the CI job, then the run. The wave is file-disjoint: ownership is
listed per task and no file appears twice. The lead owns
`packages/testkit/src/isolated-home.ts` (already written — it is the contract C2-2, C2-3 and
C2-6 all consume) and `.github/workflows/ci.yml`.

Unlike C1, this increment cannot be finished locally. Tasks 1-7 make macOS green with the Linux
half correct *by construction*; the claim is only settled by a CI run, and D14 governs what
happens to whatever that run finds.

## Wave 1

### C2-1 — The anchor speaks its supervisor's dialect (D1, D2)

The blocker. Every `wtm start` on Linux fails at `process-supervisor.ts:406`.

Owns: `packages/daemon/src/process-anchor.ts` · `packages/daemon/src/process-supervisor.ts` ·
`packages/daemon/src/__tests__/process-anchor.test.ts` ·
`packages/daemon/src/__tests__/process-supervisor.test.ts`

### C2-2 — Host-measured tests stop hardcoding macOS's answer (D3)

Owns: `packages/daemon/src/__tests__/socket-path-limit.test.ts` ·
`packages/cli/src/__tests__/socket-path.test.ts` ·
`packages/cli/src/__tests__/state-diagnostics.test.ts` ·
`packages/cli/src/commands/__tests__/daemon.test.ts`

### C2-3 — Fixture isolation reaches the scenario children (D4)

Owns: `packages/cli/src/__tests__/quick-start.test.ts` ·
`packages/cli/src/__tests__/full-workflow.scenario.ts` ·
`packages/daemon/src/__tests__/runtime-factory.test.ts` ·
`packages/daemon/src/__tests__/runtime-factory.scenario.ts`

### C2-4 — An unreadable `/proc` entry is not a group member (D6)

Owns: `packages/platform/src/process/linux.ts` ·
`packages/platform/src/process/__tests__/linux-process.test.ts`

### C2-5 — A failed watch gets a name and a remedy (D7, decidable half)

Owns: `packages/daemon/src/watcher.ts` · `packages/daemon/src/main.ts` ·
`packages/daemon/src/__tests__/watcher.test.ts` · `packages/daemon/src/__tests__/main.test.ts` ·
`packages/daemon/src/__tests__/main.scenario.ts` · `packages/protocol/src/errors.ts` ·
`packages/cli/src/exit-codes.ts` · `packages/cli/src/__tests__/exit-codes.test.ts` ·
`docs/18-errors-json-contract.md`

### C2-6 — The standalone executable builds on Linux (D8)

Owns: `scripts/build-sea.ts` · `scripts/__tests__/build-sea.test.ts` ·
`scripts/__tests__/sea-smoke.test.ts`

### C2-7 — 108 becomes a measurement (D5)

Owns: `packages/platform/src/socket/limits.ts` ·
`packages/platform/src/socket/__tests__/limit-measurement.test.ts` (new) ·
`packages/platform/src/socket/__tests__/measure-limit.child.ts` (new)

## Wave 2 (lead)

- `.github/workflows/ci.yml` — the ubuntu leg (D13).
- Push, read the run, apply D14 to every finding.

## Wave 3 (lead, after the first green run)

- `package.json` `os`, description, keywords; `scripts/__tests__/package-contents.test.ts`
  pinning the field (D10).
- `todo.md` item 9 Linux checklist; `README.md`, `CHANGELOG.md`, `docs/04-cli-reference.md`
  (the `plistPath` schedule, D11), `docs/05-daemon-and-macos-runtime.md`.
