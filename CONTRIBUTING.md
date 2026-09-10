# Contributing

Use Node.js 24 and Bun 1.3 or newer; CI pins Bun 1.3.14. Building or verifying a standalone executable requires exactly Node.js 24.18.0. Keep changes focused, add a failing test before behavior changes, and place every `*.test.ts` and `*.scenario.ts` file under the owning source directory's `__tests__` directory. Relative TypeScript imports are extensionless.

| Native environment | Development prerequisites and evidence limits |
| --- | --- |
| macOS arm64 / x64 | Git on PATH; launchd in a login session for service lifecycle checks. Both architectures have CI jobs and published prerelease archives. |
| Linux x64 | Git on PATH; systemd 240+ and a reachable user manager for automatic daemon startup. CI exercises real Linux processes and IPC; the full systemd user-service lifecycle still needs a suitable session. |
| Windows x64, experimental | Native Node, Bun and Git on PATH; Windows PowerShell and Task Scheduler for the backend. CI has a Windows job, but its presence is not proof that every native gate passes. Git Bash commands and PowerShell syntax are distinct; POSIX Makefile installation recipes are not Windows installers. |

If the SQLite dependency has no prebuilt binding for your runtime, installation also needs Python and the platform's C++ build toolchain. Linux arm64 and musl builds are not covered by the current native CI matrix. See [SUPPORT.md](SUPPORT.md) for the support and distribution boundaries.

Before opening a pull request, run:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run test:e2e
bun run test:perf
bun run package:verify
bun run binary:verify
```

Run resource-heavy gates sequentially, including when multiple agents work in the repository. `binary:verify` builds and exercises a standalone executable using the pinned Node version. `make check` runs lint, typecheck, and the unit suites; `make verify` runs the whole gate. `make help` lists every target.

`make install` registers the WTM per-user service as a side effect of installing the executable — a LaunchAgent under launchd on macOS, a systemd user unit on Linux. Use `make install WITH_DAEMON=0` when you want a build on PATH without touching the service manager, and `make uninstall` (or `make purge`, which also deletes your WTM state) to undo it. `make purge` removes WTM state, logs and configuration using the macOS layout or the current Linux XDG state/config roots; use the same `HOME`, XDG settings and installation prefix as the installation.

Tests must use temporary repositories, local bare remotes, injectable state/socket paths, and isolated homes. Never mutate a contributor's real Git configuration, LaunchAgents, or WTM state. By contributing, you agree that your contribution is licensed under Apache-2.0.

Inject platform capabilities at the composition boundary. `@wtm/core` and `@wtm/protocol`, including their tests, must remain free of operating-system-specific imports, commands and literals. Fixture tests establish parsing and state transitions; native tests establish actual process, filesystem, transport and service behavior. Report each separately, and do not weaken a safety assertion to make a platform job green.
