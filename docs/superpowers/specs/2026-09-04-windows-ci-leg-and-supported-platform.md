# Increment D2, pass 2 — `win32` joins `supportedPlatforms`, a real `windows-latest` CI leg

## Status

Open. Pass 1 (`2026-09-04-windows-process-supervision.md`) closed with one section named
"what remains before Increment D2 as a whole can close": flipping `supportedPlatforms` to accept
`win32`, standing up a real `windows-latest` CI leg, and fixing whatever that leg is the first to
find. This pass does all three, proves everything provable on this macOS host (`lint`, `typecheck`,
`test` at 1310 pass/0 fail, `test:e2e`, `build`, `package:verify`, `binary:verify` — all green
locally), and pushes to let the real runner be the judge. D1's own rule — "only when a real CI run
can back it" — applies to the flip in this pass exactly as it did to D2 pass 1's own decision not to
flip it yet. This document's Status line moves to Closed only once that leg is green, with the run
ID recorded below the way pass 1 recorded `33846848105` for its own three legs.

The user's own instruction for this pass's scope was explicit and is the reason it is not a
narrower leg: **the same seven steps darwin and linux already run, in the same order** — not a
reduced Windows subset that would report the same word for a weaker claim, which is the exact
failure mode `ci.yml`'s own header comment already names for the linux leg.

## What this pass touches

- `supportedPlatforms` (`packages/platform/src/select.ts`): `['darwin', 'linux']` →
  `['darwin', 'linux', 'win32']`.
- The daemon's now-false Windows refusal message, deleted rather than patched.
- A real bug in `windowsPlatformPaths`'s `socketRoot`, found only because this pass asked "would
  this string actually bind" instead of leaving it an untested interface-parity field.
- The SEA (standalone executable) build, extended to produce a Windows `.exe`.
- `ci.yml`'s matrix, gaining a `{ platform: win32, arch: x64, runner: windows-latest }` leg running
  the full seven-step list.
- `package.json`'s `os` field and its own mechanical enforcement in `package-contents.test.ts`.
- Every test and testkit helper that stood between "the code compiles for win32" and "the full
  suite can run unmodified on a real Windows CI runner": `process-supervisor.test.ts`'s raw POSIX
  process-group signalling and shell-dependent spawns, and roughly a dozen fixture-writing test/
  scenario files that assumed a POSIX shebang script is a spawnable executable.

## Findings

