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
tests/
LICENSE
README.md
CONTRIBUTING.md
SECURITY.md
```

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
picocolors        lightweight TTY color
```

Test tooling:

```text
vitest
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

Primary V1:

1. Homebrew tap/formula for macOS.
2. npm global package for developers already running Node 24+.

Possible later artifact:

3. standalone Node SEA executable when the Node feature/distribution workflow is stable enough for the project's support expectations.

The daemon is installed separately through:

```bash
wtm daemon install
```

rather than automatically starting a hidden service during package installation.

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
