# Standalone Distribution and Examples Design

## Status

Approved in chat on 2026-08-28 for implementation planning.

## Objective

Make WTM installable and usable by open-source users without requiring Node.js or Bun on their machines, while retaining a public npm package for Node.js users. Ship copyable project examples and consistently identify the project with `Powered by https://nafru.com` without corrupting machine-readable command output.

The first standalone release targets macOS arm64 and macOS x64. Linux and Windows executables, a universal macOS executable, Homebrew Core submission, Apple notarization, and automatic creation of external repositories are outside this increment.

## User Experience

### Homebrew

After the first successful binary release, WTM's repository acts as a custom tap and contains the release-generated `Formula/wtm.rb`. Until a separately named tap repository exists, users install it with an explicit repository URL:

```bash
brew tap 0furkancolak/wtm https://github.com/0furkancolak/wtm.git
brew install wtm
wtm --version
```

The formula selects the release archive for the host architecture, verifies its SHA-256 digest, installs one executable named `wtm`, and prints this caveat:

```text
WTM installed — Powered by https://nafru.com
Run `wtm init --yes` inside a workspace to get started.
```

Homebrew must not install or launch the daemon implicitly. The user opts in with `wtm daemon install`.

### Direct download

Each tagged release contains:

```text
wtm-darwin-arm64.tar.gz
wtm-darwin-x64.tar.gz
SHA256SUMS
```

Each archive contains exactly the `wtm` executable plus the release license and notice files. The executable does not require Node.js, Bun, npm, or a separately installed native SQLite library.

### npm

Node.js users can install the existing public package:

```bash
npm install --global worktree-runtime-manager
wtm --version
```

The npm package continues to require Node.js 24 or newer and uses the `bin` mapping already declared in `package.json`. Its install hook is a bounded, dependency-free script that only writes:

```text
WTM installed — Powered by https://nafru.com
```

Package installation must perform no network request, daemon installation, workspace scan, filesystem discovery, or user configuration mutation. Installation remains valid when lifecycle scripts are disabled; branding also appears in CLI help and version output.

Published package metadata declares only Node.js as a runtime engine. Bun remains the pinned development package manager and test runner, not a runtime prerequisite for npm consumers.

### CLI branding and versioning

`wtm --version` prints the SemVer version followed by the brand line. `wtm --help` includes the brand line as a footer. Operational human output remains unchanged. JSON output and raw streams never contain branding outside their defined payloads.

The package version is the sole version source. Both the Node bundle and standalone executable receive the same version at build time. A tag release is valid only when tag `vX.Y.Z` equals `package.json` version `X.Y.Z`.

## Architecture

### Distribution variants

One codebase produces two runtime variants:

1. The npm variant targets Node.js 24 and uses `better-sqlite3`.
2. The standalone variant is a Node.js 24 Single Executable Application (SEA) and uses the built-in `node:sqlite` module.

The SEA build bundles the application into one bootstrap script, generates a SEA preparation blob with the pinned Node.js 24 runtime, injects the blob into a copy of the matching Node executable, and signs the resulting Mach-O file. It is built independently on macOS arm64 and macOS x64 runners. A consumer downloads one architecture-specific executable. WTM does not merge them into a universal Mach-O file in this increment.

### SQLite boundary

The current state store directly imports `better-sqlite3`. It will be separated into:

- a small internal synchronous database contract covering only the operations WTM uses;
- a Node driver backed by `better-sqlite3`;
- a SEA driver backed by `node:sqlite`;
- runtime-specific entrypoints that select the driver explicitly.

State-store behavior, migrations, transactions, readonly behavior, pragma configuration, result shapes, and failure semantics must remain identical. The public `SQLiteStateStore` API remains source-compatible. Runtime selection must not depend on an unchecked environment variable or dynamically import a user-controlled module.

The npm build must not change its supported storage behavior. The standalone build must not contain or extract `better-sqlite3` or any `.node` addon. Build-time module aliasing or dependency injection may implement the selection, but the resulting artifacts are tested for those invariants. `node:sqlite` remains behind WTM's internal database contract so its release-candidate API does not become a public WTM API.

### Self-contained subprocess modes

The current managed-process ownership anchor and trusted external adapter runner launch a separate `node` executable. A standalone WTM installation cannot make that assumption. The SEA therefore exposes private internal modes that are selected before public CLI parsing:

