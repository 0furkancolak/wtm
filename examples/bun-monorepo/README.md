# Bun Monorepo Example

Copy `wtm.toml` to the root of a Bun monorepo containing `apps/web`. The example assumes `bun run dev --port <port>` starts the web application and `bun test` runs the repository test suite.

```bash
cp examples/bun-monorepo/wtm.toml ./wtm.toml
wtm resolve dev
wtm start dev
```

WTM assigns a stable dynamic `web` port to each worktree and exposes it through `PORT` and the `dev` command argument.
