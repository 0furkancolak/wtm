# Contributing

Use Node.js 24 and Bun 1.3 or newer. Keep changes focused, add a failing test before behavior changes, and place every `*.test.ts` and `*.scenario.ts` file under the owning source directory's `__tests__` directory. Relative TypeScript imports are extensionless.

Before opening a pull request, run:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run test:e2e
bun run test:perf
bun run package:verify
```

`make check` runs lint, typecheck, and the unit suites; `make verify` runs the whole gate. `make help` lists every target.

`make install` registers the WTM LaunchAgent as a side effect of installing the executable. Use `make install WITH_DAEMON=0` when you want a build on PATH without touching launchd, and `make uninstall` (or `make purge`, which also deletes your WTM state) to undo it.

Tests must use temporary repositories, local bare remotes, injectable state/socket paths, and isolated homes. Never mutate a contributor's real Git configuration, LaunchAgents, or WTM state. By contributing, you agree that your contribution is licensed under Apache-2.0.