- a process-anchor mode that runs the existing ownership and handshake protocol;
- an adapter-runner mode that installs the existing module dependency guard, consumes the verified private descriptor, and runs the adapter protocol.

Production standalone code spawns `process.execPath` with one of these internal modes. The modes are not listed as public commands, reject malformed arguments and missing descriptors, preserve bounded I/O and timeout cleanup, and do not weaken adapter byte binding or dependency restrictions. npm execution continues to use the installed Node runtime but shares the same internal runner implementation so security behavior cannot drift between channels.

LaunchAgent program arguments are runtime-aware. The npm form invokes the Node executable plus the installed CLI entry file; the SEA form invokes the `wtm` executable directly followed by `daemon serve`. Tests assert that neither SEA daemon startup nor managed task startup resolves a `node` or `bun` command from `PATH`.

### Embedded assets

Standalone execution cannot rely on source-tree-relative paths. The following canonical bytes are embedded as SEA assets at build time and read through `node:sea` only when `isSea()` is true:

- every ordered SQL migration;
- `skills/wtm/SKILL.md`.

The Node/npm build keeps its packaged file layout, but both variants consume the same asset-provider interface. Tests compare embedded bytes to canonical repository files exactly. No generated copy becomes a second editable source of truth. Missing, duplicated, or byte-mismatched SEA assets fail the build.

### Build and packaging scripts

Repository scripts provide these deterministic operations:

```text
bun run build             Node/npm distributable
bun run build:binary      current-host Node SEA executable for local verification
bun run release:artifacts both macOS archives and SHA256SUMS
bun run package:verify    npm package-content verification
bun run binary:verify     standalone smoke and content verification
```

Build output lives under ignored `dist/` and `artifacts/` paths. The build pins the exact Node.js 24 patch release and SEA injector version. Archive names, executable mode, archive members, version, and checksum formatting are deterministic apart from platform runtime bytes and code signatures. Release scripts fail on a version mismatch, unsupported target, missing output, wrong executable mode, failed SEA injection, invalid signature, or failed smoke test.

## Release Automation

A tag workflow triggered by `v*` performs these gates before publication:

1. Check that the tag exactly matches `package.json`.
2. Install the pinned Bun development toolchain and the exact Node.js 24 SEA runtime from verified upstream artifacts.
3. Run lint, typecheck, unit, integration, E2E, performance, npm package, and standalone binary verification.
4. Build arm64 and x64 artifacts on native compatible macOS runners so each platform executable is launched and exercised, not cross-built and assumed valid.
5. Apply macOS code signing when signing secrets are configured. Release publication fails closed if the workflow is configured as an official signed release but required signing material is absent. Ad-hoc artifacts are permitted only for explicitly marked prereleases.
6. Generate `SHA256SUMS` and GitHub artifact attestations.
7. Publish GitHub Release assets.
8. Publish the npm package through npm trusted publishing/provenance after all artifact gates pass.
9. Render the versioned Homebrew formula from the released URLs and checksums and update `Formula/wtm.rb` in one automated release commit.

The workflow uses least-privilege permissions. Pull requests and ordinary branch pushes never publish. Fork-originated workflows receive no publishing secrets. A failed channel does not silently report a successful release.

The implementation prepares and tests this automation but does not create a tag, publish npm, create an external Homebrew repository, or require secrets during normal CI.

## Homebrew Formula

`Formula/wtm.rb` is generated from a reviewed template only after both release archives exist and their final checksums are known. Before the first successful release the repository contains the template and renderer, not a formula with guessed or unusable checksums. The generated formula contains architecture-specific stable URLs and checksums, declares the Apache-2.0 license, and installs the executable directly. It does not run npm, compile source, install Node, modify LaunchAgents, or write WTM user state.

Its test creates an isolated temporary Git repository and runs non-mutating CLI checks such as `wtm --version` and `wtm --help`. Formula validation includes Ruby syntax, expected URLs/checksums, and `brew audit`/installation checks when Homebrew is available in release CI.

## Examples

The npm package and repository contain:

```text
examples/
  README.md
  minimal/
    wtm.toml
  bun-monorepo/
    README.md
    wtm.toml
  docker-compose/
    README.md
    wtm.toml
  polyglot/
    README.md
    wtm.toml
```

