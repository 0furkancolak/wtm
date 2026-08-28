# Worktree Runtime Manager (WTM)

WTM is a local-first macOS runtime and safety manager for Git worktrees. It discovers existing repositories and linked worktrees, resolves per-worktree tasks and environments, supervises processes, allocates endpoints, and refuses unsafe worktree or resource removal.

## Requirements

- Node.js 24 or newer for production use
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
