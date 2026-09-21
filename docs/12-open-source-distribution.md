# Open-Source and Distribution Strategy

## License

Recommended project license: **Apache License 2.0**.

Reasons:

- permissive commercial/open-source reuse;
- explicit patent grant;
- compatible with an ecosystem where third parties may create adapters and integrations.

The final repository should include:

```text
LICENSE
NOTICE (when required by bundled dependencies)
README.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SECURITY.md
SUPPORT.md
CHANGELOG.md
```

## Open-source principles

- no required account;
- no cloud control plane;
- no default telemetry;
- no hidden network calls;
- no vendor-specific AI dependency;
- adapter protocol documented independently of implementation;
- JSON command contract versioned;
- configuration files human-editable;
- deterministic local tests for core behavior.

## Telemetry

V1 ships with telemetry disabled/nonexistent. If anonymous diagnostics are ever introduced, they must be opt-in and documented with the exact payload.

## Repository structure

Recommended:

```text
.github/
  ISSUE_TEMPLATE/
  workflows/

docs/
packages/
skills/
LICENSE
README.md
CONTRIBUTING.md
SECURITY.md
```

Tests are not a top-level directory: every test lives in a `__tests__/` directory beside the code it covers.

## TypeScript/runtime baseline

- TypeScript strict mode.
- Node.js 24 LTS for V1 runtime.
- Bun 1.3+ workspace for project development, dependency management, scripts and tests.
- minimal runtime dependencies.

Suggested libraries:

```text
commander         CLI parsing
smol-toml         TOML parsing
zod               config/protocol validation
better-sqlite3    transactional persistent state
```

Test tooling:

```text
bun test
```

Dependencies are recommendations for implementation; package health/license checks are required before the first public release.

## Rust policy

Do not add Rust because native code sounds faster.

Rust is approved only if a benchmark-backed ADR demonstrates that one narrow TypeScript/Node subsystem cannot meet a release performance/reliability budget. Candidate native boundaries:

- filesystem watch bridge;
- process identity inspection;
- APFS-specific clone helper.

The protocol/interface must allow the helper to be replaced.

## Distribution channels

The source supports two packaging formats. Building a package and publishing a verified install
channel are separate steps:

1. **Standalone executable.** A Node SEA build embeds the pinned Node 24 runtime, SQL migrations
   and agent skill. It uses `node:sqlite`, so it contains no native SQLite addon and needs no Node,
   Bun or compiler on the target machine. `bun run build:binary` selects a Mach-O, ELF or PE build
   backend for macOS, Linux or Windows; `bun run binary:verify` builds and exercises the executable.
2. **npm package** for developers already running Node 24+. This format uses `better-sqlite3` and
   ordinary Node module resolution. The manifest declares `"os": ["darwin", "linux", "win32"]`;
   that is installation eligibility, not evidence that every backend has passed its native gates.

Both formats run the same CLI. The npm build launches WTM children through `node <cli>`; the
standalone build re-invokes its own executable.

The configured verification and publication scopes differ:

| Workflow | Native runner targets | Effect |
| --- | --- | --- |
| `.github/workflows/ci.yml` | macOS arm64, macOS x64, Linux x64, Linux arm64, Windows x64 | Schedules lint, typecheck, tests, e2e, bundle/package verification and standalone smoke checks; publishes nothing |
| `.github/workflows/release.yml` | macOS arm64, macOS x64 (`verify`), Linux x64, Linux arm64 (`verify-linux`), Windows x64 (`verify-windows`) | Verifies all five artifacts and publishes them for version tags; Windows is optional (see below) |

A configured CI leg is not a claim that its latest run passed. Windows remains experimental, with
native failures tracked in the development notes. Until those failures are fixed (todo item 9), the
Windows leg is informational everywhere it appears, `release.yml` included: `ci.yml`'s win32 leg
runs the same steps with a 25 minute cap and does not fail the run, and `release.yml`'s
`verify-windows` job carries `continue-on-error` for the same reason — a native failure in either
one must never block the rest of a release. CI runs on pull requests and on pushes to `main`, once
per commit. Linux arm64 now uses `ubuntu-24.04-arm`; its first passing native result is still
pending. The five configured CI legs do not imply five *required* release targets: `scripts/artifact-targets.ts` publishes five
(`publishedReleaseTargets`) but only requires four (`requiredReleaseTargets`, everything except
`win32`) — a release whose Windows leg never produced an archive still ships macOS and Linux; a
Windows archive that *is* present is verified exactly as strictly as any other. Windows moves into
the required set once todo item 9 lands.

