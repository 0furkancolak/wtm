# Bun Monorepo Example

Copy `wtm.toml` to the root of a Bun monorepo containing `apps/web`. The example assumes `bun run dev --port <port>` starts the web application and `bun test` runs the repository test suite.

```bash
cp examples/bun-monorepo/wtm.toml ./wtm.toml
wtm resolve dev
wtm start dev
```

The configuration retains a preferred `web` port declaration. Configure the application itself to consume that preference until WTM port allocation is available to runtime task resolution.