Examples are configuration examples, not generated application skeletons. They must use only configuration fields and CLI behavior implemented by the current release. Each README names its assumptions and shows how to copy the configuration into an existing project.

- `minimal` demonstrates workspace identity and one foreground task.
- `bun-monorepo` demonstrates worktree-local commands, stable ports, environment templates, and exposed tasks.
- `docker-compose` demonstrates per-worktree Compose project names, endpoints, and explicit up/down tasks without WTM starting Docker during initialization.
- `polyglot` demonstrates top-level JavaScript, Python/uv, and Rust tasks with explicit service working directories and capability selection supported by the V1 schema.

Automated tests parse every example through the production configuration parser and assert important resolved behavior. Every test and scenario file remains under the owning module's `__tests__/` directory.

## Documentation

The root README becomes an answer-first installation and quick-start page containing:

- Homebrew as the recommended macOS installation;
- direct release download and checksum verification;
- npm installation for Node.js 24 users;
- source development setup with Bun;
- `wtm init --yes`, optional daemon installation, status, resolve, start, logs, stop, analyze, and guarded remove examples;
- a link to `examples/` and the complete CLI documentation;
- the distinction between installing WTM and opting into its daemon;
- `Powered by https://nafru.com`.

Documentation must not claim that artifacts are already publicly released until an actual matching release exists. Commands that require a future published version are labeled as release-channel instructions rather than evidence that publication has happened.

## Error Handling and Safety

- A standalone build fails if canonical assets cannot be embedded exactly.
- A binary refuses to report a version inconsistent with its build metadata.
- Release automation never guesses checksums or rewrites a formula before uploaded assets are verified.
- Package installation does not execute WTM commands or mutate user state.
- Homebrew installation does not install the daemon.
- Binary and npm variants use the existing private runtime directories and safety checks.
- Existing adapter trust and external adapter byte-binding guarantees remain unchanged in both variants.
- Machine-readable JSON remains a single valid JSON document with no banner or install text mixed into stdout.

## Testing Strategy

Implementation follows test-driven development. New behavior is introduced by a failing test first, followed by the smallest production change.

Required automated coverage includes:

- CLI help/version branding and exact version propagation;
- JSON output free of branding noise;
- npm lifecycle script side-effect boundaries;
- exact embedded migration and skill bytes;
- shared state-store contract tests against the npm `better-sqlite3` driver and SEA `node:sqlite` driver;
- standalone executable launch, database migration, init, status, resolve, analyze, isolated daemon foreground startup, managed task start/stop, and trusted adapter execution;
- internal runner rejection of direct malformed invocation, missing descriptors, excess output, timeout, and disallowed adapter dependencies;
- correct npm and SEA LaunchAgent program arguments;
- absence of runtime dependency on external Node or Bun command-line binaries, repository-relative assets, and `better-sqlite3` native addons;
- archive layout, executable mode, checksums, architecture labels, and formula rendering;
- release tag/version mismatch rejection;
- production parsing and resolution of every example;
- npm dry-run contents including `examples/`;
- existing lint rule requiring extensionless TypeScript imports;
- existing test-placement rule requiring test artifacts under `__tests__/`.

No test may modify real LaunchAgents, global Git configuration, user WTM state, npm registry state, GitHub releases, or Homebrew installations. External publication steps are validated through local fixtures and dry runs unless running in the explicitly authorized tag-release job.

## Acceptance Criteria

The increment is complete when:

1. A fresh macOS arm64 or x64 machine can download its release archive, extract one `wtm` executable, and use WTM without Node.js or Bun installed or discoverable on `PATH`.
2. The executable can initialize and inspect an isolated sample workspace using persistent SQLite state and embedded migrations, install and serve its daemon, manage a task process, and invoke a trusted adapter through the same executable.
3. Homebrew formula generation selects the correct binary and checksum for both macOS architectures.
4. The npm package remains installable on Node.js 24 and contains the examples.
5. Help, version, npm install output, and Homebrew caveats contain `Powered by https://nafru.com`, while JSON and raw stream output remain unmodified.
6. Every example parses and resolves through production WTM code.
7. Release artifacts pass smoke tests, checksums, and provenance generation before publication is allowed.
8. All existing tests, lint, typecheck, E2E, performance, build, and package verification gates pass.