A manual `workflow_dispatch` run can narrow that 25 minute win32 leg to a chosen group of test
files instead of the full suite, to prove a fix green without waiting on every leg: dispatch the
workflow with the `win32_test_filter` input set to a space-separated list of test file paths or
patterns. The other four legs still start and keep their usual `Validate <platform> <arch>` names,
but every step after checkout is skipped, so they finish in seconds. The win32 leg itself skips its
full-suite-only steps (e2e, build, package, binary) since a targeted `bun test` result is the only
evidence being asked for; lint and typecheck still run, after the targeted tests so that a red lint
cannot cost the run its evidence. On a filter run the win32 leg is not `continue-on-error`: the
targeted tests decide the result, which is the point of dispatching one.

```bash
gh workflow run CI --ref <branch> -f win32_test_filter="packages/x/src/__tests__/a.test.ts packages/y/src/__tests__/b.test.ts"
```

Leaving the input empty (or triggering CI any other way) runs the full suite on every leg as before.

The tag workflow publishes `wtm-darwin-arm64.tar.gz`, `wtm-darwin-x64.tar.gz`,
`wtm-linux-x64.tar.gz`, `wtm-linux-arm64.tar.gz`, `wtm-windows-x64.zip` (when `verify-windows`
produced one) and `SHA256SUMS`. The verified published prerelease `v0.1.0-rc.1` carries the two
macOS assets only: it was tagged before the Linux and Windows legs existed, and no tag has been cut
since, so that half is workflow wiring no release run has exercised yet. Linux and Windows users
build from source until a tag carries those archives.

Signing and notarization are scoped to the platform family that has them. `codesign`, the notary
service and Gatekeeper are macOS facts, so the Linux and Windows legs run none of them and report
`not-applicable` for both. `scripts/verify-release.ts` accepts that answer only for a selection
holding no macOS archive: a macOS archive claiming it is refused, and so is a non-macOS leg claiming
a signature it could not have produced. The combined gate requires a signed, notarized macOS build
before a stable tag publishes, regardless of how many other archives are attached.

Local archive construction supports Linux x64 and arm64, and Windows x64: after
`bun run build:binary`, run `bun run release:artifacts` on that native host to produce
`dist/release/wtm-linux-x64.tar.gz`, `dist/release/wtm-linux-arm64.tar.gz` or
`dist/release/wtm-windows-x64.zip` and `SHA256SUMS`. The archive contains the executable, license,
notice and third-party notices. Construction checks a bounded platform-appropriate header against
the declared architecture — an ELF header (x86-64 or AArch64) on Linux, a PE header (`MZ` +
`PE\0\0` + machine field, read up to 1024 bytes since `e_lfanew` can point past a smaller bound) on
Windows — sets numeric archive ownership on the POSIX archives and writes checksums. The Windows
archive is zipped with PowerShell's `Compress-Archive`, present on every `windows-latest` runner,
rather than GNU tar. Both Linux CI legs separately archive and extract the freshly built SEA, verify
exact bytes, ownership, executable mode and checksums, and execute `--version`; the `verify-windows`
job does the same for the zip, with an exe extension and a `ping`-based task fixture in place of the
POSIX ones. Fixture header tests alone are not native execution evidence, and no real
`windows-latest` runner has exercised this path yet (see Release operations, below).

The npm registry publication, dist-tags and provenance have not been verified. A successful
`package:verify` is a build and dry-run tarball check, not proof that a registry installation works.
Use the documented source build or published macOS archive until the registry channel is verified.

A macOS Homebrew formula is prepared in `packaging/homebrew/wtm.rb.template` and rendered by
`bun run formula:render` from the two Darwin archive digests. The stable-tag workflow can update
`0furkancolak/homebrew-wtm` when a tap credential is configured. Public tap availability and a clean
Homebrew installation remain unverified; the template and update job alone do not establish a live
channel.

