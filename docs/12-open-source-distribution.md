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
| `.github/workflows/ci.yml` | macOS arm64, macOS x64, Linux x64, Windows x64 | Schedules lint, typecheck, tests, e2e, bundle/package verification and standalone smoke checks; publishes nothing |
| `.github/workflows/release.yml` | macOS arm64 and macOS x64 | Verifies the two Darwin artifacts and publishes them only for version tags |

A configured CI leg is not a claim that its latest run passed. Windows remains experimental, with
native failures tracked in the development notes. Linux arm64 has no native CI leg in this matrix.

The current tag workflow publishes `wtm-darwin-arm64.tar.gz`, `wtm-darwin-x64.tar.gz` and
`SHA256SUMS`. The verified published prerelease `v0.1.0-rc.1` has those macOS assets. There is no
published Linux or Windows archive in that verified release. Linux users can build from source;
Windows contributor builds must be assessed against the experimental backend's remaining gates.
Expanding publication requires a platform-specific artifact and signing/notarization policy;
the current combined release gate expects the two Darwin archives and matching signing evidence.

Local archive construction also supports Linux x64: after `bun run build:binary`, run
`bun run release:artifacts` to produce `dist/release/wtm-linux-x64.tar.gz` and `SHA256SUMS`.
The archive contains the executable, license, notice and third-party notices. Construction
checks a bounded ELF header, sets numeric archive ownership and writes checksums; executable smoke is a
separate check. Linux arm64 and Windows archive construction are not enabled. Local Linux
support does not change the two required published Darwin targets or their signing policy.

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

## Release operations

Ordinary CI publishes nothing. Publication runs only for `v*` tags, and every publishing job is
guarded by `startsWith(github.ref, 'refs/tags/v')`.

The tag workflow (`.github/workflows/release.yml`):

- builds and verifies the executable natively on macOS arm64 and macOS x64;
- measures performance inside each `verify` matrix job and records `PERFORMANCE.json` alongside
  signing, notarization and smoke evidence. There is no separate `Performance` workflow.
  `publish` depends on `verify` and runs the combined artifact gate again;
- requires the tag to match the `package.json` version exactly, including any prerelease suffix;
- checks executable smoke results, recomputes archive digests and requires exactly the two expected
  Darwin archives before publication;
- requires a **stable** release to have Developer ID signing, successful notarization and no
  performance blockers. The notarization step submits a temporary ZIP with `notarytool --wait`,
  requires an accepted result, then runs `spctl --assess`. Published archives remain `.tar.gz`;
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
