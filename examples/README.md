# WTM Examples

These are copyable `wtm.toml` configurations for existing projects, not application starters. Copy the file that fits your repository to its root, then adjust command names, service paths, and ports to match the project.

- [`minimal/wtm.toml`](minimal/wtm.toml) defines one foreground `npm test` task.
- [`bun-monorepo/wtm.toml`](bun-monorepo/wtm.toml) uses Bun, a worktree-local web app, preferred port declarations, and an exposed development task. Its `apps/web` directory must exist; configure the application itself to consume its preferred port until WTM port allocation is available to runtime task resolution.
- [`docker-compose/wtm.toml`](docker-compose/wtm.toml) supplies per-worktree Compose names and explicit `compose-up`/`compose-down` tasks. WTM does not start Docker during initialization.
- [`polyglot/wtm.toml`](polyglot/wtm.toml) uses top-level JavaScript, Python/uv, and Rust test tasks. Its services live in `services/web`, `services/api`, and `services/worker`.

Validate a copied configuration before starting a task:

```bash
wtm resolve dev
```

Use the task name provided by the selected example; for example, `wtm resolve python-test` for the polyglot configuration.
