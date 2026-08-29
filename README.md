# Worktree Runtime Manager (WTM)

WTM is a local-first macOS runtime and safety manager for Git worktrees. It discovers existing repositories and linked worktrees, resolves per-worktree tasks and environments, supervises processes, allocates endpoints, and refuses unsafe worktree or resource removal.

Powered by [nafru.com](https://nafru.com).

## Install

The commands below describe the release channels that will be available after a matching WTM release is published; this repository does not yet have a published release artifact or tag.

### Homebrew (macOS release channel)

After a release publishes the formula, install WTM from its custom tap:

```bash
brew tap 0furkancolak/wtm
brew install 0furkancolak/wtm/wtm
wtm --version
```

### Direct macOS binary (release channel)

After a release publishes its archives, select the archive matching the current macOS architecture, verify it against `SHA256SUMS`, then extract it:

```bash
case "$(uname -m)" in
  arm64) archive=wtm-darwin-arm64.tar.gz ;;
  x86_64) archive=wtm-darwin-x64.tar.gz ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac
curl -LO "https://github.com/0furkancolak/wtm/releases/download/v<VERSION>/$archive"
curl -LO https://github.com/0furkancolak/wtm/releases/download/v<VERSION>/SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
tar -xzf "$archive"
```

Replace `<VERSION>` with the published release version.

### npm (Node.js 24+)

After a release publishes the package, install WTM globally:

```bash
npm install --global worktree-runtime-manager
wtm --version
```

### Source (development)

Requires Bun 1.3+ and Node.js 24+:

```bash
bun install --frozen-lockfile
bun run build
node dist/cli/bin.js --version
```

## Quick start

Inside an existing Git workspace, initialize WTM, then copy or write a `wtm.toml` that defines the `dev` task before resolving it. The following uses the Bun monorepo example and assumes the project has `apps/web`:

```bash
wtm init --yes
cp /path/to/wtm/examples/bun-monorepo/wtm.toml ./wtm.toml
wtm daemon install
wtm status
wtm resolve dev
wtm start dev
wtm logs dev --follow
wtm stop dev
wtm analyze --all
```

`wtm daemon install` is optional; installation never starts it automatically. Start with a configuration from the [examples](examples/README.md), then use the complete [documentation](docs/README.md) for configuration, safety, and CLI details.

## Requirements

- Node.js 24 or newer for npm installation
- macOS for the LaunchAgent-managed daemon
- Bun 1.3 or newer for development and tests

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run test:e2e
bun run test:perf
```

Build the distributable package with `bun run build`; verify its public contents with `bun run package:verify`.

WTM has no required account, cloud control plane, default telemetry, or implicit fetch/push behavior. See [the documentation](docs/README.md), [security policy](SECURITY.md), and bundled [WTM Agent Skill](skills/wtm/SKILL.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