Archive extraction and npm installation do not register the daemon. Install the per-user service
explicitly with:

```bash
wtm daemon install
```

The source Makefile is different: `make install` registers the service by default on macOS and
Linux. `make install WITH_DAEMON=0` installs only the executable.

### Install scripts

`install.sh` (POSIX `sh`, macOS + Linux) and `install.ps1` (PowerShell 5.1+, Windows) at the
repository root script the manual curl+shasum steps README.md's install section already documents,
as the one-line `curl -fsSL .../install.sh | sh` / `irm .../install.ps1 | iex` experience. Both:

- map the detected OS and CPU architecture to one of the five archive names in
  `scripts/artifact-targets.ts` (`wtm-darwin-arm64.tar.gz`, `wtm-darwin-x64.tar.gz`,
  `wtm-linux-x64.tar.gz`, `wtm-linux-arm64.tar.gz`, `wtm-windows-x64.zip`); a combination outside
  that list is a clear, actionable error before any network call, never a silently wrong download;
- resolve the release tag to install from GitHub's `releases/latest` redirect (or the GitHub API
  equivalent), overridable with `--version`/`-v` (`-Version` on Windows) or the
  `WTM_INSTALL_VERSION` environment variable — needed today because the one published tag,
  `v0.1.0-rc.1`, is a prerelease, and GitHub's "latest release" excludes prereleases by default;
- download the archive and `SHA256SUMS` from the same `releases/download/<tag>/` path and verify
  the archive's digest against it — `shasum -a 256 -c --ignore-missing` (falling back to
  `sha256sum`) on POSIX, `Get-FileHash -Algorithm SHA256` compared against the parsed
  `SHA256SUMS` line on Windows — before extracting anything; a mismatch is a hard failure that
  installs nothing;
- extract and install the executable into `$HOME/.local/bin` by default (POSIX, overridable with
  `--prefix`/`WTM_INSTALL_PREFIX`, mirroring the Makefile's `PREFIX`/`BINDIR`) or
  `$env:LOCALAPPDATA\wtm\bin` by default (Windows, overridable with `-Prefix`/
  `WTM_INSTALL_PREFIX`, no administrator rights required), overwriting an existing install in
  place — this is the upgrade path, with no separate detection step;
- register no daemon service; that remains `make install`'s job (or `wtm daemon install` run by
  hand afterwards) — these scripts' scope is the binary alone.

Every network/base-URL touchpoint is overridable through `WTM_INSTALL_BASE_URL` (default
`https://github.com/0furkancolak/wtm`), which is what lets
`scripts/__tests__/install-script.test.ts` run `install.sh` as a real child process against a
local `Bun.serve` fixture server instead of reaching GitHub, per CLAUDE.md's "tests never reach
the network" rule. That test file also builds a small real fixture archive and `SHA256SUMS`, and
covers a clean install, a tampered checksum, the upgrade/overwrite path, and an unsupported
OS/arch (via the `WTM_INSTALL_OS`/`WTM_INSTALL_ARCH` test-only detection seam) — but it necessarily
runs `install.sh` with `Bun.spawn`, not the blocking `child_process.spawnSync` other release
scripts here use, because a blocking spawn in the same process as the fixture HTTP server
deadlocks against it. `install.ps1` has only a structural check (file exists, is non-empty, its
braces/quotes/parentheses balance) — the sandbox these scripts were written in has no
`pwsh`/`powershell` binary, so it has never actually been executed.

As with every other channel in this document, neither script has been proven against a real
release: no tag has ever published a Linux or Windows archive (only the macOS-only `v0.1.0-rc.1`
prerelease exists), so both scripts' non-macOS paths — and `install.ps1` end to end — remain open
evidence gaps until a future tag and, for Windows, a real `pwsh`/`powershell` run close them.

## Release operations

Ordinary CI publishes nothing. Publication runs only for `v*` tags, and every publishing job is
guarded by `startsWith(github.ref, 'refs/tags/v')`.

The tag workflow (`.github/workflows/release.yml`):

