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

V1 ships two channels from one codebase:

1. **Standalone macOS executable.** A Node SEA build that embeds the pinned Node 24 runtime, the SQL
   migrations and the agent skill. It stores state through `node:sqlite`, so it contains no native
   addon and needs no Node, Bun or compiler on the target machine. Built by `bun run build:binary`
   and proven by `bun run binary:verify`.
2. **npm global package** for developers already running Node 24+. This channel keeps
   `better-sqlite3` and the ordinary Node module resolution.

Both channels run the same CLI. The only difference is how a WTM child process is launched: the npm
build re-invokes `node <cli>`, the standalone build re-invokes its own executable.

A Homebrew formula is prepared in `packaging/homebrew/wtm.rb.template` and rendered by
`bun run formula:render`. **No public tap repository exists yet.** Until one is published, install
from a custom tap or directly from a downloaded archive.

The daemon is installed separately through:

```bash
wtm daemon install
```

rather than automatically starting a hidden service during package installation.

## Release operations

Nothing is published by ordinary CI. Publication happens only when a `v*` tag is pushed, and every
publishing job is guarded by `startsWith(github.ref, 'refs/tags/v')`.

The tag workflow (`.github/workflows/release.yml`):

- builds and fully verifies the executable natively on macOS arm64 and macOS x64;
- requires the tag to equal the `package.json` version exactly — `v1.2.3` for `1.2.3`, and a
  prerelease tag only for the identical prerelease version;
- recomputes every archive digest and requires exactly the two expected archives before it
  publishes anything;
- refuses to publish a **stable** release whose executable is not Developer ID signed. Prereleases
  may ship ad-hoc signed;
- attests the artifacts, uploads them to the GitHub Release, publishes to npm with provenance, and
  only then renders and commits the Homebrew formula from the final checksums. The formula job runs
  for stable tags only — it is gated by `!contains(github.ref_name, '-')`, so a prerelease never
  becomes the default `brew install` formula.

Required repository configuration before the first real release:

| Secret / setting | Purpose |
| --- | --- |
| `MACOS_SIGNING_CERTIFICATE`, `MACOS_SIGNING_PASSWORD`, `MACOS_SIGNING_IDENTITY` | Developer ID signing for stable releases |
| npm trusted publisher for `worktree-runtime-manager` | provenance-backed `npm publish` without a long-lived token |
| `HOMEBREW_TAP_TOKEN` | write access to the tap repository that receives `Formula/wtm.rb` |

The formula is never committed with guessed digests: it is rendered from the `SHA256SUMS` produced
by the same workflow run, after the assets are uploaded.

Custom tap installation, once a tap exists:

```bash
brew tap 0furkancolak/wtm
brew install 0furkancolak/wtm/wtm
```

`brew tap 0furkancolak/wtm` resolves to `github.com/0furkancolak/homebrew-wtm`, which is the
repository the release workflow writes `Formula/wtm.rb` into.

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