- **F1 — a Windows named pipe address needs the `\\.\pipe\` namespace prefix; nothing adds it for
  you.** Confirmed against Node's own documentation ("Identifying paths for IPC connections"), not
  assumed: `net.Server.listen({ path })` does not detect a Windows platform and rewrite a plain
  string — the caller constructs the full namespaced name or `listen()` fails. D1 shipped
  `socketRoot: dataRoot` here — a plausible-looking directory path that would have failed the
  moment anything actually called `listen()` on it, untested because D1's own scope never reached a
  real bind. That is exactly the gap this pass exists to close: pass 1's own words, "only when a
  real CI run can back it," is what turns an interface-parity field nobody had exercised into a
  found bug rather than a shipped one.
- **F2 — `package-contents.test.ts` already mechanically ties a new CI leg to a new public platform
  claim, in the same change.** `expect(validated.sort()).toEqual([...manifest.os].sort())` reads
  `ci.yml`'s own matrix and compares it against `package.json`'s `os` field — added after the Linux
  precedent, so this is the first platform this project has added under that constraint rather than
  discovering it after the fact. Updating `ci.yml` without `package.json`, or the reverse, now fails
  loudly instead of silently drifting.
- **F3 — a named pipe's namespace has no per-user isolation of its own.** A POSIX socket path
  inherits whatever directory permissions its parent directory carries; `\\.\pipe\<name>` is a flat,
  machine-wide namespace with no directory to scope it. Two different user accounts on the same
  Windows machine picking the same literal pipe name would collide. The fix salts the name with
  `createHash('sha256').update(dataRoot).digest('hex')` — `dataRoot` is already the per-user value
  every other root on this platform derives from, so this reuses an existing source of per-user
  distinctness rather than inventing a second one.
- **F4 — `sea-smoke.test.ts`'s own Windows adaptation introduced a real regression, caught by its
  own test suite, not by inspection.** Making the fixture's `mkdtemp` prefix unconditionally
  `os.tmpdir()`-based (needed for Windows, which has no `/tmp`) broke the darwin run: `os.tmpdir()`
  on macOS resolves to a much longer path than `/tmp`, and the daemon's socket path is derived from
  `home`, which is built under that temp directory — long enough to exceed macOS's 104-byte
  `sun_path` limit (the same limit item 39 in `todo.md` diagnoses for a different code path), so the
  daemon failed to bind and the test hung until its timeout. Fixed by keeping the short `/tmp`
  prefix for POSIX and using `os.tmpdir()` only on `win32`, which has no such length-derived ceiling
  because F3's fixed-length hashed pipe name never varies with `home`'s length. Confirmed via a
  `git stash`/rerun comparison before and after, not by inference.
- **F5 — under `bun test`, `process.execPath` resolves to the `bun` binary, not `node`.** A
  cross-platform test replacement for `/bin/sh -c '...'` initially used `process.execPath` to spawn
  a Node one-liner; under this project's `bun test` runner that path pointed at `bun`, and
  `bun -e ''` prints Bun's own CLI help to stdout instead of doing nothing, breaking an assertion
  that expected empty output. Fixed by resolving `node` from `PATH` instead of trusting the running
  interpreter's own path to be the one the test meant.
- **F6 — a test-only Windows platform branch can still violate D8's core/protocol rule.** A first
  draft of the cross-platform executable-fixture migration put a `process.platform === 'win32'`
  branch directly inside a `@wtm/core` test scenario file. `platform-independence.test.ts` enforces
  that core and protocol never branch on `process.platform`, including in their own tests, and
  caught this immediately on a full suite run. Fixed by moving the branch into the shared testkit
  helper, which is exactly the kind of file the rule intends to hold the branch instead.

## Decisions

### E1 — `socketRoot` becomes a real named-pipe address, not a directory-shaped placeholder

`win32Join('\\\\.\\pipe', 'wtm-' + sha256(dataRoot))`. Fixes F1 and F3 together: the prefix makes
the string a valid pipe address at all, and the hash makes it a per-user one without adding a new
identity source.

### E2 — the daemon's `UnsupportedDaemonPlatformError` is deleted, not updated

Its entire reason to exist was a message — "Windows support is Increment D, which decides
process-group and service-manager semantics together" — that became false the moment `win32`
joined `supportedPlatforms`. Patching the string would have left a subclass with nothing left to
say; `assertSupportedRuntime` now raises `@wtm/platform`'s own `UnsupportedPlatformError` directly,
the same seam every other refusal in the codebase already uses.

### E3 — the SEA build gains a `win32` leg that skips stripping, deliberately and visibly

`seaBuildPlatform` accepts `win32`; the copied runtime is written to `wtm.exe` (Windows refuses to
run an extensionless file); `codesign` was already darwin-only and stays that way. Stripping is
skipped on Windows outright: there is no `/usr/bin/strip` and no GNU-binutils-compatible tool this
codebase can assume is on a `windows-latest` runner's `PATH`, and stripping a PE built by Node is
not something any prior increment measured. Guessing at an unproven strip tool risks corrupting the
section `postject` injects immediately after — the same category of risk this program's discipline
exists to avoid, so the published Windows binary carries its ~25 MB of debug/local symbols as a
named, deliberate size cost instead. A later pass can remove it once a real equivalent is chosen and
proven against actual output, not assumed to behave like `strip -x -S`.

### E4 — cross-platform executable fixtures move into `@wtm/testkit`, not into each call site

`writeExecutableFixture` (darwin/linux: a byte-identical shebang script; win32: a `.cjs`/`.mjs`
sibling plus a `.cmd` trampoline invoking it) and `resolveRealExecutablePath` (`where`/`which`) are
new testkit exports, used by `process-supervisor.test.ts`, `fake-adapter.ts`, and five `*.scenario.ts`
files that used to each spawn a shebang script or `which` inline. Centralizing here — rather than
branching in each call site — is what keeps F6's rule enforceable: the one file structurally
forbidden from platform branches (`@wtm/core`) never needs one, because the shared helper already
made the decision.

### E5 — `ManagedProcessSupervisor`'s own tests stop assuming a POSIX shell exists

Raw `process.kill(-pgid, signal)` call sites become a `hostSignalProcessGroup` dispatch onto the
pre-existing `ProcessPlatform.signalProcessGroup` port (D2 pass 1's own E1/E2); `/bin/sh -c`,
`/bin/sleep`, and `/usr/bin/true` fixture commands become `['node', '-e', ...]` invocations
resolved from `PATH` (F5). `sea-smoke.test.ts`'s own fixture task, which runs against a standalone
binary with no Node or Bun on its `PATH` by design, uses `ping -n <N> 127.0.0.1` instead — a
Windows-native, dependency-free substitute for a POSIX sleep, chosen over `timeout.exe` because that
tool refuses to run with redirected stdin, exactly the condition a supervised background process
runs under.

## What this pass does not claim

- **Not that any of this has run on a real Windows kernel.** Every finding and decision above is
  proven against `bun run test`, `test:e2e`, `build`, `package:verify`, and `binary:verify` on this
  macOS host — 1310 pass / 0 fail, plus the standalone binary's own 9-test smoke suite. The
  `windows-latest` CI leg this pass adds to `ci.yml` is the acceptance test for everything in this
  document, not a formality after the fact; this document's Status stays Open until it reports.
- **Not `inode-reuse-measurement.test.ts`'s Windows behavior.** Its `hostPlatform()` helper still
  throws for any platform other than `darwin`/`linux`, deliberately left unextended: NTFS's own
  file-ID reuse semantics after deletion are a real, specific kernel question this pass chose not to
  guess at, the same restraint D1 and D2 pass 1 applied to every other unmeasured Windows claim.
  The first Windows CI run is expected to hit this named failure, not silently pass it.
- **Not `quick-start.test.ts`'s `/bin/sh` dependency.** Its fixture command is a `printf` pipeline
  with no clean `cmd.exe` equivalent; left untouched rather than forced into a worse Windows
  substitute for no product benefit — quick-start's own Windows story is a separate, later item.
- **Not `service-lifecycle.ts`'s `process.getuid?.() ?? -1` gap on Windows**, which throws today and
  is tied to the still-open "Windows daemon lifecycle kararı" decision in `todo.md` (Scheduled Task
  vs. background process vs. service wrapper) — a product decision, not something this pass's scope
  covers.
- **Not `release-artifacts.ts` or `verify-release.ts`.** Neither is invoked by any of the seven CI
  steps this pass extends to Windows, and both already fully inject their host dependencies in their
  own tests. Multi-platform release packaging is Increment E's scope (`2026-08-31-v1-stable-program-
  map.md`), not D2's.
- **Not Linux arm64**, still absent from the CI matrix for lack of a free arm64 Linux runner —
  unrelated to this pass and unchanged by it.

## Acceptance criteria

1. `supportedPlatforms` includes `win32`; `assertSupportedRuntime` and every refusal message that
   enumerates supported platforms reflect three, not two.
2. `windowsPlatformPaths`'s `socketRoot` is a syntactically valid, per-user-distinct named-pipe
   address, proven by a test asserting the `\\.\pipe\wtm-` prefix and by a determinism/uniqueness
   test across two different `home` values.
3. `package.json`'s `os` field and `ci.yml`'s matrix both name exactly
   `{darwin, linux, win32}`, enforced by the existing mechanical equality check in
   `package-contents.test.ts` (F2) rather than by convention.
4. `ci.yml` runs the same seven steps — `lint`, `typecheck`, `test`, `test:e2e`, `build`,
   `package:verify`, `binary:verify` — on `windows-latest` that it already runs on `macos-15`,
   `macos-15-intel`, and `ubuntu-latest`, in the same order.
5. `bun run build:binary` produces a `wtm.exe` on Windows through the same `buildSea` pipeline used
   for darwin/linux, with its Windows-specific gap (no stripping) named in this document rather than
   silent.
6. Every test suite this pass touches passes unmodified in assertion intent on darwin (this host)
   and is written to also run for real on Windows, not merely to compile for it: no test in the
   changed set spawns `/bin/sh`, a bare shebang script, or a POSIX-only signal path without a
   `win32` equivalent, except the two named, deliberate exceptions above
   (`inode-reuse-measurement.test.ts`, `quick-start.test.ts`).
7. `lint`, `typecheck`, `test`, `test:e2e`, `build`, `package:verify`, `binary:verify` all pass
   locally on this macOS host with the full merged change set.
8. The real `windows-latest` CI leg passes the same seven steps, or every failure it is the first to
   find is triaged and either fixed (with the fix folded into this document) or named as a new,
   separate, deliberate gap the same way this document already names several.

## Outcome so far

Criteria 1–7 are met, proven locally on this macOS host: `lint` and `typecheck` clean across all
seven package projects; `test` at 1310 pass / 0 fail; `test:e2e` 1 pass; `build`, `package:verify`,
and `binary:verify` (9 pass / 0 fail on the SEA smoke suite) all green. `packages/platform/src/
select.ts`, `packages/daemon/src/main.ts`, `packages/platform/src/paths/platform-paths.ts`,
`scripts/build-sea.ts`, `.github/workflows/ci.yml`, `package.json`, and roughly a dozen test/
testkit files carry the changes described above.

Criterion 8 — the real `windows-latest` leg — is what this pass is pushed to find out. This section
is updated with the run ID and outcome once it reports, the same way D2 pass 1 appended its CI
confirmation after the fact rather than treating the spec as finished before the runner spoke.