- builds and verifies the executable natively on macOS arm64, macOS x64 (`verify`), Linux x64,
  Linux arm64 (`verify-linux`) and Windows x64 (`verify-windows`, `continue-on-error`);
- measures performance inside each matrix/job and records `PERFORMANCE.json` alongside signing,
  notarization and smoke evidence for that leg. There is no separate `Performance` workflow.
  `publish` depends on all three verify jobs and runs the combined artifact gate again over
  whichever archives actually got uploaded;
- requires the tag to match the `package.json` version exactly, including any prerelease suffix;
- checks executable smoke results, recomputes archive digests and requires every *required*
  archive (the four non-Windows ones) before publication; a present Windows archive is checked
  exactly as strictly, but publication does not wait on one, per todo item 9;
- requires a **stable** release to have Developer ID signing, successful notarization and no
  performance blockers. The notarization step submits a temporary ZIP with `notarytool --wait`,
  requires an accepted result, then runs `spctl --assess`. The signed, notarized executable still
  ships as `.tar.gz`; only the Windows archive is a `.zip`;
- allows **prereleases** to carry ad-hoc or unsigned signing evidence, skipped notarization and
  performance blockers. Missing or invalid required evidence is still an error, and failed smoke
  checks are not exempted;
- attests the archives and creates the GitHub Release before attempting the optional npm channel.
  npm uses `--provenance --access public`, with `next` for prereleases and `latest` for stable tags.
  Missing `NPM_TOKEN` skips that channel; a rejected publish emits a warning annotation and leaves
  the GitHub Release intact;
- renders the Homebrew formula from the published checksums only for stable tags. The formula job
  depends on `publish` and is gated by `!contains(github.ref_name, '-')`; it updates the configured
  tap only when a tap credential exists.

Signing/notarization workflow code and gate tests do not establish that a notarized release has
passed Gatekeeper on a clean macOS machine. That native acceptance remains open; retain the
README/CHANGELOG quarantine workaround until it is demonstrated.

No tag has been pushed since the Linux and Windows legs were added, so `verify-linux` and
`verify-windows` are workflow wiring proven only by structural tests and by the unit gate run
locally against fixture archives (`bun run release:gate` with each leg's own environment shape);
neither has produced a real archive on a native `ubuntu-24.04(-arm)` or `windows-latest` runner.
The first real tag closes that gap automatically for whichever legs GitHub Actions can run at the
time.
The workflow's Gatekeeper check is designed around online ticket lookup for the bare executable;
it does not exercise offline installation or establish first-run acceptance for a future release.

Repository configuration used by the workflow:

| Secret / setting | Purpose |
| --- | --- |
| `MACOS_SIGNING_CERTIFICATE`, `MACOS_SIGNING_PASSWORD`, `MACOS_SIGNING_IDENTITY` | Developer ID signing required for stable releases |
| `MACOS_NOTARIZATION_APPLE_ID`, `MACOS_NOTARIZATION_PASSWORD`, `MACOS_NOTARIZATION_TEAM_ID` | Apple account, app-specific password and team used by `notarytool`; stable publication requires successful notarization |
| `NPM_TOKEN` | Optional npm publication credential; provenance uses the workflow's OIDC identity |
| `HOMEBREW_TAP_TOKEN` | Optional write access to the tap repository receiving `Formula/wtm.rb` |

These names describe the workflow contract, not a claim that the credentials or public channels
have been verified. The formula's digests come from the same workflow run's `SHA256SUMS` after
artifact publication; they are never guessed.

## Semantic versioning

Version separately in code/contracts:

- product/CLI SemVer;
- adapter protocol major/minor;
- JSON output `schemaVersion`;
- config `version`.

Breaking protocol/config changes require an explicit migration path.

## Contributor safety

CI should run tests with temporary repositories only. Integration tests must never modify a contributor's real global Git config, LaunchAgents or user WTM state. All such paths are injectable/test-scoped.

## Security reporting

`SECURITY.md` should describe private vulnerability reporting. Security-sensitive areas include:

- adapter trust;
- arbitrary task execution;
- path deletion/GC;
- process-group signaling;
- symlink traversal;
- repository-local configuration trust.
